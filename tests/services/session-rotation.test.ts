import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * Integration tests for session rotation families.
 *
 * Unlike the other service tests these hit the real dev database: rotation is
 * about row state transitions (rotated_at, family_id) and the only way to prove
 * reuse detection works is to move that timestamp back in SQL and observe what
 * the service does. A mocked db would only assert the mock.
 *
 * Every test creates its own user with a unique suffix and deletes it, plus all
 * of its sessions, in afterAll.
 */
/**
 * tests/setup.ts mocks the env module globally with a throwaway connection
 * string. These tests need the real dev database, so the module is swapped for
 * its actual implementation here; everything else (secrets, TTLs) comes from
 * .env.development exactly as the running server sees it.
 */
vi.mock('../../src/config/env', async () => {
  // env.ts resolves its dotenv file from NODE_ENV, and vitest runs with
  // NODE_ENV=test (pointing at a .env.test that does not exist here). Pretend
  // to be the dev process so the real implementation loads .env.development,
  // the same file the running server reads.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';

  const actual = await vi.importActual<typeof import('../../src/config/env')>(
    '../../src/config/env'
  );

  return {
    ...actual,
    env: {
      ...actual.env,
      REFRESH_REUSE_GRACE_SECONDS: 30,
      MAX_SESSIONS_PER_USER: 5,
      FEATURE_EMAIL: false,
      FEATURE_OAUTH: false,
      FEATURE_MEMORY: false,
    },
  };
});

import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../src/db/index';
import { users, sessions } from '../../src/features/auth/auth.schema';
import { profiles } from '../../src/features/profiles/profiles.schema';
import {
  createSessionWithReply,
  refreshSession,
  logout,
} from '../../src/features/auth/auth.service';
import { buildSessionRefreshCookieOptions, getRefreshTtlSeconds } from '../../src/config/cookies';
import { hashRefreshToken } from '../../src/utils/crypto';
import { UnauthorizedError } from '../../src/utils/errors';

const sql = postgres(SQL_URL, { max: 1 });

const createdUserIds: string[] = [];

/** Minimal FastifyReply stand-in: the cookie builder is unit-tested elsewhere. */
function fakeReply(): { setCookie: ReturnType<typeof vi.fn>; cookies: Map<string, string> } {
  const cookies = new Map<string, string>();
  const setCookie = vi.fn((name: string, value: string) => {
    cookies.set(name, value);
  });
  return { setCookie, cookies };
}

async function createTestUser(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(users).values({
    id,
    email: `rotate-${id}@example.test`,
    username: `rotate_${id}`,
    passwordHash: 'hash',
    salt: 'salt',
    emailVerified: true,
    role: 'user',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(profiles).values({
    id: createId(),
    userId: id,
    username: `rotate_${id}`,
    createdAt: now,
    updatedAt: now,
  });
  createdUserIds.push(id);
  return id;
}

async function login(userId: string, rememberMe?: boolean): Promise<string> {
  const reply = fakeReply();
  await createSessionWithReply(userId, reply as never, rememberMe);
  const token = reply.cookies.get('refreshToken');
  expect(token).toBeTruthy();
  return token!;
}

async function rowsForFamily(userId: string): Promise<
  { refreshToken: string; familyId: string; rotatedAt: Date | null; expiresAt: Date; rememberMe: boolean }[]
> {
  return db
    .select({
      refreshToken: sessions.refreshToken,
      familyId: sessions.familyId,
      rotatedAt: sessions.rotatedAt,
      expiresAt: sessions.expiresAt,
      rememberMe: sessions.rememberMe,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

/** sessions.refresh_token stores the SHA-256 digest, so match on the digest. */
function storedToken(rows: { refreshToken: string }[], plaintext: string): { refreshToken: string } | undefined {
  const digest = hashRefreshToken(plaintext);
  return rows.find((r) => r.refreshToken === digest);
}

beforeAll(() => {
  expect(SQL_URL).not.toBe('');
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, createdUserIds));
    await db.delete(profiles).where(inArray(profiles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await sql.end();
});

describe('session rotation', () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser();
  });

  it('rotation issues a different token in the same family', async () => {
    const first = await login(userId);

    const result = await refreshSession(first);

    expect(result.rotatedToken).toBeTruthy();
    expect(result.rotatedToken).not.toBe(first);
    expect(result.rememberMe).toBe(false);

    const rows = await rowsForFamily(userId);
    expect(rows).toHaveLength(2);
    // Same family, two distinct token digests.
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);

    const consumed = storedToken(rows, first);
    expect(consumed?.rotatedAt).not.toBeNull();
  });

  it('old token inside the grace window returns a token without rotating again', async () => {
    const first = await login(userId);
    const { rotatedToken: second } = await refreshSession(first);
    expect(second).toBeTruthy();

    const replay = await refreshSession(first);

    expect(replay.rotatedToken).toBeNull();
    expect(replay.user.id).toBe(userId);

    const rows = await rowsForFamily(userId);
    expect(rows).toHaveLength(2);
  });

  it('reuse outside the grace window revokes the whole family', async () => {
    const first = await login(userId);
    const { rotatedToken: second } = await refreshSession(first);

    // Backdate the consumed token so the replay lands outside the 30s window.
    await sql`UPDATE sessions SET rotated_at = now() - interval '60 seconds' WHERE refresh_token = ${hashRefreshToken(first)}`;

    await expect(refreshSession(first)).rejects.toThrow(UnauthorizedError);

    const rows = await rowsForFamily(userId);
    expect(rows).toHaveLength(0);

    await expect(refreshSession(second!)).rejects.toThrow(UnauthorizedError);
  });

  it('logout revokes the whole family, not just the presented token', async () => {
    const first = await login(userId);
    const { rotatedToken: second } = await refreshSession(first);

    await logout(first);

    const rows = await rowsForFamily(userId);
    expect(rows).toHaveLength(0);
    await expect(refreshSession(second!)).rejects.toThrow(UnauthorizedError);
  });

  it('rotation preserves the 30d rememberMe TTL and extends the expiry', async () => {
    const first = await login(userId, true);
    const before = (await rowsForFamily(userId))[0]!;

    await refreshSession(first);

    const rows = await rowsForFamily(userId);
    const rotated = rows.find((r) => r.refreshToken !== hashRefreshToken(first))!;
    expect(rotated.rememberMe).toBe(true);

    const expectedSeconds = getRefreshTtlSeconds(true);
    expect(expectedSeconds).toBe(2592000);
    const actualSeconds = Math.round((rotated.expiresAt.getTime() - Date.now()) / 1000);
    expect(Math.abs(actualSeconds - expectedSeconds)).toBeLessThanOrEqual(2);
    expect(rotated.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('MAX_SESSIONS_PER_USER counts families and evicts the oldest one entirely', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      tokens.push(await login(userId));
    }

    const rows = await rowsForFamily(userId);
    const families = new Set(rows.map((r) => r.familyId));

    // 6 logins but only MAX_SESSIONS_PER_USER (5) families survive.
    expect(families.size).toBeLessThanOrEqual(5);
    expect(rows).toHaveLength(5);

    // The first login was evicted, the last five still work.
    await expect(refreshSession(tokens[0]!)).rejects.toThrow(UnauthorizedError);
    for (const token of tokens.slice(1)) {
      const result = await refreshSession(token);
      expect(result.rotatedToken).toBeTruthy();
    }
  });

  it('rotation never counts as a new family', async () => {
    const first = await login(userId);
    let token = first;
    for (let i = 0; i < 4; i += 1) {
      const result = await refreshSession(token);
      token = result.rotatedToken!;
    }

    const rows = await rowsForFamily(userId);
    // 5 tokens from 5 rotations, but all one family, so the limit is untouched.
    expect(rows).toHaveLength(5);

    const families = await db
      .select({ familyId: sessions.familyId })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(new Set(families.map((f) => f.familyId)).size).toBe(1);
  });

  it('unknown token is rejected', async () => {
    await expect(refreshSession('does-not-exist')).rejects.toThrow(UnauthorizedError);
  });

  it('expired session is rejected and cleaned up', async () => {
    const token = await login(userId);
    await sql`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE refresh_token = ${hashRefreshToken(token)}`;

    await expect(refreshSession(token)).rejects.toThrow(UnauthorizedError);
    const rows = await rowsForFamily(userId);
    expect(rows).toHaveLength(0);
  });
});

describe('getRefreshTtlSeconds', () => {
  it('returns whole seconds matching the configured TTLs', () => {
    expect(getRefreshTtlSeconds(false)).toBe(604800);
    expect(getRefreshTtlSeconds(true)).toBe(2592000);
    expect(getRefreshTtlSeconds(undefined)).toBe(604800);
    expect(Number.isInteger(getRefreshTtlSeconds(true))).toBe(true);
  });
});

describe('buildSessionRefreshCookieOptions', () => {
  it('omits Max-Age without rememberMe so the cookie ends with the browser', () => {
    expect(buildSessionRefreshCookieOptions(false).maxAge).toBeUndefined();
    expect(buildSessionRefreshCookieOptions(undefined).maxAge).toBeUndefined();
  });

  it('sets the remember-me TTL as Max-Age with rememberMe', () => {
    expect(buildSessionRefreshCookieOptions(true).maxAge).toBe(2592000);
  });
});
