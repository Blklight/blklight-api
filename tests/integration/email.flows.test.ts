import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * Email verification and password reset end to end: route -> service -> queue
 * -> link token -> route. The queue is not processed (nothing is sent); the
 * test reads the link out of the queued HTML, as the user would from the email.
 */
vi.mock('../../src/config/env', async () => {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      FEATURE_EMAIL: true,
      FEATURE_EMAIL_QUEUE: false,
      FEATURE_OAUTH: false,
      FEATURE_MEMORY: false,
      FRONTEND_URL: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    },
  };
});

import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { purgeRows } from './helpers/purge';

const sql = postgres(SQL_URL, { max: 1 });
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `mail-${RUN_ID}-`;
const PASSWORD = 'Password123!';

let app: FastifyInstance;

function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as never });
}

/** Wait for the email sent to `to` whose link points at `path`, and return the link token. */
async function tokenFromQueuedEmail(to: string, path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await sql<{ html: string }[]>`
      SELECT html FROM email_queue WHERE "to" = ${to} ORDER BY created_at DESC
    `;
    for (const row of rows) {
      const match = row.html.match(new RegExp(`${path}\\?token=([0-9a-f]{64})`));
      if (match) return match[1]!;
    }
    if (Date.now() > deadline) throw new Error(`no ${path} email queued for ${to}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function register(label: string) {
  const email = `${PREFIX}${label}@example.test`;
  const response = await post('/api/v1/auth/register', {
    email,
    username: `${PREFIX}${label}`.replace(/[^a-z0-9_]/g, '_').slice(0, 30),
    password: PASSWORD,
  });
  expect(response.statusCode, response.body).toBe(201);
  return email;
}

beforeAll(async () => {
  expect(SQL_URL).not.toBe('');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  const runUsers = await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  await purgeRows(sql, 'users', 'id', runUsers.map((row) => row.id));
  await sql`DELETE FROM email_queue WHERE "to" LIKE ${`${PREFIX}%`}`;
  await app.close();
  await sql.end();
});

describe('email verification', () => {
  it('verifies the account once with the emailed link', async () => {
    const email = await register('verify');
    const token = await tokenFromQueuedEmail(email, '/verify-email');

    // The database keeps only the hash of the link token.
    const stored = await sql`SELECT 1 FROM email_verifications WHERE token = ${token}`;
    expect(stored).toHaveLength(0);

    expect((await post('/api/v1/auth/verify-email', { token })).statusCode).toBe(200);
    const [user] = await sql<{ email_verified: boolean }[]>`SELECT email_verified FROM users WHERE email = ${email}`;
    expect(user!.email_verified).toBe(true);

    expect((await post('/api/v1/auth/verify-email', { token })).statusCode).toBe(404);
  });
});

describe('password reset', () => {
  it('resets the password once, revokes sessions and applies the password policy', async () => {
    const email = await register('reset');
    const sessionsBefore = await sql`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ${email}`;
    expect(sessionsBefore.length).toBeGreaterThan(0);

    expect((await post('/api/v1/auth/forgot-password', { email })).statusCode).toBe(200);
    const token = await tokenFromQueuedEmail(email, '/reset-password');

    const weak = await post('/api/v1/auth/reset-password', { token, password: 'password1' });
    expect(weak.statusCode).toBe(400);

    const newPassword = 'NewPassword456!';
    const reset = await post('/api/v1/auth/reset-password', { token, password: newPassword });
    expect(reset.statusCode, reset.body).toBe(200);

    const sessionsAfter = await sql`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ${email}`;
    expect(sessionsAfter).toHaveLength(0);

    expect((await post('/api/v1/auth/login', { identifier: email, password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/login', { identifier: email, password: newPassword })).statusCode).toBe(200);

    const replay = await post('/api/v1/auth/reset-password', { token, password: 'Another789!' });
    expect(replay.statusCode).toBe(404);
  });

  it('answers the same way for an unknown email', async () => {
    const response = await post('/api/v1/auth/forgot-password', { email: `${PREFIX}nobody@example.test` });
    expect(response.statusCode).toBe(200);
    const queued = await sql`SELECT 1 FROM email_queue WHERE "to" = ${`${PREFIX}nobody@example.test`}`;
    expect(queued).toHaveLength(0);
  });
});
