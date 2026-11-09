import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/** Chat membership lifecycle through the HTTP routes, against the dev database. */
vi.mock('../../src/config/env', async () => {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.development', override: true });
  process.env.NODE_ENV = 'development';
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return {
    ...actual,
    env: { ...actual.env, FEATURE_EMAIL: false, FEATURE_OAUTH: false, FEATURE_MEMORY: false, LOG_LEVEL: 'silent' },
  };
});

import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/index';
import { env } from '../../src/config/env';
import { buildApp } from '../../src/app';
import { createUser } from '../../src/features/auth/auth.service';
import { profiles } from '../../src/features/profiles/profiles.schema';
import { createServer, createChannel } from '../../src/features/chat/chat.service';
import { purgeRows } from './helpers/purge';

const sql = postgres(SQL_URL, { max: 1 });
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `chat-${RUN_ID}-`;

let app: FastifyInstance;

interface Account {
  userId: string;
  profileId: string;
  token: string;
}

async function createAccount(label: string): Promise<Account> {
  const username = `${PREFIX}${label}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  const { user } = await createUser(`${PREFIX}${label}@example.test`, username, 'Password123!');
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id)).limit(1);
  const token = app.jwt.sign({ userId: user.id, email: user.email, role: user.role }, { expiresIn: env.JWT_ACCESS_EXPIRES_IN });
  return { userId: user.id, profileId: profile!.id, token };
}

function api(account: Account, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${account.token}` }, payload: payload as never });
}

beforeAll(async () => {
  expect(SQL_URL).not.toBe('');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  const runUsers = await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  await purgeRows(sql, 'users', 'id', runUsers.map((row) => row.id));
  await app.close();
  await sql.end();
});

describe('chat membership', () => {
  it('grants access on join and takes it away on removal', async () => {
    const owner = await createAccount('owner');
    const member = await createAccount('member');
    const server = await createServer(owner.userId, { name: `${PREFIX}server` });
    const channel = await createChannel(owner.userId, server.id, { name: 'general' });

    const added = await api(owner, 'POST', `/api/v1/chat/servers/${server.id}/members`, { profileId: member.profileId });
    expect(added.statusCode, added.body).toBeLessThan(300);
    const membershipId = (added.json() as { data: { id: string } }).data.id;
    expect(membershipId).toBeTruthy();

    const sent = await api(member, 'POST', `/api/v1/chat/channels/${channel.id}/messages`, { content: 'hello' });
    expect(sent.statusCode, sent.body).toBeLessThan(300);
    expect((await api(member, 'GET', `/api/v1/chat/channels/${channel.id}/messages`)).statusCode).toBe(200);

    const removed = await api(owner, 'DELETE', `/api/v1/chat/servers/${server.id}/members/${membershipId}`);
    expect(removed.statusCode, removed.body).toBe(200);

    expect((await api(member, 'GET', `/api/v1/chat/channels/${channel.id}/messages`)).statusCode).toBe(403);
    expect((await api(member, 'POST', `/api/v1/chat/channels/${channel.id}/messages`, { content: 'still here?' })).statusCode).toBe(403);
  });

  it('lets a member leave but never removes the owner', async () => {
    const owner = await createAccount('owner2');
    const member = await createAccount('member2');
    const server = await createServer(owner.userId, { name: `${PREFIX}server2` });

    const added = await api(owner, 'POST', `/api/v1/chat/servers/${server.id}/members`, { profileId: member.profileId });
    const membershipId = (added.json() as { data: { id: string } }).data.id;

    const members = await api(owner, 'GET', `/api/v1/chat/servers/${server.id}/members`);
    const ownerRow = (members.json() as { data: Array<{ id: string; profileId: string }> }).data.find(
      (row) => row.profileId === owner.profileId
    );
    expect(ownerRow).toBeDefined();

    expect((await api(member, 'DELETE', `/api/v1/chat/servers/${server.id}/members/${ownerRow!.id}`)).statusCode).toBe(403);
    expect((await api(owner, 'DELETE', `/api/v1/chat/servers/${server.id}/members/${ownerRow!.id}`)).statusCode).toBe(403);
    expect((await api(member, 'DELETE', `/api/v1/chat/servers/${server.id}/members/${membershipId}`)).statusCode).toBe(200);
  });
});
