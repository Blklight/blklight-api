import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * Cross-account authorization: for each feature, user A owns a resource and
 * user B (signed in, not a member/owner) tries to read or change it. Every
 * attempt must be refused with 403 or 404, never 2xx and never 401 (401 means
 * "token expired" to the front, which would refresh and retry).
 *
 * Runs against the real dev database through app.inject. Fixtures carry a
 * per-run prefix and are hard-deleted in afterAll by following foreign keys.
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
      FEATURE_EMAIL: false,
      FEATURE_OAUTH: false,
      FEATURE_MEMORY: false,
      RATE_LIMIT_DOCS_CREATE_MAX: 1000,
      RATE_LIMIT_DOCS_PUBLISH_MAX: 1000,
      LOG_LEVEL: 'silent',
    },
  };
});

import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/index';
import { env } from '../../src/config/env';
import { buildApp } from '../../src/app';
import { createUser } from '../../src/features/auth/auth.service';
import { profiles } from '../../src/features/profiles/profiles.schema';
import { categories } from '../../src/features/categories/categories.schema';
import { createOrganization, inviteMember, decideMembership } from '../../src/features/organizations/organizations.service';
import { createServer, createChannel, addMember, sendMessage } from '../../src/features/chat/chat.service';
import { purgeRows } from './helpers/purge';

const sql = postgres(SQL_URL, { max: 1 });
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `authz-${RUN_ID}-`;

let app: FastifyInstance;
let categoryId = '';

interface Account {
  userId: string;
  profileId: string;
  username: string;
  token: string;
}

let owner: Account;
let intruder: Account;

async function createAccount(label: string): Promise<Account> {
  const username = `${PREFIX}${label}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  const { user } = await createUser(`${PREFIX}${label}@example.test`, username, 'Password123!');
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id)).limit(1);
  const token = app.jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN }
  );
  return { userId: user.id, profileId: profile!.id, username: profile!.username, token };
}

function api(account: Account | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: account ? { authorization: `Bearer ${account.token}` } : {},
    payload: payload as never,
  });
}

async function created<T>(response: Awaited<ReturnType<typeof api>>): Promise<T> {
  expect(response.statusCode, response.body).toBeLessThan(300);
  return (response.json() as { data: T }).data;
}

/** A created fixture must come back with its id, or every "denied" check would pass vacuously. */
async function createdWithId(response: Awaited<ReturnType<typeof api>>): Promise<{ id: string }> {
  const data = await created<{ id?: string }>(response);
  expect(data?.id, `response without id: ${response.body}`).toBeTruthy();
  return data as { id: string };
}

function expectDenied(response: Awaited<ReturnType<typeof api>>) {
  expect([403, 404], `${response.statusCode} ${response.body}`).toContain(response.statusCode);
}

async function createDocument(account: Account, type = 'article') {
  return createdWithId(
    await api(account, 'POST', '/api/v1/documents', {
      title: `${PREFIX}doc`,
      type,
      categoryId,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] },
    })
  );
}

beforeAll(async () => {
  expect(SQL_URL).not.toBe('');
  app = await buildApp();
  await app.ready();

  const [category] = await db
    .insert(categories)
    .values({ id: createId(), name: `${PREFIX}Category`, slug: `${PREFIX}category`, createdAt: new Date() })
    .returning({ id: categories.id });
  categoryId = category!.id;

  owner = await createAccount('owner');
  intruder = await createAccount('intruder');
});

afterAll(async () => {
  const runUsers = await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  await purgeRows(sql, 'users', 'id', runUsers.map((row) => row.id));
  await purgeRows(sql, 'categories', 'slug', [`${PREFIX}category`]);
  await app.close();
  await sql.end();
});

describe('documents', () => {
  it("does not let another user read, edit, publish or delete a draft", async () => {
    const doc = await createDocument(owner);

    expectDenied(await api(intruder, 'GET', `/api/v1/documents/${doc.id}`));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/documents/${doc.id}`, { title: 'hijacked' }));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/documents/${doc.id}/publish`));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/documents/${doc.id}`));

    const stillMine = await created<{ title: string }>(await api(owner, 'GET', `/api/v1/documents/${doc.id}`));
    expect(stillMine.title).toBe(`${PREFIX}doc`);
  });
});

describe('notes and journals', () => {
  it('keeps notes private to their owner', async () => {
    const note = await createdWithId(await api(owner, 'POST', '/api/v1/notes', { content: 'secret' }));

    expectDenied(await api(intruder, 'GET', `/api/v1/notes/${note.id}`));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/notes/${note.id}`, { content: 'hijacked' }));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/notes/${note.id}`));
  });

  it('keeps journals private to their owner', async () => {
    const journal = await createdWithId(await api(owner, 'POST', '/api/v1/journals', { title: `${PREFIX}journal` }));

    expectDenied(await api(intruder, 'GET', `/api/v1/journals/${journal.id}`));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/journals/${journal.id}`, { title: 'hijacked' }));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/journals/${journal.id}`));
  });
});

describe('style templates and books', () => {
  it("does not let another user delete a style template", async () => {
    const template = await createdWithId(
      await api(owner, 'POST', '/api/v1/document-style-templates', { name: `${PREFIX}tpl`, typography: 'serif' })
    );
    expectDenied(await api(intruder, 'DELETE', `/api/v1/document-style-templates/${template.id}`));
  });

  it("does not let another user edit, publish or delete a book", async () => {
    const book = await createdWithId(await api(owner, 'POST', '/api/v1/books', { title: `${PREFIX}book` }));

    expectDenied(await api(intruder, 'PATCH', `/api/v1/books/${book.id}`, { title: 'hijacked' }));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/books/${book.id}/publish`));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/books/${book.id}`));
  });
});

describe('tutorial exercises', () => {
  it("does not let another user manage or read the exercises of a draft", async () => {
    const doc = await createDocument(owner, 'tutorial');
    const quiz = { type: 'quiz', data: { question: 'q?', options: ['a', 'b'], correctIndex: 1 } };
    const exercise = await createdWithId(await api(owner, 'POST', `/api/v1/documents/${doc.id}/exercises`, quiz));

    expectDenied(await api(intruder, 'POST', `/api/v1/documents/${doc.id}/exercises`, quiz));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/exercises/${exercise.id}`, quiz));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/exercises/${exercise.id}`));
    expectDenied(await api(intruder, 'GET', `/api/v1/documents/${doc.id}/exercises`));
  });
});

describe('highlights', () => {
  it("does not let another user edit or delete a highlight", async () => {
    const doc = await createDocument(owner);
    await created(await api(owner, 'PATCH', `/api/v1/documents/${doc.id}/publish`, { categoryId, tags: [] }));
    const palette = await created<{ colors?: string[] } | string[]>(await api(owner, 'GET', '/api/v1/highlights/palette'));
    const color = Array.isArray(palette) ? palette[0] : palette.colors?.[0];

    const highlight = await createdWithId(
      await api(owner, 'POST', `/api/v1/documents/${doc.id}/highlights`, {
        selection: { text: 'hello', color, position: { nodeIndex: 0, offsetStart: 0, offsetEnd: 5 } },
      })
    );

    expectDenied(await api(intruder, 'PATCH', `/api/v1/highlights/${highlight.id}`, { annotation: { note: 'x' } }));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/highlights/${highlight.id}`));
  });
});

describe('chat', () => {
  it('keeps a server closed to non-members and messages to their author', async () => {
    const server = await createServer(owner.userId, { name: `${PREFIX}server` });
    const channel = await createChannel(owner.userId, server.id, { name: 'general' });
    const message = await sendMessage(owner.userId, channel.id, 'hi');

    expectDenied(await api(intruder, 'GET', `/api/v1/chat/servers/${server.id}`));
    expectDenied(await api(intruder, 'GET', `/api/v1/chat/channels/${channel.id}/messages`));
    expectDenied(await api(intruder, 'POST', `/api/v1/chat/channels/${channel.id}/messages`, { content: 'spam' }));

    // Even as a member, B cannot edit or delete A's message.
    await addMember(owner.userId, server.id, intruder.profileId);
    expectDenied(await api(intruder, 'PATCH', `/api/v1/chat/messages/${message.id}`, { content: 'hijacked' }));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/chat/messages/${message.id}`));
  });
});

describe('organizations', () => {
  it('only lets managers invite and remove members', async () => {
    const org = await createOrganization(owner.profileId, { name: `${PREFIX}org`, orgname: `a${RUN_ID}`.slice(0, 30), isPrivate: false });
    const member = await createAccount('orgmember');
    await inviteMember(org.id, owner.profileId, member.profileId);
    await decideMembership(org.id, member.profileId, 'accepted');

    expectDenied(await api(intruder, 'POST', `/api/v1/organizations/${org.id}/invite`, { profileId: intruder.profileId }));
    expectDenied(await api(intruder, 'DELETE', `/api/v1/organizations/${org.id}/members/${member.profileId}`));
    // A plain member is not a manager either.
    expectDenied(await api(member, 'DELETE', `/api/v1/organizations/${org.id}/members/${owner.profileId}`));
  });
});

describe('follows and admin', () => {
  it("does not let a third user accept someone else's follow request", async () => {
    const privateUser = await createAccount('private');
    await created(await api(privateUser, 'PATCH', '/api/v1/profiles/me', { isPrivate: true }));
    await created(await api(owner, 'POST', `/api/v1/profiles/${privateUser.username}/follow`));
    const requests = await created<Array<{ id: string }> | { items: Array<{ id: string }> }>(
      await api(privateUser, 'GET', '/api/v1/follows/requests')
    );
    const requestId = (Array.isArray(requests) ? requests : requests.items)[0]!.id;

    expectDenied(await api(intruder, 'POST', `/api/v1/follows/requests/${requestId}/accept`));
  });

  it('refuses admin routes to a regular user', async () => {
    expectDenied(await api(intruder, 'GET', '/api/v1/admin/users'));
    expectDenied(await api(intruder, 'PATCH', `/api/v1/admin/users/${owner.userId}/role`, { role: 'admin' }));
  });
});
