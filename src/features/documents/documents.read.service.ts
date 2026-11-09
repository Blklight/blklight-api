import { eq, and, isNull, desc, lt, or, ilike, count, sql, exists, inArray, ne, type SQL } from 'drizzle-orm';
import { db } from '../../db/index';
import { documents, documentTypes, documentStyles } from './documents.schema';
import { profiles } from '../profiles/profiles.schema';
import { users } from '../auth/auth.schema';
import { categories, documentCategories } from '../categories/categories.schema';
import { tags as tagsTable, documentTags } from '../tags/tags.schema';
import { NotFoundError } from '../../utils/errors';
import { encodeCursor, decodeCursor, encodeFeedCursor, decodeFeedCursor } from '../../utils/cursor';
import { getLikesCount } from '../likes/likes.service';
import { getFollowStatus } from '../follows/follows.service';
import { follows } from '../follows/follows.schema';
import { getDocumentTags } from '../tags/tags.service';
import { getDocumentCategory } from '../categories/categories.service';
import { getExercises } from '../tutorial-exercises/tutorial-exercises.service';
import {
  resolveOrganizationForViewer,
  getOrganizationByOrgname,
  mapOrganization,
  type OrganizationRef,
} from '../organizations/organizations.service';
import { organizations } from '../organizations/organizations.schema';
import { matchUsername } from '../../utils/username';
import type { Authorship } from './documents.service';

/**
 * Resolve whether a document's author profile is visible to the viewer under
 * the product privacy rule. A non-private author is always visible. A private
 * author is only visible to the author themselves or to a viewer with an
 * accepted follow. Mirrors the logic in getPublicProfile / getFollowers.
 * @param authorProfileId - The profile ID of the document's author
 * @param authorIsPrivate - Whether the author's profile is private
 * @param viewerProfileId - Optional viewer's profile ID (from JWT)
 * @returns True when the viewer may see documents from this author
 */
async function canViewAuthor(
  authorProfileId: string,
  authorIsPrivate: boolean,
  viewerProfileId?: string
): Promise<boolean> {
  if (!authorIsPrivate) {
    return true;
  }

  if (!viewerProfileId) {
    return false;
  }

  if (viewerProfileId === authorProfileId) {
    return true;
  }

  return (await getFollowStatus(viewerProfileId, authorProfileId)) === 'accepted';
}

/**
 * Build the SQL condition that hides documents from private authors the viewer
 * is not allowed to see. Applied inside the shared `conditions` list (not only
 * the page query) so the feed's `total` count matches the visible result set.
 * @param viewerProfileId - Optional viewer's profile ID (from JWT)
 * @returns SQL condition to AND into the feed queries
 */
function buildAuthorVisibilityCondition(viewerProfileId?: string): SQL {
  const publicAuthor = ne(profiles.isPrivate, true);

  if (!viewerProfileId) {
    return publicAuthor;
  }

  const followsAuthor = exists(
    db
      .select({ matches: sql`1` })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewerProfileId),
          eq(follows.followingId, documents.authorId),
          eq(follows.status, 'accepted')
        )!
      )
  );

  return or(publicAuthor, eq(documents.authorId, viewerProfileId), followsAuthor)!;
}

export interface FeedParams {
  cursor?: string;
  limit?: number;
  type?: string;
  author?: string;
  q?: string;
  sort?: 'recent' | 'popular';
  category?: string;
  tag?: string;
  organization?: string;
}

export interface FeedResult {
  items: DocumentCard[];
  nextCursor: string | null;
  total: number;
}

export interface DocumentCard {
  id: string;
  title: string;
  abstract: string | null;
  coverImageUrl: string | null;
  slug: string;
  publishedAt: Date;
  typeName: string;
  author: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  authorship: {
    publicIdentifier: string;
  };
  likesCount: number;
  category: {
    id: string;
    name: string;
    slug: string;
  } | null;
  tags: {
    id: string;
    name: string;
    slug: string;
  }[];
  organization: OrganizationRef | null;
}

export interface AuthorFeedParams {
  cursor?: string;
  limit?: number;
  type?: string;
}

export interface OrganizationFeedParams {
  cursor?: string;
  limit?: number;
  type?: string;
  sort?: 'recent' | 'popular';
}

export interface DocumentFull {
  id: string;
  title: string;
  abstract: string | null;
  content: Record<string, unknown> | null;
  coverImageUrl: string | null;
  slug: string;
  publishedAt: Date;
  typeName: string;
  author: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  style: {
    typography: string;
    paperStyle: Record<string, unknown> | null;
    paperTexture: Record<string, unknown> | null;
    coverSettings: Record<string, unknown> | null;
    documentHeader: Record<string, unknown> | null;
    documentFooter: Record<string, unknown> | null;
    documentSignature: Record<string, unknown> | null;
  };
  authorship: Authorship;
  likes: {
    likesCount: number;
    likedByMe: boolean | null;
  };
  category: {
    id: string;
    name: string;
    slug: string;
  } | null;
  tags: {
    id: string;
    name: string;
    slug: string;
  }[];
  organization: OrganizationRef | null;
  exercises?: unknown[];
}

/**
 * Get public feed of published documents with cursor-based pagination.
 * Documents from private authors are only included when the viewer is that
 * author or an accepted follower; anonymous visitors never see them.
 * @param params - Feed parameters (cursor, limit, type, author, q, sort, category, tag, organization)
 * @param viewerProfileId - Optional viewer's profile ID (from JWT)
 * @returns Feed result with items, nextCursor, and total count
 * @throws NotFoundError if the requested organization does not exist or is not visible to the viewer
 */
export async function getPublicFeed(params: FeedParams, viewerProfileId?: string): Promise<FeedResult> {
  const limit = Math.min(params.limit ?? 20, 50);
  const sort = params.sort ?? 'recent';
  const conditions: SQL[] = [];

  conditions.push(eq(documents.status, 'published'));
  conditions.push(isNull(documents.deletedAt));
  conditions.push(buildAuthorVisibilityCondition(viewerProfileId));

  if (params.organization) {
    // A private organization is invisible to non-members, and a missing one is
    // answered with the very same 404 so existence is never leaked.
    const org = await resolveOrganizationForViewer(params.organization, viewerProfileId);
    conditions.push(eq(documents.organizationId, org.id));
  }

  if (params.type) {
    conditions.push(eq(documentTypes.name, params.type));
  }

  if (params.author) {
    conditions.push(matchUsername(profiles.username, params.author));
  }

  if (params.category) {
    conditions.push(eq(categories.slug, params.category));
  }

  if (params.tag) {
    const tagSlug = params.tag;
    conditions.push(
      exists(
        db
          .select({ matches: sql`1` })
          .from(documentTags)
          .innerJoin(tagsTable, eq(documentTags.tagId, tagsTable.id))
          .where(and(eq(documentTags.documentId, documents.id), eq(tagsTable.slug, tagSlug))!)
      )
    );
  }

  if (params.q) {
    const searchPattern = `%${params.q}%`;
    conditions.push(
      or(
        ilike(documents.title, searchPattern),
        ilike(documents.abstract, searchPattern)
      )!
    );
  }

  return runDocumentFeed({
    conditions,
    sort,
    limit,
    cursor: params.cursor,
    viewerProfileId,
  });
}

/**
 * Run a document feed query: one keyset page plus the total size of the whole
 * filtered set. Shared by the public feed and the organization listing so both
 * paginate and count with the exact same rules.
 * @param options - Conditions, ordering, page size, cursor and optional viewer
 * @returns Feed result with items, nextCursor, and total count
 */
async function runDocumentFeed(options: {
  conditions: SQL[];
  sort: 'recent' | 'popular';
  limit: number;
  cursor?: string;
  viewerProfileId?: string;
}): Promise<FeedResult> {
  const { conditions, sort, limit, cursor, viewerProfileId } = options;

  const likesSubquery = sql<number>`(SELECT COUNT(*) FROM document_likes WHERE document_id = ${documents.id})`;

  // Keyset page condition is applied only to the page query — the count below
  // must reflect the whole filtered set, not "everything after the cursor".
  const pageConditions = [...conditions];

  if (cursor) {
    const decoded = decodeFeedCursor(cursor);
    // A cursor from another sort mode cannot be used as a keyset here; ignoring it
    // would silently restart pagination, so a mismatch serves the first page and
    // the client is expected to restart with the matching sort.
    if (decoded.sort === sort) {
      if (decoded.sort === 'popular') {
        pageConditions.push(
          or(
            lt(likesSubquery, decoded.likesCount),
            and(eq(likesSubquery, decoded.likesCount), lt(documents.id, decoded.id))
          )!
        );
      } else {
        pageConditions.push(
          or(
            lt(documents.publishedAt, decoded.publishedAt),
            and(eq(documents.publishedAt, decoded.publishedAt), lt(documents.id, decoded.id))
          )!
        );
      }
    }
  }

  const results = await db
    .select({
      id: documents.id,
      title: documents.title,
      abstract: documents.abstract,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      publishedAt: documents.publishedAt,
      typeName: documentTypes.name,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      authorship: documents.authorship,
      likesCount: likesSubquery,
      categoryId: documentCategories.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      authorProfileId: profiles.id,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .innerJoin(users, eq(profiles.userId, users.id))
    .leftJoin(documentCategories, eq(documents.id, documentCategories.documentId))
    .leftJoin(categories, eq(documentCategories.categoryId, categories.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(...pageConditions))
    .orderBy(sort === 'popular' ? desc(likesSubquery) : desc(documents.publishedAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  if (hasMore) {
    results.pop();
  }

  const tagRows = results.length > 0
    ? await db
        .select({
          documentId: documentTags.documentId,
          id: tagsTable.id,
          name: tagsTable.name,
          slug: tagsTable.slug,
        })
        .from(documentTags)
        .innerJoin(tagsTable, eq(documentTags.tagId, tagsTable.id))
        .where(inArray(documentTags.documentId, results.map((r) => r.id)))
    : [];

  const tagsByDoc = new Map<string, { id: string; name: string; slug: string }[]>();
  for (const row of tagRows) {
    const existing = tagsByDoc.get(row.documentId) ?? [];
    existing.push({ id: row.id, name: row.name, slug: row.slug });
    tagsByDoc.set(row.documentId, existing);
  }

  const items: DocumentCard[] = results.map((r) => {
    const authorship = r.authorship as Authorship | null;
    return {
      id: r.id,
      title: r.title,
      abstract: r.abstract,
      coverImageUrl: r.coverImageUrl,
      slug: r.slug,
      publishedAt: r.publishedAt as Date,
      typeName: r.typeName,
      author: {
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
      },
      authorship: {
        publicIdentifier: authorship?.publicIdentifier ?? '',
      },
      likesCount: Number(r.likesCount ?? 0),
      category: r.categoryId
        ? { id: r.categoryId, name: r.categoryName!, slug: r.categorySlug! }
        : null,
      tags: tagsByDoc.get(r.id) ?? [],
      organization: mapOrganization(
        r.organizationId,
        r.organizationOrgname,
        r.organizationName,
        r.organizationIsPrivate,
        viewerProfileId,
        r.authorProfileId
      ),
    };
  });

  const lastResult = results[results.length - 1];
  const nextCursor = hasMore && lastResult
    ? sort === 'popular'
      ? encodeFeedCursor('popular', Number(lastResult.likesCount ?? 0), lastResult.id)
      : encodeFeedCursor('recent', lastResult.publishedAt as Date, lastResult.id)
    : null;

  const [totalResult] = await db
    .select({ count: count() })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .innerJoin(users, eq(profiles.userId, users.id))
    .leftJoin(documentCategories, eq(documents.id, documentCategories.documentId))
    .leftJoin(categories, eq(documentCategories.categoryId, categories.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(...conditions));

  return { items, nextCursor, total: Number(totalResult?.count ?? 0) };
}

/**
 * Get a full public document by username and slug.
 * @param username - The author's username
 * @param slug - The document's slug
 * @param profileId - Optional profile ID to check if the user liked the document
 * @returns Full document with style, authorship, and exercises if tutorial
 * @throws NotFoundError if document not found, deleted, or not published
 */
export async function getPublicDocument(username: string, slug: string, profileId?: string): Promise<DocumentFull> {
  const docResult = await db
    .select({
      id: documents.id,
      title: documents.title,
      abstract: documents.abstract,
      content: documents.content,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      publishedAt: documents.publishedAt,
      typeName: documentTypes.name,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      authorship: documents.authorship,
      authorProfileId: profiles.id,
      authorIsPrivate: profiles.isPrivate,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .innerJoin(users, eq(profiles.userId, users.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(
      and(
        matchUsername(profiles.username, username),
        eq(documents.slug, slug),
        eq(documents.status, 'published'),
        isNull(documents.deletedAt),
        isNull(profiles.deletedAt),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (docResult.length === 0) {
    throw new NotFoundError('Document not found');
  }

  const doc = docResult[0]!;

  // Private authors stay hidden from everyone but themselves and accepted
  // followers. The same 404 as a missing slug is used so a blocked document
  // is indistinguishable from one that does not exist.
  const visible = await canViewAuthor(doc.authorProfileId, doc.authorIsPrivate, profileId);
  if (!visible) {
    throw new NotFoundError('Document not found');
  }

  const likesData = await getLikesCount(doc.id, profileId);
  const docTags = await getDocumentTags(doc.id);
  const docCategory = await getDocumentCategory(doc.id);

  const styleResult = await db
    .select()
    .from(documentStyles)
    .where(eq(documentStyles.documentId, doc.id))
    .limit(1);

  const style = styleResult[0] ?? {
    typography: 'sans',
    paperStyle: null,
    paperTexture: null,
    coverSettings: null,
    documentHeader: null,
    documentFooter: null,
    documentSignature: null,
  };

  const result: DocumentFull = {
    id: doc.id,
    title: doc.title,
    abstract: doc.abstract,
    content: doc.content as Record<string, unknown> | null,
    coverImageUrl: doc.coverImageUrl,
    slug: doc.slug,
    publishedAt: doc.publishedAt as Date,
    typeName: doc.typeName,
    author: {
      username: doc.username,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl,
    },
    style: {
      typography: style.typography,
      paperStyle: style.paperStyle as Record<string, unknown> | null,
      paperTexture: style.paperTexture as Record<string, unknown> | null,
      coverSettings: style.coverSettings as Record<string, unknown> | null,
      documentHeader: style.documentHeader as Record<string, unknown> | null,
      documentFooter: style.documentFooter as Record<string, unknown> | null,
      documentSignature: style.documentSignature as Record<string, unknown> | null,
    },
    authorship: doc.authorship as Authorship,
    likes: {
      likesCount: likesData.likesCount,
      likedByMe: likesData.likedByMe,
    },
    category: docCategory
      ? { id: docCategory.id, name: docCategory.name, slug: docCategory.slug }
      : null,
    tags: docTags.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
    organization: mapOrganization(
      doc.organizationId,
      doc.organizationOrgname,
      doc.organizationName,
      doc.organizationIsPrivate,
      profileId,
      doc.authorProfileId
    ),
  };

  if (doc.typeName === 'tutorial') {
    result.exercises = await getExercises(doc.id);
  }

  return result;
}

/**
 * Get published documents by a specific author with cursor-based pagination.
 * A private author returns an empty result for anyone but the author
 * themselves and accepted followers.
 * @param username - The author's username
 * @param params - Feed parameters (cursor, limit, type)
 * @param viewerProfileId - Optional viewer's profile ID (from JWT)
 * @returns Feed result with items, nextCursor, and total count
 * @throws NotFoundError if profile not found or deleted
 */
export async function getAuthorPublicDocuments(
  username: string,
  params: AuthorFeedParams,
  viewerProfileId?: string
): Promise<FeedResult> {
  const profileResult = await db
    .select()
    .from(profiles)
    .innerJoin(users, eq(profiles.userId, users.id))
    .where(
      and(
        matchUsername(profiles.username, username),
        isNull(profiles.deletedAt),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (profileResult.length === 0) {
    throw new NotFoundError('Profile not found');
  }

  const profile = profileResult[0]!;

  // Same privacy rule as the public read and feed: a private author's
  // documents are omitted for anyone but the author and accepted followers.
  // An empty result is returned instead of a 404 because the profile itself is
  // still reachable (getPublicProfile redacts it rather than hiding it).
  const visible = await canViewAuthor(profile.profiles.id, profile.profiles.isPrivate, viewerProfileId);
  if (!visible) {
    return { items: [], nextCursor: null, total: 0 };
  }

  const limit = Math.min(params.limit ?? 20, 50);
  const conditions: ReturnType<typeof eq>[] = [];

  conditions.push(eq(documents.authorId, profile.profiles.id));
  conditions.push(eq(documents.status, 'published'));
  conditions.push(isNull(documents.deletedAt));

  if (params.type) {
    conditions.push(eq(documentTypes.name, params.type));
  }

  if (params.cursor) {
    const { timestamp: publishedAt, id } = decodeCursor(params.cursor);
    conditions.push(lt(documents.publishedAt, publishedAt));
  }

  const likesSubquery = sql<number>`(SELECT COUNT(*) FROM document_likes WHERE document_id = ${documents.id})`;

  const results = await db
    .select({
      id: documents.id,
      title: documents.title,
      abstract: documents.abstract,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      publishedAt: documents.publishedAt,
      typeName: documentTypes.name,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      authorship: documents.authorship,
      likesCount: likesSubquery,
      authorProfileId: profiles.id,
      organizationId: documents.organizationId,
      organizationOrgname: organizations.orgname,
      organizationName: organizations.name,
      organizationIsPrivate: organizations.isPrivate,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(...conditions))
    .orderBy(desc(documents.publishedAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  if (hasMore) {
    results.pop();
  }

  const items: DocumentCard[] = await Promise.all(
    results.map(async (r) => {
      const authorship = r.authorship as Authorship | null;
      const docTags = await getDocumentTags(r.id);
      const docCategory = await getDocumentCategory(r.id);
      return {
        id: r.id,
        title: r.title,
        abstract: r.abstract,
        coverImageUrl: r.coverImageUrl,
        slug: r.slug,
        publishedAt: r.publishedAt as Date,
        typeName: r.typeName,
        author: {
          username: r.username,
          displayName: r.displayName,
          avatarUrl: r.avatarUrl,
        },
        authorship: {
          publicIdentifier: authorship?.publicIdentifier ?? '',
        },
        likesCount: Number(r.likesCount ?? 0),
        category: docCategory
          ? { id: docCategory.id, name: docCategory.name, slug: docCategory.slug }
          : null,
        tags: docTags.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
        organization: mapOrganization(
          r.organizationId,
          r.organizationOrgname,
          r.organizationName,
          r.organizationIsPrivate,
          viewerProfileId,
          r.authorProfileId
        ),
      };
    })
  );

  const lastResult = results[results.length - 1];
  const nextCursor = hasMore && lastResult
    ? encodeCursor(lastResult.publishedAt as Date, lastResult.id)
    : null;

  const totalResult = await db
    .select({ count: count() })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .where(and(...conditions));

  const total = Number(totalResult[0]?.count ?? 0);

  return { items, nextCursor, total };
}

/**
 * Get the published documents of an organization with cursor-based pagination.
 * The organization is resolved by orgname only, so a private organization
 * answers 404 for everyone but its accepted members. The private-author rule
 * of the public feed applies here too: documents of a private author are
 * omitted for viewers who are neither the author nor an accepted follower.
 * The `organization` reference of every card follows the same private
 * organization rule as the other reads — it is only filled for the document's
 * own author.
 * @param orgname - The organization orgname
 * @param params - Feed parameters (cursor, limit, type, sort)
 * @param viewerProfileId - Optional viewer's profile ID (from JWT)
 * @returns Feed result with items, nextCursor, and total count
 * @throws NotFoundError if the organization does not exist or is private and the viewer is not an accepted member
 */
export async function getOrganizationDocuments(
  orgname: string,
  params: OrganizationFeedParams,
  viewerProfileId?: string
): Promise<FeedResult> {
  const org = await getOrganizationByOrgname(orgname, viewerProfileId ?? null);

  const limit = Math.min(params.limit ?? 20, 50);
  const sort = params.sort ?? 'recent';
  const conditions: SQL[] = [];

  conditions.push(eq(documents.organizationId, org.id));
  conditions.push(eq(documents.status, 'published'));
  conditions.push(isNull(documents.deletedAt));
  conditions.push(buildAuthorVisibilityCondition(viewerProfileId));

  if (params.type) {
    conditions.push(eq(documentTypes.name, params.type));
  }

  return runDocumentFeed({
    conditions,
    sort,
    limit,
    cursor: params.cursor,
    viewerProfileId,
  });
}
