import { createId } from '@paralleldrive/cuid2';
import { eq, and, isNull, gte, lt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { Resend } from 'resend';
import { db } from '../../db/index';
import { users, sessions } from '../auth/auth.schema';
import { emailVerifications, passwordResets, emailQueue, NewEmailQueue } from './email.schema';
import { renderVerificationEmail, renderWelcomeEmail, renderPasswordResetEmail } from './email.templates';
import { hashEmailToken, hashPassword } from '../../utils/crypto';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { env } from '../../config/env';
import { features } from '../../config/features';
import { passwordSchema } from '../auth/auth.zod';

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
}

async function getDailySentCount(): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(emailQueue)
    .where(
      and(
        eq(emailQueue.status, 'sent'),
        gte(emailQueue.sentAt, today)
      )
    );

  return result[0]?.count ?? 0;
}

async function enqueueEmail(to: string, subject: string, html: string): Promise<void> {
  const count = await getDailySentCount();

  if (count >= env.EMAIL_DAILY_LIMIT) {
    console.warn(`Daily email limit reached (${env.EMAIL_DAILY_LIMIT}). Email to ${to} not queued.`);
    throw new ValidationError('Daily email limit reached. Please try again tomorrow.');
  }

  const newEmail: NewEmailQueue = {
    id: createId(),
    to,
    subject,
    html,
    status: 'pending',
    attempts: 0,
    lastError: null,
    scheduledAt: new Date(),
    sentAt: null,
    createdAt: new Date(),
  };

  await db.insert(emailQueue).values(newEmail);
}

async function sendVerificationEmail(
  userId: string,
  email: string,
  username: string
): Promise<void> {
  if (!features.email) {
    console.warn(`[email] Feature disabled — skipping verification email to ${email}`);
    return;
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + env.EMAIL_VERIFY_EXPIRES_IN_HOURS * 60 * 60 * 1000);

  await db
    .insert(emailVerifications)
    .values({
      id: createId(),
      userId,
      token: hashEmailToken(token),
      expiresAt,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: emailVerifications.userId,
      set: {
        token: hashEmailToken(token),
        expiresAt,
        createdAt: new Date(),
      },
    });

  const verifyUrl = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  const html = await renderVerificationEmail({
    username,
    verifyUrl,
    expiresInHours: env.EMAIL_VERIFY_EXPIRES_IN_HOURS,
  });

  await enqueueEmail(email, 'Verify your blklight account', html);
}

async function verifyEmail(token: string): Promise<void> {
  const [verification] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.token, hashEmailToken(token)))
    .limit(1);

  if (!verification) {
    throw new NotFoundError('Invalid verification token');
  }

  if (verification.expiresAt < new Date()) {
    throw new ValidationError('Verification link has expired. Please request a new one.');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, verification.userId));

    await tx
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, verification.id));
  });

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, verification.userId))
    .limit(1);

  if (user) {
    sendWelcomeEmail(user.email, user.username).catch((err) =>
      console.error('Welcome email enqueue failed:', err)
    );
  }
}

async function sendWelcomeEmail(email: string, username: string): Promise<void> {
  if (!features.email) {
    console.warn(`[email] Feature disabled — skipping welcome email to ${email}`);
    return;
  }

  const profileUrl = `${env.FRONTEND_URL}/@${username}`;
  const html = await renderWelcomeEmail({ username, profileUrl });

  await enqueueEmail(email, `Welcome to blklight, ${username}!`, html);
}

async function sendPasswordResetEmail(email: string): Promise<void> {
  if (!features.email) {
    console.warn(`[email] Feature disabled — skipping password reset email to ${email}`);
    return;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user) {
    return;
  }

  if (!user.passwordHash) {
    console.log('Password reset requested for OAuth-only account:', email);
    return;
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_EXPIRES_IN_MINUTES * 60 * 1000);

  await db.insert(passwordResets).values({
    id: createId(),
    userId: user.id,
    token: hashEmailToken(token),
    expiresAt,
    usedAt: null,
    createdAt: new Date(),
  });

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  const html = await renderPasswordResetEmail({
    username: user.username,
    resetUrl,
    expiresInMinutes: env.PASSWORD_RESET_EXPIRES_IN_MINUTES,
  });

  await enqueueEmail(email, 'Reset your blklight password', html);
}

async function resetPassword(token: string, newPassword: string): Promise<void> {
  const [reset] = await db
    .select()
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.token, hashEmailToken(token)),
        isNull(passwordResets.usedAt)
      )
    )
    .limit(1);

  if (!reset) {
    throw new NotFoundError('Invalid reset token');
  }

  if (reset.expiresAt < new Date()) {
    throw new ValidationError('Reset link has expired. Please request a new one.');
  }

  const policy = passwordSchema.max(128).safeParse(newPassword);
  if (!policy.success) {
    throw new ValidationError(policy.error.issues[0]?.message ?? 'Invalid password');
  }

  const { hash, salt } = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    // Claim the token inside the transaction: of two concurrent resets with the
    // same link, only the one that flips usedAt from null proceeds.
    const claimed = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, reset.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });

    if (claimed.length === 0) {
      throw new NotFoundError('Invalid reset token');
    }

    await tx
      .update(users)
      .set({ passwordHash: hash, salt, updatedAt: new Date() })
      .where(eq(users.id, reset.userId));

    await tx
      .delete(sessions)
      .where(eq(sessions.userId, reset.userId));
  });
}

async function processEmailBatch(): Promise<void> {
  const remaining = env.EMAIL_DAILY_LIMIT - await getDailySentCount();

  if (remaining <= 0) {
    console.warn('Email queue: daily limit reached, skipping batch');
    return;
  }

  const pendingEmails = await db
    .select()
    .from(emailQueue)
    .where(eq(emailQueue.status, 'pending'))
    .orderBy(emailQueue.scheduledAt)
    .limit(remaining);

  let sent = 0;
  let failed = 0;

  for (const email of pendingEmails) {
    try {
      await getResend().emails.send({
        from: env.EMAIL_FROM,
        to: email.to,
        subject: email.subject,
        html: email.html,
      });

      await db
        .update(emailQueue)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(emailQueue.id, email.id));

      sent++;
    } catch (err) {
      const error = err as Error;
      const attempts = (email.attempts ?? 0) + 1;

      if (attempts >= 3) {
        await db
          .update(emailQueue)
          .set({ status: 'failed', attempts, lastError: error.message })
          .where(eq(emailQueue.id, email.id));
        failed++;
      } else {
        await db
          .update(emailQueue)
          .set({ attempts, lastError: error.message })
          .where(eq(emailQueue.id, email.id));
      }
    }
  }

  console.log(`Email batch processed: ${sent} sent, ${failed} failed`);
}

function startEmailQueue(): void {
  if (!features.emailQueue) {
    console.log('[email] Email queue is disabled — skipping');
    return;
  }

  processEmailBatch().catch((err) => console.error('Email queue batch failed:', err));

  setInterval(() => {
    processEmailBatch().catch((err) => console.error('Email queue batch failed:', err));
  }, 10 * 60 * 1000);

  console.log('Email queue started — processing every 10 minutes');
}

export {
  getDailySentCount,
  enqueueEmail,
  sendVerificationEmail,
  verifyEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  resetPassword,
  processEmailBatch,
  startEmailQueue,
};
