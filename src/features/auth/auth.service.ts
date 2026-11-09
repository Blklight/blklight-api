import { createId } from '@paralleldrive/cuid2';
import { eq, and, lt, isNull, gt, or, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { users, sessions, NewUser, NewSession, User } from './auth.schema';
import { profiles } from '../profiles/profiles.schema';
import { signatures } from '../signatures/signatures.schema';
import { workspaces } from '../workspace/workspace.schema';
import { canvas } from '../canvas/canvas.schema';
import { getUserApps } from '../platform-apps/platform-apps.service';
import { hashPassword, verifyPassword, generateSecret, generateUserHash, encryptSecret, hashRefreshToken } from '../../utils/crypto';
import { ConflictError, UnauthorizedError, NotFoundError, ValidationError } from '../../utils/errors';
import { env } from '../../config/env';
import {
  REFRESH_COOKIE_NAME,
  buildSessionRefreshCookieOptions,
  getRefreshTtlSeconds,
} from '../../config/cookies';
import { sendVerificationEmail } from '../email/email.service';
import { features } from '../../config/features';
import { matchUsername, normalizeUsername } from '../../utils/username';
import type { FastifyReply } from 'fastify';
import type { AuthSession } from './auth.zod';

export interface RegisterUserResult {
  user: User;
  refreshToken: string;
}

export interface CreateUserResult {
  user: User;
}

export interface LoginUserResult {
  userId: string;
  refreshToken: string;
  role: string;
  email: string;
}

export async function buildAuthSession(
  userId: string,
  accessToken: string
): Promise<AuthSession> {
  const [userRow, profileRow] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({
        id: profiles.id,
        userId: profiles.userId,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
        isPrivate: profiles.isPrivate,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1),
  ]);

  const user = userRow[0];
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const profile = profileRow[0];
  const profileId = profile?.id;

  const userApps = profileId ? await getUserApps(profileId) : [];

  return {
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role as 'user' | 'admin',
      emailVerified: user.emailVerified,
      onboardingComplete: user.onboardingComplete,
      createdAt: user.createdAt.toISOString(),
    },
    profile: {
      id: profile?.id ?? '',
      userId: profile?.userId ?? '',
      username: profile?.username ?? '',
      displayName: profile?.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      isPrivate: profile?.isPrivate ?? false,
    },
    apps: userApps.map(a => a.slug),
  };
}

export function getOnboardingStep(user: {
  username: string | null;
  onboardingComplete: boolean;
  passwordHash: string | null;
}): 'username' | 'apps' | 'complete' {
  if (user.onboardingComplete) {
    return 'complete';
  }
  if (user.passwordHash === null && isOAuthPlaceholderUsername(user.username)) {
    return 'username';
  }
  return 'apps';
}

/**
 * Detect the temporary username assigned by handleOAuthLogin
 * (`github_<id>` / `google_<id>`) to distinguish "needs a username"
 * from "picked a username, still onboarding".
 */
function isOAuthPlaceholderUsername(username: string | null): boolean {
  return !!username && /^(github|google)_[0-9]+$/.test(username);
}

export async function registerUser(
  email: string,
  username: string,
  password: string
): Promise<RegisterUserResult> {
  const { user } = await createUser(email, username, password);
  const refreshToken = await createSession(user.id);
  return { user, refreshToken };
}

/**
 * Set the username for an OAuth account during onboarding.
 * Only callable while the account still has no password (OAuth placeholder).
 * @param userId - The user's ID
 * @param username - The chosen username
 * @throws NotFoundError if the user does not exist
 * @throws ValidationError if the account is complete or already has a password
 * @throws ConflictError if the username is already taken
 */
export async function setOnboardingUsername(userId: string, username: string): Promise<void> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (user.onboardingComplete) {
    throw new ValidationError('Onboarding already complete');
  }

  if (user.passwordHash !== null) {
    throw new ValidationError('Username already set');
  }

  const trimmedUsername = normalizeUsername(username);

  if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
    throw new ValidationError('Username must be 3-30 characters');
  }

  if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
    throw new ValidationError('Username can only contain letters, numbers, and underscores');
  }

  const existingUsername = await db
    .select()
    .from(users)
    .where(
      and(
        matchUsername(users.username, trimmedUsername),
        ne(users.id, userId),
        or(
          isNull(users.deletedAt),
          gt(users.deletedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        )
      )
    )
    .limit(1);

  if (existingUsername.length > 0) {
    throw new ConflictError('Username already taken');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ username: trimmedUsername, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await tx
      .update(profiles)
      .set({ username: trimmedUsername, updatedAt: new Date() })
      .where(eq(profiles.userId, userId));
  });
}

/**
 * Create the remaining onboarding records for an account.
 * Email accounts already have profile, signature, workspace, and canvas from
 * createUser — this is a no-op for them. OAuth accounts get all four created
 * atomically using the username chosen via setOnboardingUsername.
 * @param userId - The user's ID
 * @returns The user row
 * @throws NotFoundError if the user does not exist
 * @throws ValidationError if the username is still an OAuth placeholder
 */
export async function completeOnboarding(userId: string): Promise<User> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (isOAuthPlaceholderUsername(user.username)) {
    throw new ValidationError('Set a username before completing onboarding');
  }

  const existingProfile = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (existingProfile.length > 0) {
    await db.update(users).set({ onboardingComplete: true, updatedAt: new Date() }).where(eq(users.id, userId));
    return { ...user, onboardingComplete: true };
  }

  const now = new Date();
  const secret = generateSecret();
  const userHash = generateUserHash(user.id, user.email, user.createdAt, secret);
  const secretEncrypted = encryptSecret(secret);

  await db.transaction(async (tx) => {
    await tx.insert(profiles).values({
      id: createId(),
      userId,
      username: user.username,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(signatures).values({
      id: createId(),
      userId,
      userHash,
      secretEncrypted,
      createdAt: now,
    });

    await tx.insert(workspaces).values({
      id: createId(),
      ownerId: userId,
      type: 'personal',
      name: `${user.username}'s workspace`,
      isPersonal: true,
      colorLabels: null,
      createdAt: now,
      updatedAt: now,
    });

    const [newWorkspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .limit(1);

    if (!newWorkspace) {
      throw new Error('Failed to create workspace');
    }

    await tx.insert(canvas).values({
      id: createId(),
      workspaceId: newWorkspace.id,
      createdAt: now,
      updatedAt: now,
    });

    await tx.update(users).set({ onboardingComplete: true, updatedAt: now }).where(eq(users.id, userId));
  });

  if (features.email) {
    sendVerificationEmail(userId, user.email, user.username).catch((err) =>
      console.error('Verification email enqueue failed:', err)
    );
  }

  return user;
}

/**
 * Start a new session family for a login, register, OAuth callback or
 * onboarding completion.
 *
 * The session limit counts FAMILIES, not rows: a rotation chain produces many
 * rows but is one browser session, so it must not evict other devices. When the
 * limit is reached the oldest family is evicted entirely.
 * @param userId - The user to create the session for
 * @param rememberMe - Whether the family uses the longer refresh TTL
 * @returns The plaintext refresh token to hand to the client cookie
 */
async function createSession(userId: string, rememberMe?: boolean): Promise<string> {
  const now = new Date();

  await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        lt(sessions.expiresAt, now)
      )
    );

  // One row per family: a rotation chain can hold several tokens but is a
  // single browser session, so only the family start date is compared.
  const activeFamilies = await db
    .select({ familyId: sessions.familyId, oldestTokenAt: sql<Date>`min(${sessions.createdAt})` })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .groupBy(sessions.familyId)
    .orderBy(sql`min(${sessions.createdAt})`);

  if (activeFamilies.length >= env.MAX_SESSIONS_PER_USER) {
    const oldest = activeFamilies[0];
    if (oldest) {
      await db.delete(sessions).where(eq(sessions.familyId, oldest.familyId));
    }
  }

  const refreshToken = createId() + createId();
  const familyId = createId();
  const expiresAt = new Date(now.getTime() + getRefreshTtlSeconds(rememberMe) * 1000);

  const newSession: NewSession = {
    id: createId(),
    userId,
    // Store only the digest; the caller gets the plaintext for the cookie.
    refreshToken: hashRefreshToken(refreshToken),
    familyId,
    rotatedAt: null,
    rememberMe: rememberMe ?? false,
    expiresAt,
    createdAt: now,
  };

  await db.insert(sessions).values(newSession);

  return refreshToken;
}

/**
 * Create a session and write the refresh cookie on the reply.
 * Shared by login, register, the OAuth callback and onboarding so every path
 * emits identical cookie attributes.
 * @param userId - The user to create a session for
 * @param reply - Fastify reply that will carry the Set-Cookie header
 * @param rememberMe - Whether to extend the refresh token TTL
 */
export async function createSessionWithReply(userId: string, reply: FastifyReply, rememberMe?: boolean): Promise<void> {
  const refreshToken = await createSession(userId, rememberMe);

  reply.setCookie(
    REFRESH_COOKIE_NAME,
    refreshToken,
    buildSessionRefreshCookieOptions(rememberMe)
  );
}

export async function createUser(
  email: string,
  username: string,
  password: string
): Promise<CreateUserResult> {
  // The reserved list is enforced by the Zod schema at the route boundary,
  // never here: the legacy seed and the dev scripts create the "admin"
  // account through this function.
  const normalizedUsername = normalizeUsername(username);

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    throw new ConflictError('Email already in use');
  }

  const existingUsername = await db
    .select()
    .from(users)
    .where(
      and(
        matchUsername(users.username, normalizedUsername),
        or(
          isNull(users.deletedAt),
          gt(users.deletedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        )
      )
    )
    .limit(1);

  if (existingUsername.length > 0) {
    throw new ConflictError('Username already taken');
  }

  const { hash, salt } = hashPassword(password);
  const userId = createId();
  const now = new Date();

  await db.transaction(async (tx) => {
    const newUser: NewUser = {
      id: userId,
      email,
      username: normalizedUsername,
      passwordHash: hash,
      salt,
      emailVerified: false,
      role: 'user',
      onboardingComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(users).values(newUser);

    await tx.insert(profiles).values({
      id: createId(),
      userId,
      username: normalizedUsername,
      createdAt: now,
      updatedAt: now,
    });

    const secret = generateSecret();
    const userHash = generateUserHash(userId, email, now, secret);
    const secretEncrypted = encryptSecret(secret);

    await tx.insert(signatures).values({
      id: createId(),
      userId,
      userHash,
      secretEncrypted,
      createdAt: now,
    });

    await tx.insert(workspaces).values({
      id: createId(),
      ownerId: userId,
      type: 'personal',
      name: `${normalizedUsername}'s workspace`,
      isPersonal: true,
      colorLabels: null,
      createdAt: now,
      updatedAt: now,
    });

    const [newWorkspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .limit(1);

    await tx.insert(canvas).values({
      id: createId(),
      workspaceId: newWorkspace!.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  const createdUser = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (features.email) {
    sendVerificationEmail(createdUser[0]!.id, email, normalizedUsername).catch((err) =>
      console.error('Verification email enqueue failed:', err)
    );
  }

  return { user: createdUser[0]! };
}

/**
 * Authenticate a user with email or username.
 * @param identifier - Email address or username
 * @param password - Account password
 * @param rememberMe - Whether to extend refresh token TTL
 * @returns User ID, refresh token, role, and email
 * @throws UnauthorizedError if credentials are invalid
 */
export async function loginUser(
  identifier: string,
  password: string,
  rememberMe?: boolean
): Promise<LoginUserResult> {
  const isEmail = identifier.includes('@');
  const normalizedIdentifier = isEmail ? identifier.toLowerCase().trim() : normalizeUsername(identifier);

  const condition = isEmail
    ? eq(users.email, normalizedIdentifier)
    : matchUsername(users.username, normalizedIdentifier);

  const userRows = await db
    .select()
    .from(users)
    .where(condition)
    .limit(1);

  if (userRows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = userRows[0]!;

  if (user.deletedAt !== null) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (!user.passwordHash || !user.salt) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const isValid = verifyPassword(password, user.passwordHash, user.salt);
  if (!isValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const refreshToken = await createSession(user.id, rememberMe);

  return { userId: user.id, refreshToken, role: user.role, email: user.email };
}

export interface RefreshSessionResult {
  user: User;
  /** Present only when a rotation happened, i.e. when a new token was issued. */
  rotatedToken: string | null;
  /** TTL the family was created with, so the caller can refresh the cookie Max-Age. */
  rememberMe: boolean;
}

/**
 * Exchange a refresh token for a fresh access token, rotating the token.
 *
 * Rotation gives theft detection its teeth: the presented token is marked
 * consumed and a new one is issued in the same family. If a consumed token
 * shows up again after the grace window, that token was captured, and the
 * whole family is destroyed rather than handed another access token.
 *
 * Within the grace window a replayed token still succeeds without rotating
 * again, because a browser legitimately fires several requests in parallel on
 * the same cookie and only the last Set-Cookie wins. That case returns
 * rotatedToken = null so the caller does not overwrite the newer cookie.
 *
 * The row read is locked FOR UPDATE so parallel refreshes serialize instead of
 * both observing rotated_at = NULL and each rotating.
 * @param refreshToken - The plaintext token from the cookie
 * @returns The user plus the new token when a rotation occurred
 * @throws UnauthorizedError when the token is unknown, expired or reused late
 */
export async function refreshSession(refreshToken: string): Promise<RefreshSessionResult> {
  /**
   * Outcome of the locked read, resolved before anything destructive runs.
   * The revocations happen outside the transaction on purpose: throwing inside
   * it would roll the DELETE back and leave the family usable, which is the
   * exact opposite of what reuse detection must do.
   */
  type Outcome =
    | { kind: 'reject' }
    | { kind: 'revokeSession'; sessionId: string }
    | { kind: 'revokeFamily'; familyId: string }
    | { kind: 'replay'; userId: string; rememberMe: boolean }
    | { kind: 'rotate'; userId: string; rememberMe: boolean; rotatedToken: string };

  const outcome = await db.transaction<Outcome>(async (tx) => {
    const sessionRows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshToken, hashRefreshToken(refreshToken)))
      .limit(1)
      .for('update');

    if (sessionRows.length === 0) {
      return { kind: 'reject' };
    }

    const session = sessionRows[0]!;
    const now = new Date();

    if (session.expiresAt < now) {
      return { kind: 'revokeSession', sessionId: session.id };
    }

    if (session.rotatedAt !== null) {
      const graceMs = env.REFRESH_REUSE_GRACE_SECONDS * 1000;
      const elapsedMs = now.getTime() - new Date(session.rotatedAt).getTime();

      if (elapsedMs <= graceMs) {
        return { kind: 'replay', userId: session.userId, rememberMe: session.rememberMe };
      }

      return { kind: 'revokeFamily', familyId: session.familyId };
    }

    const rotatedToken = createId() + createId();
    const expiresAt = new Date(now.getTime() + getRefreshTtlSeconds(session.rememberMe) * 1000);

    await tx
      .update(sessions)
      .set({ rotatedAt: now })
      .where(eq(sessions.id, session.id));

    await tx.insert(sessions).values({
      id: createId(),
      userId: session.userId,
      refreshToken: hashRefreshToken(rotatedToken),
      familyId: session.familyId,
      rotatedAt: null,
      rememberMe: session.rememberMe,
      expiresAt,
      createdAt: now,
    });

    return { kind: 'rotate', userId: session.userId, rememberMe: session.rememberMe, rotatedToken };
  });

  if (outcome.kind === 'revokeSession') {
    await db.delete(sessions).where(eq(sessions.id, outcome.sessionId));
    throw new UnauthorizedError('Refresh token expired');
  }

  if (outcome.kind === 'revokeFamily') {
    await db.delete(sessions).where(eq(sessions.familyId, outcome.familyId));
    console.warn(
      `Refresh token reuse detected outside the ${env.REFRESH_REUSE_GRACE_SECONDS}s grace window; revoked session family ${outcome.familyId}`
    );
    throw new UnauthorizedError('Invalid refresh token');
  }

  if (outcome.kind === 'reject') {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, outcome.userId))
    .limit(1);

  if (userRows.length === 0) {
    throw new UnauthorizedError('User not found');
  }

  return {
    user: userRows[0]!,
    rotatedToken: outcome.kind === 'rotate' ? outcome.rotatedToken : null,
    rememberMe: outcome.rememberMe,
  };
}

/**
 * Revoke the whole session family behind a refresh token.
 *
 * A family can hold several rows once rotation is in play, so deleting only
 * the row matching the token would leave the browser logged in via the token
 * the previous refresh handed out.
 * @param refreshToken - The plaintext token from the cookie
 */
export async function logout(refreshToken: string): Promise<void> {
  const sessionRows = await db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.refreshToken, hashRefreshToken(refreshToken)))
    .limit(1);

  if (sessionRows.length === 0) {
    return;
  }

  await db.delete(sessions).where(eq(sessions.familyId, sessionRows[0]!.familyId));
}
