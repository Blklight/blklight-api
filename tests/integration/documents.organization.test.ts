import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.development', override: true });
const SQL_URL = process.env.DATABASE_URL ?? '';

/**
 * End-to-end integration tests for the link between documents and
 * organizations.
 *
 * The behaviour under test is the contract between route, Zod validation,
 * service and SQL, so the suite drives the real HTTP surface (`app.inject`)
 * against the real dev database. Every row created here is namespaced with a
 * per-run prefix and hard-deleted in afterAll, so the suite leaves the
 * database byte-identical.
 */
vi.mock('../../src/config/env', async () => {
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
import { documentLikes } from '../../src/features/likes/likes.schema';
import {
  organizations,
  organizationMembers,
} from '../../src/features/organizations/organizations.schema';
import {
  createOrganization as createOrganizationService,
  inviteMember,
  decideMembership,
} from '../../src/features/organizations/organizations.service';
import {
  emailVerifications,
  passwordResets,
  emailQueue,
} from '../../src/features/email/email.schema';
import type { FastifyInstance } from 'fastify';

const sql = postgres(SQL_URL, { max: 1 });

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `itest-${RUN_ID}-`;

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
  'document_likes',
  'categories',
  'organizations',
  'organization_members',
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
const createdOrganizationIds: string[] = [];
const createdEmails: string[] = [];
let categoryId = '';

interface Account {
  userId: string;
  profileId: string;
  username: string;
  email: string;
  token: string;
}

interface Organization {
  id: string;
  orgname: string;
  name: string;
}

function makeUsername(label: string): string {
  return `${PREFIX}${label}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
}

/**
 * Orgname generator. The orgname is unique per run and per call, so two
 * fixtures can never collapse into the same one through truncation.
 */
let orgnameSeq = 0;

function makeOrgname(): string {
  orgnameSeq += 1;
  return `t${RUN_ID}${orgnameSeq.toString(36)}`.slice(0, 30);
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

/**
 * Create an organization fixture through the service, so the fixture follows
 * the same path a real user takes (owner + accepted owner membership in one
 * go) without burning the route's 10/hour rate limit on the setup.
 */
async function createOrganization(
  owner: Account,
  label: string,
  isPrivate = false
): Promise<Organization> {
  const org = await createOrganizationService(owner.profileId, {
    name: `${PREFIX}${label}`,
    orgname: makeOrgname(),
    isPrivate,
  });
  createdOrganizationIds.push(org.id);
  return { id: org.id, orgname: org.orgname, name: org.name };
}

/**
 * Invite a profile and accept the invite, producing an accepted membership.
 */
async function acceptMembership(org: Organization, owner: Account, member: Account): Promise<void> {
  await inviteMember(org.id, owner.profileId, member.profileId);
  await decideMembership(org.id, member.profileId, 'accepted');
}

async function createDraft(
  account: Account,
  title: string,
  options: { organizationId?: string | null; withCategory?: boolean; withContent?: boolean } = {}
) {
  const res = await api(account, 'POST', '/api/v1/documents', {
    title,
    type: 'article',
    ...(options.withContent === false
      ? {}
      : { content: { type: 'doc', content: [{ type: 'paragraph' }] } }),
    ...(options.withCategory === false ? {} : { categoryId }),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
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
  const runOrganizations = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.name, `${PREFIX}%`));
  const organizationIds = runOrganizations.map((row) => row.id);

  if (organizationIds.length > 0) {
    await db.delete(organizationMembers).where(inArray(organizationMembers.orgId, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  }

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
        await db.delete(documentCategories).where(inArray(documentCategories.documentId, documentIds));
        await db.delete(documentStyles).where(inArray(documentStyles.documentId, documentIds));
        await db.delete(documents).where(inArray(documents.id, documentIds));
      }

      await db.delete(profiles).where(inArray(profiles.id, profileIds));
    }

    await db.delete(users).where(inArray(users.id, userIds));
  }

  // The category and the queued emails created by the run carry the prefix.
  await db.delete(categories).where(like(categories.name, `${PREFIX}%`));
  await db.delete(emailQueue).where(like(emailQueue.to, `${PREFIX}%`));

  const after = await tableCounts();
  const diff: Record<string, { before: number; after: number }> = {};
  for (const table of COUNTED_TABLES) {
    if (after[table] !== baselineCounts[table]) {
      diff[table] = { before: baselineCounts[table]!, after: after[table]! };
    }
  }
  console.log('[itest-org] table counts before:', JSON.stringify(baselineCounts));
  console.log('[itest-org] table counts after :', JSON.stringify(after));
  console.log('[itest-org] count diff          :', JSON.stringify(diff));

  expect(await countBy('users', 'id', createdUserIds)).toBe(0);
  expect(await countBy('profiles', 'id', createdProfileIds)).toBe(0);
  expect(await countBy('documents', 'id', createdDocumentIds)).toBe(0);
  expect(await countBy('workspaces', 'id', createdWorkspaceIds)).toBe(0);
  expect(await countBy('canvas', 'id', createdCanvasIds)).toBe(0);
  expect(await countBy('sessions', 'user_id', createdUserIds)).toBe(0);
  expect(await countBy('signatures', 'user_id', createdUserIds)).toBe(0);
  expect(await countBy('categories', 'id', createdCategoryIds)).toBe(0);
  expect(await countBy('organizations', 'id', createdOrganizationIds)).toBe(0);
  expect(await countBy('organization_members', 'org_id', createdOrganizationIds)).toBe(0);

  // The prefix is the source of truth for the cleanup, so it is also the
  // source of truth for the leak check: a row the tracking arrays missed
  // still has to be gone.
  expect(await countRows('select count(*)::int as c from users where email like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from profiles where username like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from categories where name like $1', [`${PREFIX}%`])).toBe(0);
  expect(await countRows('select count(*)::int as c from organizations where name like $1', [`${PREFIX}%`])).toBe(0);

  if (STRICT_COUNTS) {
    const equal = await waitForCountsToEqual(baselineCounts, 15_000);
    if (!equal) {
      console.error('[itest-org] strict count mismatch:', JSON.stringify(await tableCounts()));
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
 * Exact number of documents currently linked to an organization.
 */
async function countDocumentsInOrg(orgId: string): Promise<number> {
  const rows = await sql.unsafe(
    'select count(*)::int as c from documents where organization_id = $1',
    [orgId]
  );
  return rows[0]!.c as number;
}

interface FeedBody {
  data: {
    items: { id: string; organization: { id: string; orgname: string; name: string } | null }[];
    nextCursor: string | null;
    total: number;
  };
}

interface ErrorBody {
  data: null;
  error: { code: string; message: string; fields?: Record<string, string> };
  message: string;
}

describe('organization link on write', () => {
  it('links a document to an organization when the author is an accepted member', async () => {
    const owner = await createAccount('ownm');
    const member = await createAccount('memm');
    const org = await createOrganization(owner, 'Member Org');
    await acceptMembership(org, owner, member);

    const { id, res } = await createDraft(member, `${PREFIX}Linked Doc`, {
      organizationId: org.id,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; organization: { id: string; orgname: string } | null } };
    expect(body.data.organization?.id).toBe(org.id);
    expect(body.data.organization?.orgname).toBe(org.orgname);

    const read = await api(member, 'GET', `/api/v1/documents/${id}`);
    const readBody = read.json() as { data: { organization: { id: string } | null } };
    expect(readBody.data.organization?.id).toBe(org.id);
  });

  it('accepts the orgname as a reference for the organization', async () => {
    const owner = await createAccount('ownn');
    const member = await createAccount('memn');
    const org = await createOrganization(owner, 'Orgname Org');
    await acceptMembership(org, owner, member);

    const { res } = await createDraft(member, `${PREFIX}By Orgname`, {
      organizationId: org.orgname,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { organization: { id: string } | null } };
    expect(body.data.organization?.id).toBe(org.id);
  });

  it('rejects a create from a non-member with 403', async () => {
    const owner = await createAccount('ownf');
    const outsider = await createAccount('memf');
    const org = await createOrganization(owner, 'Forbidden Org');

    const { res } = await createDraft(outsider, `${PREFIX}Forbidden Doc`, {
      organizationId: org.id,
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('You must be a member of this organization');
  });

  it('rejects a create with an unknown organization with 404', async () => {
    const account = await createAccount('ownx');

    const { res } = await createDraft(account, `${PREFIX}Unknown Org Doc`, {
      organizationId: 'does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Organization not found');
  });

  it('changes the organization of a draft document', async () => {
    const owner = await createAccount('ownc');
    const member = await createAccount('memc');
    const orgA = await createOrganization(owner, 'change org a');
    const orgB = await createOrganization(owner, 'change org b');
    await acceptMembership(orgA, owner, member);
    await acceptMembership(orgB, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Changeable`, { organizationId: orgA.id });

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: orgB.id });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { organization: { id: string } | null } };
    expect(body.data.organization?.id).toBe(orgB.id);
  });

  it('clears the organization of a draft document with null', async () => {
    const owner = await createAccount('ownn2');
    const member = await createAccount('memn2');
    const org = await createOrganization(owner, 'Clear Org');
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Clearable`, { organizationId: org.id });

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: null });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { organization: { id: string } | null } };
    expect(body.data.organization).toBeNull();
  });

  it('changes the organization of a published document', async () => {
    const owner = await createAccount('ownp');
    const member = await createAccount('memp');
    const orgA = await createOrganization(owner, 'Published Org A');
    const orgB = await createOrganization(owner, 'Published Org B');
    await acceptMembership(orgA, owner, member);
    await acceptMembership(orgB, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Published Then Change`, {
      organizationId: orgA.id,
    });
    const published = await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: orgB.id });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { organization: { id: string } | null } };
    expect(body.data.organization?.id).toBe(orgB.id);

    expect(await countDocumentsInOrg(orgA.id)).toBe(0);
    expect(await countDocumentsInOrg(orgB.id)).toBe(1);
  });

  it('clears the organization of a published document with null', async () => {
    const owner = await createAccount('owncl');
    const member = await createAccount('memcl');
    const org = await createOrganization(owner, 'Published Clear Org');
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Published Then Clear`, {
      organizationId: org.id,
    });
    const published = await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: null });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { organization: { id: string } | null } };
    expect(body.data.organization).toBeNull();

    expect(await countDocumentsInOrg(org.id)).toBe(0);
  });

  it('rejects a change to an organization without membership with 403', async () => {
    const owner = await createAccount('ownf2');
    const member = await createAccount('memf2');
    const orgA = await createOrganization(owner, 'Kept Org');
    const orgB = await createOrganization(owner, 'Forbidden Change Org');
    await acceptMembership(orgA, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Forbidden Change`, {
      organizationId: orgA.id,
    });
    const published = await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: orgB.id });
    expect(res.statusCode).toBe(403);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('You must be a member of this organization');

    const read = await api(member, 'GET', `/api/v1/documents/${id}`);
    const readBody = read.json() as { data: { organization: { id: string } | null } };
    expect(readBody.data.organization?.id).toBe(orgA.id);

    expect(await countDocumentsInOrg(orgA.id)).toBe(1);
    expect(await countDocumentsInOrg(orgB.id)).toBe(0);
  });

  it('rejects a change to an organization without membership on a draft with 403', async () => {
    const owner = await createAccount('ownf3');
    const member = await createAccount('memf3');
    const orgA = await createOrganization(owner, 'Draft Kept Org');
    const orgB = await createOrganization(owner, 'Draft Forbidden Org');
    await acceptMembership(orgA, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Draft Forbidden Change`, {
      organizationId: orgA.id,
    });

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: orgB.id });
    expect(res.statusCode).toBe(403);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('FORBIDDEN');

    expect(await countDocumentsInOrg(orgA.id)).toBe(1);
    expect(await countDocumentsInOrg(orgB.id)).toBe(0);
  });

  it('accepts an autosave that resends the current organization after the membership was revoked', async () => {
    const owner = await createAccount('ownrs');
    const member = await createAccount('memrs');
    const org = await createOrganization(owner, 'Revoked Autosave Org');
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Revoked Autosave`, {
      organizationId: org.id,
    });
    const published = await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(published.statusCode).toBe(200);

    const removed = await api(owner, 'DELETE', `/api/v1/organizations/${org.id}/members/${member.profileId}`);
    expect(removed.statusCode).toBe(200);

    const byId = await api(member, 'PATCH', `/api/v1/documents/${id}`, { organizationId: org.id });
    expect(byId.statusCode).toBe(200);
    const byIdBody = byId.json() as { data: { organization: { id: string } | null } };
    expect(byIdBody.data.organization?.id).toBe(org.id);

    const byOrgname = await api(member, 'PATCH', `/api/v1/documents/${id}`, {
      organizationId: org.orgname,
    });
    expect(byOrgname.statusCode).toBe(200);
    const byOrgnameBody = byOrgname.json() as { data: { organization: { id: string } | null } };
    expect(byOrgnameBody.data.organization?.id).toBe(org.id);

    expect(await countDocumentsInOrg(org.id)).toBe(1);
  });

  it('rejects a change to an unknown organization with 404', async () => {
    const account = await createAccount('ownx2');

    const { id } = await createDraft(account, `${PREFIX}Unknown Org Change`);

    const res = await api(account, 'PATCH', `/api/v1/documents/${id}`, {
      organizationId: 'does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Organization not found');
  });

  it('rejects the publish with 403 when the author lost the membership', async () => {
    const owner = await createAccount('ownr');
    const member = await createAccount('memr');
    const org = await createOrganization(owner, 'Revoked Org');
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Revoked Publish`, { organizationId: org.id });

    const removed = await api(owner, 'DELETE', `/api/v1/organizations/${org.id}/members/${member.profileId}`);
    expect(removed.statusCode).toBe(200);

    const res = await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
    expect(res.statusCode).toBe(403);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('FORBIDDEN');

    const read = await api(member, 'GET', `/api/v1/documents/${id}`);
    const readBody = read.json() as { data: { status: string } };
    expect(readBody.data.status).toBe('draft');
  });
});

describe('organization reference on reads', () => {
  it('exposes the organization on the public read and on the feed', async () => {
    const owner = await createAccount('ownr2');
    const member = await createAccount('memr2');
    const org = await createOrganization(owner, 'Read Org');
    await acceptMembership(org, owner, member);

    const { id, slug } = await createDraft(member, `${PREFIX}Readable Org Doc`, {
      organizationId: org.id,
    });
    await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);

    const publicRead = await api(null, 'GET', `/api/v1/documents/${member.username}/${slug}`);
    expect(publicRead.statusCode).toBe(200);
    const readBody = publicRead.json() as { data: { organization: { id: string; orgname: string; name: string } | null } };
    expect(readBody.data.organization?.id).toBe(org.id);
    expect(readBody.data.organization?.orgname).toBe(org.orgname);
    expect(readBody.data.organization?.name).toBe(org.name);

    const feed = await api(null, 'GET', `/api/v1/documents?organization=${encodeURIComponent(org.orgname)}`);
    expect(feed.statusCode).toBe(200);
    const feedBody = feed.json() as FeedBody;
    expect(feedBody.data.items.map((item) => item.id)).toEqual([id]);
    expect(feedBody.data.items[0]!.organization?.id).toBe(org.id);
  });

  it('keeps the link but hides the organization of a private org from the public', async () => {
    const owner = await createAccount('ownp2');
    const member = await createAccount('memp2');
    const org = await createOrganization(owner, 'Private Read Org', true);
    await acceptMembership(org, owner, member);

    const { id, slug } = await createDraft(member, `${PREFIX}Private Org Doc`, {
      organizationId: org.id,
    });
    await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);

    const publicRead = await api(null, 'GET', `/api/v1/documents/${member.username}/${slug}`);
    expect(publicRead.statusCode).toBe(200);
    const readBody = publicRead.json() as { data: { organization: { id: string } | null } };
    expect(readBody.data.organization).toBeNull();

    // The author still sees it on their own read.
    const ownerRead = await api(member, 'GET', `/api/v1/documents/${id}`);
    const ownerBody = ownerRead.json() as { data: { organization: { id: string } | null } };
    expect(ownerBody.data.organization?.id).toBe(org.id);
  });

  it('keeps the link after the author leaves the organization', async () => {
    const owner = await createAccount('ownl');
    const member = await createAccount('meml');
    const org = await createOrganization(owner, 'Leave Org');
    await acceptMembership(org, owner, member);

    const { id, slug } = await createDraft(member, `${PREFIX}Left Org Doc`, {
      organizationId: org.id,
    });
    await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);

    const removed = await api(owner, 'DELETE', `/api/v1/organizations/${org.id}/members/${member.profileId}`);
    expect(removed.statusCode).toBe(200);

    const publicRead = await api(null, 'GET', `/api/v1/documents/${member.username}/${slug}`);
    expect(publicRead.statusCode).toBe(200);
    const readBody = publicRead.json() as { data: { organization: { id: string } | null } };
    expect(readBody.data.organization?.id).toBe(org.id);
  });
});

describe('organization document listing', () => {
  it('lists the published documents of an organization with an exact total', async () => {
    const owner = await createAccount('ownl2');
    const member = await createAccount('meml2');
    const org = await createOrganization(owner, 'Listing Org');
    await acceptMembership(org, owner, member);

    const published = await createDraft(member, `${PREFIX}Listed Doc`, { organizationId: org.id });
    await api(member, 'PATCH', `/api/v1/documents/${published.id}/publish`);
    await createDraft(member, `${PREFIX}Unlisted Draft`, { organizationId: org.id });

    const res = await api(null, 'GET', `/api/v1/org/${org.orgname}/documents`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as FeedBody;
    expect(body.data.total).toBe(1);
    expect(body.data.items.map((item) => item.id)).toEqual([published.id]);
    expect(body.data.items[0]!.organization?.id).toBe(org.id);
  });

  it('paginates the organization listing with a cursor', async () => {
    const owner = await createAccount('ownl3');
    const member = await createAccount('meml3');
    const org = await createOrganization(owner, 'Cursor Org');
    await acceptMembership(org, owner, member);

    const docs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { id } = await createDraft(member, `${PREFIX}Cursor Doc ${i}`, { organizationId: org.id });
      await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);
      docs.push(id);
    }

    const first = await api(null, 'GET', `/api/v1/org/${org.orgname}/documents?limit=1`);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as FeedBody;
    expect(firstBody.data.total).toBe(3);
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.nextCursor).toBeTruthy();

    const second = await api(
      null,
      'GET',
      `/api/v1/org/${org.orgname}/documents?limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor!)}`
    );
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as FeedBody;
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.items[0]!.id).not.toBe(firstBody.data.items[0]!.id);
  });

  it('answers 404 for an unknown organization', async () => {
    const res = await api(null, 'GET', '/api/v1/org/there-is-no-such-org/documents');
    expect(res.statusCode).toBe(404);
    const body = res.json() as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('answers 404 for a private organization to a non-member', async () => {
    const owner = await createAccount('ownl4');
    const outsider = await createAccount('meml4');
    const org = await createOrganization(owner, 'Private Listing Org', true);

    const anonymous = await api(null, 'GET', `/api/v1/org/${org.orgname}/documents`);
    const stranger = await api(outsider, 'GET', `/api/v1/org/${org.orgname}/documents`);

    expect(anonymous.statusCode).toBe(404);
    expect(stranger.statusCode).toBe(404);
    expect(anonymous.body).toBe(stranger.body);
  });

  it('answers 404 for a private organization to a pending member', async () => {
    const owner = await createAccount('ownl5');
    const pending = await createAccount('meml5');
    const org = await createOrganization(owner, 'Pending Listing Org', true);

    const invite = await inviteMember(org.id, owner.profileId, pending.profileId);
    expect(invite.status).toBe('pending');

    const res = await api(pending, 'GET', `/api/v1/org/${org.orgname}/documents`);
    expect(res.statusCode).toBe(404);
  });

  it('lists the documents of a private organization to its accepted members', async () => {
    const owner = await createAccount('ownl6');
    const member = await createAccount('meml6');
    const org = await createOrganization(owner, 'Private Member Org', true);
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Private Listed Doc`, { organizationId: org.id });
    await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);

    const res = await api(member, 'GET', `/api/v1/org/${org.orgname}/documents`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as FeedBody;
    expect(body.data.total).toBe(1);
    expect(body.data.items.map((item) => item.id)).toEqual([id]);
  });

  it('excludes the documents of a private author from the organization listing', async () => {
    const owner = await createAccount('ownl7');
    const member = await createAccount('meml7');
    const org = await createOrganization(owner, 'Private Author Org');
    await acceptMembership(org, owner, member);

    const { id } = await createDraft(member, `${PREFIX}Private Author Doc`, { organizationId: org.id });
    await api(member, 'PATCH', `/api/v1/documents/${id}/publish`);

    const before = await api(null, 'GET', `/api/v1/org/${org.orgname}/documents`);
    const beforeBody = before.json() as FeedBody;
    expect(beforeBody.data.total).toBe(1);

    await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.id, member.profileId));

    const anonymous = await api(null, 'GET', `/api/v1/org/${org.orgname}/documents`);
    const anonymousBody = anonymous.json() as FeedBody;
    expect(anonymousBody.data.total).toBe(0);
    expect(anonymousBody.data.items).toHaveLength(0);

    const author = await api(member, 'GET', `/api/v1/org/${org.orgname}/documents`);
    const authorBody = author.json() as FeedBody;
    expect(authorBody.data.total).toBe(1);
    expect(authorBody.data.items.map((item) => item.id)).toEqual([id]);
  });
});

describe('organization membership lifecycle', () => {
  it('lets a manager invite again after the profile rejected the first invite', async () => {
    const owner = await createAccount('reinvown');
    const target = await createAccount('reinvtgt');
    const org = await createOrganization(owner, 'Reinvite Org');

    await inviteMember(org.id, owner.profileId, target.profileId);
    await decideMembership(org.id, target.profileId, 'rejected');

    const reinvite = await api(owner, 'POST', `/api/v1/organizations/${org.id}/invite`, {
      profileId: target.profileId,
    });
    expect(reinvite.statusCode).toBeLessThan(300);

    const accepted = await decideMembership(org.id, target.profileId, 'accepted');
    expect(accepted.status).toBe('accepted');
  });

  it('lets a member leave, but not the owner', async () => {
    const owner = await createAccount('leaveown');
    const member = await createAccount('leavemem');
    const org = await createOrganization(owner, 'Leave Self Org');
    await acceptMembership(org, owner, member);

    const left = await api(member, 'DELETE', `/api/v1/organizations/${org.id}/members/me`);
    expect(left.statusCode).toBe(200);

    const ownerLeave = await api(owner, 'DELETE', `/api/v1/organizations/${org.id}/members/me`);
    expect(ownerLeave.statusCode).toBe(403);
  });
});
