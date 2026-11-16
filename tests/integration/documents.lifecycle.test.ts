import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * End-to-end integration tests for the document lifecycle.
 *
 * These exercise the real HTTP surface (`app.inject`) against the real dev
 * database, because the behaviour under test is the contract between route,
 * Zod validation, service and SQL — a mocked db would only assert the mock.
 * All rows created here are namespaced with a per-run prefix and hard-deleted
 * in afterAll, so the suite leaves the database byte-identical.
 */
vi.mock('../../src/config/env', async () => {
  // env.ts resolves its dotenv file from NODE_ENV; vitest runs with
  // NODE_ENV=test. Pretend to be the dev process so the real implementation
  // loads .env.development, exactly like the running server.
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
      FEATURE_EMAIL: false,
      FEATURE_OAUTH: false,
      FEATURE_MEMORY: false,
      // The suite creates several documents; keep the per-user route limit
      // out of the way so 429s never masquerade as lifecycle failures.
      RATE_LIMIT_DOCS_CREATE_MAX: 1000,
      RATE_LIMIT_DOCS_PUBLISH_MAX: 1000,
      LOG_LEVEL: 'silent',
    },
  };
});

import postgres from 'postgres';
import { eq, inArray, like } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../src/db/index';
import { env } from '../../src/config/env';
import { buildApp } from '../../src/app';
import { createUser } from '../../src/features/auth/auth.service';
import { users, sessions } from '../../src/features/auth/auth.schema';
import { profiles } from '../../src/features/profiles/profiles.schema';
import { signatures } from '../../src/features/signatures/signatures.schema';
import { workspaces } from '../../src/features/workspace/workspace.schema';
import { canvas } from '../../src/features/canvas/canvas.schema';
import { documents, documentStyles, documentTypes } from '../../src/features/documents/documents.schema';
import { documentCategories, categories } from '../../src/features/categories/categories.schema';
import { documentTags, tags } from '../../src/features/tags/tags.schema';
import { documentLikes } from '../../src/features/likes/likes.schema';
import {
  emailVerifications,
  passwordResets,
  emailQueue,
} from '../../src/features/email/email.schema';
import type { FastifyInstance } from 'fastify';

const sql = postgres(SQL_URL, { max: 1 });

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `itest-${RUN_ID}-`;

/**
 * The tables this suite can touch. Counted before the first write and again
 * after cleanup so the report can show the suite is side-effect free.
 */
const COUNTED_TABLES = [
  'users',
  'profiles',
  'signatures',
  'workspaces',
  'canvas',
  'sessions',
  'documents',
  'document_styles',
  'document_categories',
  'document_tags',
  'document_likes',
  'tags',
  'categories',
  'email_queue',
  'email_verifications',
  'password_resets',
] as const;

const STRICT_COUNTS = process.env.ITEST_STRICT_COUNTS === '1';

let app: FastifyInstance;
let baselineCounts: Record<string, number> = {};

const createdUserIds: string[] = [];
const createdProfileIds: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdCanvasIds: string[] = [];
const createdDocumentIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdTagNames: string[] = [];
const createdEmails: string[] = [];
let categoryId = '';

interface Account {
  userId: string;
  profileId: string;
  username: string;
  email: string;
  token: string;
}

function makeUsername(label: string): string {
  return `${PREFIX}${label}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
}

async function createAccount(label: string): Promise<Account> {
  const email = `${PREFIX}${label}@example.test`;
  const username = makeUsername(label);
  const { user } = await createUser(email, username, 'Password123!');

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, user.id))
    .limit(1);

  createdUserIds.push(user.id);
  createdEmails.push(email);
  if (profile) createdProfileIds.push(profile.id);
  if (workspace) {
    createdWorkspaceIds.push(workspace.id);
    const [cv] = await db
      .select({ id: canvas.id })
      .from(canvas)
      .where(eq(canvas.workspaceId, workspace.id))
      .limit(1);
    if (cv) createdCanvasIds.push(cv.id);
  }

  const token = app.jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN }
  );

  return { userId: user.id, profileId: profile!.id, username: profile!.username, email, token };
}

function authHeaders(account: Account): Record<string, string> {
  return { authorization: `Bearer ${account.token}` };
}

async function api(
  account: Account | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: account ? authHeaders(account) : {},
    payload: payload as never,
  });
}

async function createDraft(
  account: Account,
  title: string,
  withCategory = true,
  withContent = true
) {
  const res = await api(account, 'POST', '/api/v1/documents', {
    title,
    type: 'article',
    ...(withContent ? { content: { type: 'doc', content: [{ type: 'paragraph' }] } } : {}),
    ...(withCategory ? { categoryId } : {}),
  });
  const body = res.json() as { data?: { id: string; slug: string } };
  if (body.data?.id) createdDocumentIds.push(body.data.id);
  return { id: body.data?.id ?? '', slug: body.data?.slug ?? '', res };
}

async function tableCounts(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    COUNTED_TABLES.map(async (table) => {
      const rows = await sql.unsafe(`select count(*)::int as c from "${table}"`);
      return [table, rows[0]!.c as number] as const;
    })
  );
  return Object.fromEntries(entries);
}

async function waitForCountsToEqual(expected: Record<string, number>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await tableCounts();
    if (COUNTED_TABLES.every((t) => current[t] === expected[t])) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  expect(SQL_URL).not.toBe('');

  app = await buildApp();
  await app.ready();

  const articleType = await db
    .select()
    .from(documentTypes)
    .where(eq(documentTypes.name, 'article'))
    .limit(1);
  if (articleType.length === 0) {
    await db.insert(documentTypes).values({ id: createId(), name: 'article' });
  }

  baselineCounts = await tableCounts();

  // Created after the baseline snapshot and deleted in afterAll, so the run
  // nets to zero. Every document fixture needs a category to be publishable.
  const [category] = await db
    .insert(categories)
    .values({
      id: createId(),
      name: `${PREFIX}Category`,
      slug: `${PREFIX}category`,
      createdAt: new Date(),
    })
    .returning({ id: categories.id });
  categoryId = category!.id;
  createdCategoryIds.push(category!.id);
});

afterAll(async () => {
  // Hard delete by the run's own prefix, children before parents.
  //
  // The lookup is by prefix and not by the ids collected while the tests ran:
  // a row created before an assertion blew up never reached a tracking array,
  // and a single untracked row left behind aborts the whole cleanup on the
  // first foreign key violation, leaking every row that comes after it.
  const runUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${PREFIX}%`));
  const userIds = runUsers.map((row) => row.id);

  if (userIds.length > 0) {
    await db.delete(emailVerifications).where(inArray(emailVerifications.userId, userIds));
    await db.delete(passwordResets).where(inArray(passwordResets.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(signatures).where(inArray(signatures.userId, userIds));

    const owned = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.ownerId, userIds));
    const ownedIds = owned.map((row) => row.id);

    if (ownedIds.length > 0) {
      await db.delete(canvas).where(inArray(canvas.workspaceId, ownedIds));
      await db.delete(workspaces).where(inArray(workspaces.id, ownedIds));
    }

    const ownedProfiles = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(inArray(profiles.userId, userIds));
    const profileIds = ownedProfiles.map((row) => row.id);

    if (profileIds.length > 0) {
      const ownedDocuments = await db
        .select({ id: documents.id })
        .from(documents)
        .where(inArray(documents.authorId, profileIds));
      const documentIds = ownedDocuments.map((row) => row.id);

      if (documentIds.length > 0) {
        await db.delete(documentLikes).where(inArray(documentLikes.documentId, documentIds));
        await db.delete(documentTags).where(inArray(documentTags.documentId, documentIds));
        await db.delete(documentCategories).where(inArray(documentCategories.documentId, documentIds));
        await db.delete(documentStyles).where(inArray(documentStyles.documentId, documentIds));
        await db.delete(documents).where(inArray(documents.id, documentIds));
      }

      await db.delete(profiles).where(inArray(profiles.id, profileIds));
    }

    await db.delete(users).where(inArray(users.id, userIds));
  }

  // Categories, tags and queued emails created by the run carry the prefix.
  await db.delete(categories).where(like(categories.name, `${PREFIX}%`));
  await db.delete(tags).where(like(tags.name, `${PREFIX}%`));
  await db.delete(emailQueue).where(like(emailQueue.to, `${PREFIX}%`));

  const after = await tableCounts();
  const diff: Record<string, { before: number; after: number }> = {};
  for (const table of COUNTED_TABLES) {
    if (after[table] !== baselineCounts[table]) {
      diff[table] = { before: baselineCounts[table]!, after: after[table]! };
    }
  }
  console.log('[itest] table counts before:', JSON.stringify(baselineCounts));
  console.log('[itest] table counts after :', JSON.stringify(after));
  console.log('[itest] count diff          :', JSON.stringify(diff));

  // Deterministic leak check: none of this run's rows may survive.
  expect(await countBy('users', 'id', createdUserIds)).toBe(0);
  expect(await countBy('profiles', 'id', createdProfileIds)).toBe(0);
  expect(await countBy('documents', 'id', createdDocumentIds)).toBe(0);
  expect(await countBy('workspaces', 'id', createdWorkspaceIds)).toBe(0);
  expect(await countBy('canvas', 'id', createdCanvasIds)).toBe(0);
  expect(await countBy('sessions', 'user_id', createdUserIds)).toBe(0);
  expect(await countBy('signatures', 'user_id', createdUserIds)).toBe(0);
  expect(await countBy('tags', 'name', createdTagNames)).toBe(0);
  expect(await countBy('categories', 'id', createdCategoryIds)).toBe(0);

  // The prefix is the source of truth for the cleanup, so it is also the
  // source of truth for the leak check: a row the tracking arrays missed
  // still has to be gone.
  expect(await countRows('select count(*)::int as c from users where email like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from profiles where username like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from categories where name like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from tags where name like $1', [`${PREFIX}%`])).toBe(0);

  // Global count parity is only meaningful when no other DB-touching suite is
  // writing concurrently, so it is asserted on demand (isolated run).
  if (STRICT_COUNTS) {
    const equal = await waitForCountsToEqual(baselineCounts, 15_000);
    if (!equal) {
      console.error('[itest] strict count mismatch:', JSON.stringify(await tableCounts()));
    }
    expect(equal).toBe(true);
  }

  await app.close();
  await sql.end();
});

async function countBy(table: string, column: string, values: string[]): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await sql.unsafe(
    `select count(*)::int as c from "${table}" where "${column}" = any($1)`,
    [values]
  );
  return rows[0]!.c as number;
}

async function countRows(query: string, params: unknown[]): Promise<number> {
  const rows = await sql.unsafe(query, params);
  return rows[0]!.c as number;
}

/**
 * Count the documents of one author. The integration files share the same
 * database and run in parallel, so a global count would race with the
 * documents another file is creating while the assertion runs.
 */
async function countDocumentsByAuthor(profileId: string): Promise<number> {
  const rows = await sql.unsafe('select count(*)::int as c from documents where author_id = $1', [
    profileId,
  ]);
  return rows[0]!.c as number;
}

async function countStylesByAuthor(profileId: string): Promise<number> {
  const rows = await sql.unsafe(
    'select count(*)::int as c from document_styles where document_id in (select id from documents where author_id = $1)',
    [profileId]
  );
  return rows[0]!.c as number;
}

async function countCategoriesByAuthor(profileId: string): Promise<number> {
  const rows = await sql.unsafe(
    'select count(*)::int as c from document_categories where document_id in (select id from documents where author_id = $1)',
    [profileId]
  );
  return rows[0]!.c as number;
}

describe('document lifecycle (integration)', () => {
  it('rejects unauthenticated create with 401', async () => {
    const res = await api(null, 'POST', '/api/v1/documents', { title: 'nope', type: 'article' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a draft document with style', async () => {
    const account = await createAccount('create');
    const { id, slug, res } = await createDraft(account, `${PREFIX}Create Me`);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; status: string; slug: string; authorId: string; typeName: string; style: unknown } };
    expect(body.data.status).toBe('draft');
    expect(body.data.slug).toBeTruthy();
    expect(body.data.authorId).toBe(account.profileId);
    expect(body.data.typeName).toBe('article');
    expect(body.data.style).toBeDefined();
    expect(id).toBeTruthy();
    expect(slug).toBeTruthy();
  });

  it('autosaves content without publishing', async () => {
    const account = await createAccount('autosave');
    const { id } = await createDraft(account, `${PREFIX}Autosave`);

    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };
    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, { content });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; content: Record<string, unknown> } };
    expect(body.data.status).toBe('draft');
    expect(body.data.content).toEqual(content);
  });

  it('publishes a document, setting authorship and publishedAt', async () => {
    const account = await createAccount('publish');
    const { id } = await createDraft(account, `${PREFIX}Publish Me`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; authorship: { documentHash: string; publicIdentifier: string } | null; publishedAt: string | null } };
    expect(body.data.status).toBe('published');
    expect(body.data.authorship?.documentHash).toBeTruthy();
    expect(body.data.authorship?.publicIdentifier).toMatch(/^PLT-/);
    expect(body.data.publishedAt).toBeTruthy();
  });

  it('editing published content keeps the document published', async () => {
    const account = await createAccount('editpub');
    const { id } = await createDraft(account, `${PREFIX}Edit Published`);

    const published = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);
    const before = published.json() as { data: { authorship: { publicIdentifier: string } } };

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; authorship: { publicIdentifier: string } | null } };
    expect(body.data.status).toBe('published');
    expect(body.data.authorship?.publicIdentifier).toBe(before.data.authorship.publicIdentifier);
  });

  it('soft-deletes a document and hides it from owner and public reads', async () => {
    const account = await createAccount('delete');
    const { id, slug } = await createDraft(account, `${PREFIX}Delete Me`);

    const del = await api(account, 'DELETE', `/api/v1/documents/${id}`);
    expect(del.statusCode).toBe(200);

    const owner = await api(account, 'GET', `/api/v1/documents/${id}`);
    expect(owner.statusCode).toBe(404);

    const pub = await api(null, 'GET', `/api/v1/documents/${account.username}/${slug}`);
    expect(pub.statusCode).toBe(404);
  });

  it('serves a published document publicly and 404s on unknown slug', async () => {
    const account = await createAccount('public');
    const { id, slug } = await createDraft(account, `${PREFIX}Public Read`);
    await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    const res = await api(null, 'GET', `/api/v1/documents/${account.username}/${slug}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { slug: string; title: string; username: string } };
    expect(body.data.slug).toBe(slug);
    expect(body.data.title).toBe(`${PREFIX}Public Read`);

    const missing = await api(null, 'GET', `/api/v1/documents/${account.username}/does-not-exist`);
    expect(missing.statusCode).toBe(404);
  });

  it('feed filters by q and paginates with a cursor', async () => {
    const account = await createAccount('feed');
    for (let i = 0; i < 3; i += 1) {
      const { id } = await createDraft(account, `${PREFIX}Feed ${i}`);
      await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);
    }

    const first = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(PREFIX)}&limit=1&sort=recent`);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { data: { items: { id: string }[]; nextCursor: string | null; total: number } };
    expect(firstBody.data.total).toBeGreaterThanOrEqual(3);
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.nextCursor).toBeTruthy();

    const second = await api(
      null,
      'GET',
      `/api/v1/documents?q=${encodeURIComponent(PREFIX)}&limit=1&sort=recent&cursor=${encodeURIComponent(firstBody.data.nextCursor!)}`
    );
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { data: { items: { id: string }[] } };
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.items[0]!.id).not.toBe(firstBody.data.items[0]!.id);
  });

  it('feed cards carry the design preview (typography, paper style and texture)', async () => {
    const account = await createAccount('feedstyle');
    const { id } = await createDraft(account, `${PREFIX}Styled`);
    const paperStyle = { bg: '#f4e9d8', text: '#3b2f2f' };
    const paperTexture = { type: 'dots', size: 18, opacity: 0.4 };
    await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      typography: 'serif',
      paperStyle,
      paperTexture,
    });
    await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    const res = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(`${PREFIX}Styled`)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { items: { id: string; style: Record<string, unknown> | null }[] };
    };
    const card = body.data.items.find((item) => item.id === id);
    expect(card?.style).toEqual({ typography: 'serif', paperStyle, paperTexture });
  });
});

/**
 * Per-test sub-prefixes. The feed `q` filter is an ILIKE on the title, so a
 * shared prefix would mix the fixtures of every test and make the exact
 * totals impossible to assert.
 */
const SUB = {
  crossAuthor: `${PREFIX}xtra-`,
  privateAuthor: `${PREFIX}priv-`,
  softDelete: `${PREFIX}sdel-`,
  publishErrors: `${PREFIX}pube-`,
  tags: `${PREFIX}tage-`,
  sort: `${PREFIX}pops-`,
  slug: `${PREFIX}slge-`,
} as const;

interface FeedBody {
  data: { items: { id: string; slug: string; likesCount: number }[]; nextCursor: string | null; total: number };
}

interface ErrorBody {
  data: null;
  error: { code: string; message: string; fields?: Record<string, string> };
  message: string;
}

describe('cross-author write isolation', () => {
  it('rejects a PATCH from another author with 404 and leaves the owner document intact', async () => {
    const owner = await createAccount('xtra');
    const intruder = await createAccount('xtri');
    const title = `${SUB.crossAuthor}Original Title`;
    const { id } = await createDraft(owner, title);

    const res = await api(intruder, 'PATCH', `/api/v1/documents/${id}`, {
      title: 'Hijacked by another author',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Document not found');

    const ownerRead = await api(owner, 'GET', `/api/v1/documents/${id}`);
    expect(ownerRead.statusCode).toBe(200);
    const ownerBody = ownerRead.json() as { data: { title: string; slug: string } };
    expect(ownerBody.data.title).toBe(title);
    expect(ownerBody.data.slug).not.toContain('hijacked');
  });
});

describe('private author visibility', () => {
  it('answers a private author document with the exact same 404 body as a missing slug and drops it from the feed', async () => {
    const author = await createAccount('priva');
    const viewer = await createAccount('privv');
    const q = SUB.privateAuthor;
    const { id, slug } = await createDraft(author, `${q}Private Doc`);
    await api(author, 'PATCH', `/api/v1/documents/${id}/publish`);

    // Control: while the author is public the document is in the feed.
    const publicFeed = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(q)}`);
    expect(publicFeed.statusCode).toBe(200);
    const publicBody = publicFeed.json() as FeedBody;
    expect(publicBody.data.total).toBe(1);
    expect(publicBody.data.items.map((item) => item.id)).toEqual([id]);

    await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.id, author.profileId));

    const anonymous = await api(null, 'GET', `/api/v1/documents/${author.username}/${slug}`);
    const authenticated = await api(viewer, 'GET', `/api/v1/documents/${author.username}/${slug}`);
    const missing = await api(null, 'GET', `/api/v1/documents/${author.username}/no-such-slug`);

    expect(anonymous.statusCode).toBe(404);
    expect(authenticated.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(anonymous.body).toBe(missing.body);
    expect(authenticated.body).toBe(missing.body);

    const anonFeed = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(q)}`);
    const viewerFeed = await api(viewer, 'GET', `/api/v1/documents?q=${encodeURIComponent(q)}`);
    const anonFeedBody = anonFeed.json() as FeedBody;
    const viewerFeedBody = viewerFeed.json() as FeedBody;
    expect(anonFeedBody.data.total).toBe(0);
    expect(anonFeedBody.data.items).toHaveLength(0);
    expect(viewerFeedBody.data.total).toBe(0);
    expect(viewerFeedBody.data.items).toHaveLength(0);
  });
});

describe('soft delete isolation', () => {
  it('removes a published document from the public feed with an exact total and keeps the drafts', async () => {
    const account = await createAccount('sdel');
    const q = SUB.softDelete;
    const draftA = await createDraft(account, `${q}Draft One`);
    const draftB = await createDraft(account, `${q}Draft Two`);
    const live = await createDraft(account, `${q}Live Doc`);

    const published = await api(account, 'PATCH', `/api/v1/documents/${live.id}/publish`);
    expect(published.statusCode).toBe(200);

    const before = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(q)}`);
    const beforeBody = before.json() as FeedBody;
    expect(beforeBody.data.total).toBe(1);
    expect(beforeBody.data.items.map((item) => item.id)).toEqual([live.id]);

    const control = await api(null, 'GET', `/api/v1/documents/${account.username}/${live.slug}`);
    expect(control.statusCode).toBe(200);

    const del = await api(account, 'DELETE', `/api/v1/documents/${live.id}`);
    expect(del.statusCode).toBe(200);

    const after = await api(null, 'GET', `/api/v1/documents?q=${encodeURIComponent(q)}`);
    const afterBody = after.json() as FeedBody;
    expect(afterBody.data.total).toBe(0);
    expect(afterBody.data.items).toHaveLength(0);

    const gone = await api(null, 'GET', `/api/v1/documents/${account.username}/${live.slug}`);
    expect(gone.statusCode).toBe(404);

    const ownerA = await api(account, 'GET', `/api/v1/documents/${draftA.id}`);
    const ownerB = await api(account, 'GET', `/api/v1/documents/${draftB.id}`);
    expect(ownerA.statusCode).toBe(200);
    expect(ownerB.statusCode).toBe(200);
  });
});

describe('publish error contract', () => {
  it('returns 404 when the document does not exist', async () => {
    const account = await createAccount('pube');
    const res = await api(account, 'PATCH', `/api/v1/documents/${createId()}/publish`);

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Document not found');
  });

  it('returns 404 when the document belongs to another author', async () => {
    const owner = await createAccount('pubo');
    const other = await createAccount('pubx');
    const { id } = await createDraft(owner, `${SUB.publishErrors}Foreign`);

    const res = await api(other, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Document not found');
  });

  it('returns 400 when the document is already published', async () => {
    const account = await createAccount('pubd');
    const { id } = await createDraft(account, `${SUB.publishErrors}Already Published`);
    await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Document is already published');
  });

  it('returns 400 when the document has no content', async () => {
    const account = await createAccount('pubc');
    const { id } = await createDraft(account, `${SUB.publishErrors}No Content`, true, false);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Cannot publish empty document');
  });

  it('returns 400 when the document has no category', async () => {
    const account = await createAccount('pubg');
    const { id } = await createDraft(account, `${SUB.publishErrors}No Category`, false);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('A category is required to publish');
  });

  it('prefers the already-published error over the empty-content error', async () => {
    const account = await createAccount('pubp');
    const { id } = await createDraft(account, `${SUB.publishErrors}Published And Empty`);
    await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);
    await db.update(documents).set({ content: null }).where(eq(documents.id, id));

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.message).toBe('Document is already published');
  });

  it('prefers the empty-content error over the missing-category error', async () => {
    const account = await createAccount('pubq');
    const { id } = await createDraft(account, `${SUB.publishErrors}Empty And Uncategorised`, false, false);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.message).toBe('Cannot publish empty document');
  });

  it('prefers the ownership error over every other publish failure', async () => {
    const owner = await createAccount('pubr');
    const other = await createAccount('pubs');
    const { id } = await createDraft(owner, `${SUB.publishErrors}Foreign And Unpublishable`, false, false);

    const res = await api(other, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.message).toBe('Document not found');
  });

  it('publishes a document successfully', async () => {
    const account = await createAccount('pubv');
    const { id } = await createDraft(account, `${SUB.publishErrors}Happy Path`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { status: string; publishedAt: string | null; authorship: { publicIdentifier: string } | null };
    };
    expect(body.data.status).toBe('published');
    expect(body.data.publishedAt).toBeTruthy();
    expect(body.data.authorship?.publicIdentifier).toMatch(/^PLT-/);
  });
});

describe('document tags', () => {
  it('persists the tags of a document and returns them on the owner read', async () => {
    const account = await createAccount('tage');
    const tagA = `${SUB.tags}a`;
    const tagB = `${SUB.tags}b`;
    createdTagNames.push(tagA, tagB);

    const res = await api(account, 'POST', '/api/v1/documents', {
      title: `${SUB.tags}Tagged`,
      type: 'article',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      categoryId,
      tags: [tagA, tagB],
    });

    expect(res.statusCode).toBe(201);
    const id = (res.json() as { data: { id: string } }).data.id;
    createdDocumentIds.push(id);

    const read = await api(account, 'GET', `/api/v1/documents/${id}`);
    expect(read.statusCode).toBe(200);
    const body = read.json() as { data: { tags: { name: string }[] } };
    expect(body.data.tags.map((tag) => tag.name).sort()).toEqual([tagA, tagB].sort());
  });

  it('rejects more than five tags with a validation error', async () => {
    const account = await createAccount('tagf');
    const many = Array.from({ length: 6 }, (_, index) => `${SUB.tags}t${index + 1}`);
    createdTagNames.push(...many);

    const res = await api(account, 'POST', '/api/v1/documents', {
      title: `${SUB.tags}Too Many`,
      type: 'article',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      categoryId,
      tags: many,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields?.tags).toBeTruthy();
  });

  it('replaces the tag set on PATCH instead of appending to it', async () => {
    const account = await createAccount('tagr');
    const tagA = `${SUB.tags}ra`;
    const tagB = `${SUB.tags}rb`;
    const tagC = `${SUB.tags}rc`;
    createdTagNames.push(tagA, tagB, tagC);

    const created = await api(account, 'POST', '/api/v1/documents', {
      title: `${SUB.tags}Replaceable`,
      type: 'article',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      categoryId,
      tags: [tagA, tagB],
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    createdDocumentIds.push(id);

    const patched = await api(account, 'PATCH', `/api/v1/documents/${id}`, { tags: [tagC] });
    expect(patched.statusCode).toBe(200);

    const read = await api(account, 'GET', `/api/v1/documents/${id}`);
    expect(read.statusCode).toBe(200);
    const body = read.json() as { data: { tags: { name: string }[] } };
    expect(body.data.tags).toHaveLength(1);
    expect(body.data.tags.map((tag) => tag.name)).toEqual([tagC]);
  });
});

describe('feed sort order', () => {
  it('orders by popularity and by recency according to the sort parameter', async () => {
    const author = await createAccount('pope');
    const helperA = await createAccount('popv');
    const helperB = await createAccount('popw');
    const q = SUB.sort;

    const oldest = await createDraft(author, `${q}Oldest`);
    const middle = await createDraft(author, `${q}Middle`);
    const newest = await createDraft(author, `${q}Newest`);
    for (const doc of [oldest, middle, newest]) {
      const published = await api(author, 'PATCH', `/api/v1/documents/${doc.id}/publish`);
      expect(published.statusCode).toBe(200);
    }

    // Distinct publication timestamps, so "recent" is not a tie broken by id.
    const base = new Date('2026-01-01T00:00:00.000Z');
    await db.update(documents).set({ publishedAt: base }).where(eq(documents.id, oldest.id));
    await db
      .update(documents)
      .set({ publishedAt: new Date(base.getTime() + 60_000) })
      .where(eq(documents.id, middle.id));
    await db
      .update(documents)
      .set({ publishedAt: new Date(base.getTime() + 120_000) })
      .where(eq(documents.id, newest.id));

    // Distinct like counts, so "popular" is not a tie broken by id.
    await db.insert(documentLikes).values([
      { id: createId(), profileId: author.profileId, documentId: oldest.id },
      { id: createId(), profileId: helperA.profileId, documentId: oldest.id },
      { id: createId(), profileId: helperB.profileId, documentId: oldest.id },
      { id: createId(), profileId: author.profileId, documentId: middle.id },
    ]);

    const recent = await api(
      null,
      'GET',
      `/api/v1/documents?q=${encodeURIComponent(q)}&sort=recent&limit=10`
    );
    expect(recent.statusCode).toBe(200);
    const recentBody = recent.json() as FeedBody;
    expect(recentBody.data.items.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);

    const popular = await api(
      null,
      'GET',
      `/api/v1/documents?q=${encodeURIComponent(q)}&sort=popular&limit=10`
    );
    expect(popular.statusCode).toBe(200);
    const popularBody = popular.json() as FeedBody;
    expect(popularBody.data.items.map((item) => item.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(popularBody.data.items.map((item) => item.likesCount)).toEqual([3, 1, 0]);
  });
});

describe('slug lifecycle', () => {
  it('suffixes a duplicated title slug with -1', async () => {
    const account = await createAccount('slge');
    const title = `${SUB.slug}Repeat Title`;

    const first = await createDraft(account, title);
    const second = await createDraft(account, title);

    expect(first.res.statusCode).toBe(201);
    expect(second.res.statusCode).toBe(201);
    expect(first.slug).toBe(`${SUB.slug}repeat-title`);
    expect(second.slug).toBe(`${SUB.slug}repeat-title-1`);
  });

  it('regenerates the slug from the new title while the document is a draft', async () => {
    const account = await createAccount('slgr');
    const { id, slug } = await createDraft(account, `${SUB.slug}First Title`);
    expect(slug).toBe(`${SUB.slug}first-title`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      title: `${SUB.slug}Second Title`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { title: string; slug: string } };
    expect(body.data.title).toBe(`${SUB.slug}Second Title`);
    expect(body.data.slug).toBe(`${SUB.slug}second-title`);
  });

  it('keeps the slug when the title of a published document changes', async () => {
    const account = await createAccount('slgp');
    const { id, slug } = await createDraft(account, `${SUB.slug}Published Title`);
    const published = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      title: `${SUB.slug}Renamed Title`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { title: string; slug: string } };
    expect(body.data.title).toBe(`${SUB.slug}Renamed Title`);
    expect(body.data.slug).toBe(slug);
  });

  it('transliterates accents on create instead of dropping them', async () => {
    const account = await createAccount('slga');
    const cases: [string, string][] = [
      [
        'Do rascunho à leitura pública: o ciclo de vida',
        'do-rascunho-a-leitura-publica-o-ciclo-de-vida',
      ],
      ['Escrever é voltar ao começo', 'escrever-e-voltar-ao-comeco'],
      ['O primeiro minuto: uma análise', 'o-primeiro-minuto-uma-analise'],
      ['Ação ç ñ ü straße', 'acao-c-n-u-strasse'],
    ];

    for (const [title, expected] of cases) {
      const { slug, res } = await createDraft(account, title);
      expect(res.statusCode).toBe(201);
      expect(slug).toBe(expected);
    }
  });

  it('suffixes a duplicated accented title with -1', async () => {
    const account = await createAccount('slgd');

    const first = await createDraft(account, 'Ação ç ñ ü straße');
    const second = await createDraft(account, 'Ação ç ñ ü straße');

    expect(first.slug).toBe('acao-c-n-u-strasse');
    expect(second.slug).toBe('acao-c-n-u-strasse-1');
  });

  it('keeps a symbols-only title deterministic', async () => {
    const account = await createAccount('slgs');

    const { slug, res } = await createDraft(account, '!!! ???');

    expect(res.statusCode).toBe(201);
    expect(slug).toBe('-');
  });

  it('regenerates an accented slug from the new draft title', async () => {
    const account = await createAccount('slgr2');
    const { id, slug } = await createDraft(account, 'Escrever é voltar ao começo');
    expect(slug).toBe('escrever-e-voltar-ao-comeco');

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      title: 'Uma análise pública',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { slug: string } };
    expect(body.data.slug).toBe('uma-analise-publica');
  });

  it('keeps an accented slug when the title of a published document changes', async () => {
    const account = await createAccount('slgp2');
    const { id, slug } = await createDraft(account, 'Análise pública');
    expect(slug).toBe('analise-publica');

    const published = await api(account, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      title: 'Começo diferente',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { title: string; slug: string } };
    expect(body.data.title).toBe('Começo diferente');
    expect(body.data.slug).toBe(slug);
  });

  it('rejects an unknown document type on create', async () => {
    const account = await createAccount('slgt');

    const res = await api(account, 'POST', '/api/v1/documents', {
      title: `${SUB.slug}Bad Type`,
      type: 'not-a-real-type',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid document type');
  });
});

describe('write atomicity', () => {
  it('rejects a create with an unknown category with 404 and creates no rows', async () => {
    const account = await createAccount('atcc');
    const unknownCategoryId = createId();
    const title = `${PREFIX}Atomic Create`;

    const res = await api(account, 'POST', '/api/v1/documents', {
      title,
      type: 'article',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      categoryId: unknownCategoryId,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Category not found');

    // The counts are scoped to this author's rows: the integration files
    // share the same database and run in parallel, so a global count would
    // race with the documents another file is creating.
    expect(await countDocumentsByAuthor(account.profileId)).toBe(0);
    expect(await countStylesByAuthor(account.profileId)).toBe(0);
    expect(await countCategoriesByAuthor(account.profileId)).toBe(0);
  });

  it('leaves the document untouched when an update carries an unknown category', async () => {
    const account = await createAccount('atcu');
    const { id } = await createDraft(account, `${PREFIX}Atomic Update`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      title: `${PREFIX}Atomic Update Renamed`,
      categoryId: createId(),
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Category not found');

    expect(await countDocumentsByAuthor(account.profileId)).toBe(1);
    expect(await countStylesByAuthor(account.profileId)).toBe(1);
    expect(await countCategoriesByAuthor(account.profileId)).toBe(1);

    const read = await api(account, 'GET', `/api/v1/documents/${id}`);
    const readBody = read.json() as { data: { title: string } };
    expect(readBody.data.title).toBe(`${PREFIX}Atomic Update`);
  });
});
