import { eq, and, sql, count, desc, isNull, lt, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/index';
import { follows, Follow } from './follows.schema';
import { profiles, Profile } from '../profiles/profiles.schema';
import { users } from '../auth/auth.schema';
import { documents } from '../documents/documents.schema';
import { documentTypes } from '../documents/documents.schema';
import { documentCategories } from '../categories/categories.schema';
import { categories } from '../categories/categories.schema';
import { documentTags } from '../tags/tags.schema';
import { tags } from '../tags/tags.schema';
import { documentLikes } from '../likes/likes.schema';
import { organizations } from '../organizations/organizations.schema';
import { mapOrganization } from '../organizations/organizations.service';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';
import { resolveProfileIdFromUserId } from '../../utils/profile';
import { matchUsername } from '../../utils/username';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { createId } from '@paralleldrive/cuid2';
import type { DocumentCard } from '../documents/documents.service';

export { resolveProfileIdFromUserId } from '../../utils/profile';

export type FollowStatus = 'accepted' | 'pending' | 'rejected' | null;

export interface FollowRequest {
  id: string;
  follower: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  createdAt: Date;
}

export interface FollowerList {
  hidden?: boolean;
  items: {
    follower: {
      id: string;
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
    };
    createdAt: Date;
  }[];
  count: number;
}

export interface FollowingList {
  hidden?: boolean;
  items: {
    following: {
      id: string;
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
    };
    createdAt: Date;
  }[];
  count: number;
}

export interface FeedParams {
  cursor?: string;
  limit?: number;
}

export interface FeedResult {
  items: DocumentCard[];
  nextCursor: string | null;
  total: number;
}

export interface FollowCounts {
  followersCount: number;
  followingCount: number;
}

async function resolveProfileIdFromUsername(username: string): Promise<string> {
  const [profile] = await db
    .select({ id: profiles.id, deletedAt: profiles.deletedAt })
    .from(profiles)
    .where(matchUsername(profiles.username, username))
    .limit(1);

  if (!profile || profile.deletedAt !== null) {
    throw new NotFoundError('Profile not found');
  }

  return profile.id;
}

/**
 * Follow a profile.
 * @param followerUserId - The follower's user ID
 * @param username - The target profile's username
 * @returns Status indicating if follow was immediate or pending
 * @throws NotFoundError if target profile not found
 * @throws ValidationError if trying to follow yourself
 * @throws ConflictError if already following or pending
 */
export async function followProfile(
  followerUserId: string,
  username: string
): Promise<{ status: 'accepted' | 'pending' }> {
  const followerProfileId = await resolveProfileIdFromUserId(followerUserId);
  const followingProfileId = await resolveProfileIdFromUsername(username);

  if (followerProfileId === followingProfileId) {
    throw new ValidationError('You cannot follow yourself');
  }

  const [targetProfile] = await db
    .select({ isPrivate: profiles.isPrivate })
    .from(profiles)
    .where(eq(profiles.id, followingProfileId))
    .limit(1);

  const [existing] = await db
    .select()
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerProfileId),
        eq(follows.followingId, followingProfileId)
      )
    )
    .limit(1);

  if (existing) {
    if (existing.status === 'accepted') {
      throw new ConflictError('Already following');
    }
    if (existing.status === 'pending') {
      throw new ConflictError('Follow request pending');
    }
    if (existing.status === 'rejected') {
      const newStatus = targetProfile?.isPrivate ? 'pending' : 'accepted';
      await db
        .update(follows)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(follows.id, existing.id));
      return { status: newStatus };
    }
  }

  const status = targetProfile?.isPrivate ? 'pending' : 'accepted';

  const inserted = await db
    .insert(follows)
    .values({
      id: createId(),
      followerId: followerProfileId,
      followingId: followingProfileId,
      status,
    })
    .onConflictDoNothing({ target: [follows.followerId, follows.followingId] })
    .returning({ id: follows.id });

  // A concurrent request (double click) inserted the row first.
  if (inserted.length === 0) {
    throw new ConflictError('Already following');
  }

  return { status };
}

/**
 * Unfollow a profile.
 * @param followerUserId - The follower's user ID
 * @param username - The target profile's username
 * @throws NotFoundError if not currently following
 */
export async function unfollowProfile(
  followerUserId: string,
  username: string
): Promise<void> {
  const followerProfileId = await resolveProfileIdFromUserId(followerUserId);
  const followingProfileId = await resolveProfileIdFromUsername(username);

  const [existing] = await db
    .select()
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerProfileId),
        eq(follows.followingId, followingProfileId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new NotFoundError('Not following this profile');
  }

  await db
    .delete(follows)
    .where(eq(follows.id, existing.id));
}

/**
 * Get follow status between two profiles.
 * @param followerProfileId - The follower's profile ID
 * @param followingProfileId - The following profile's ID
 * @returns Follow status or null if not following
 */
export async function getFollowStatus(
  followerProfileId: string,
  followingProfileId: string
): Promise<FollowStatus> {
  const [existing] = await db
    .select({ status: follows.status })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerProfileId),
        eq(follows.followingId, followingProfileId)
      )
    )
    .limit(1);

  return existing ? (existing.status as FollowStatus) : null;
}

/**
 * Get pending follow requests for a profile.
 * @param profileId - The profile's ID
 * @returns List of pending follow requests
 */
export async function getPendingRequests(profileId: string): Promise<FollowRequest[]> {
  const requests = await db
    .select({
      id: follows.id,
      followerId: follows.followerId,
      createdAt: follows.createdAt,
      followerUsername: profiles.username,
      followerDisplayName: profiles.displayName,
      followerAvatarUrl: profiles.avatarUrl,
    })
    .from(follows)
    .innerJoin(profiles, eq(follows.followerId, profiles.id))
    .where(
      and(
        eq(follows.followingId, profileId),
        eq(follows.status, 'pending')
      )
    )
    .orderBy(desc(follows.createdAt));

  return requests.map((r) => ({
    id: r.id,
    follower: {
      id: r.followerId,
      username: r.followerUsername,
      displayName: r.followerDisplayName,
      avatarUrl: r.followerAvatarUrl,
    },
    createdAt: r.createdAt,
  }));
}

/**
 * Accept a follow request.
 * @param profileId - The profile accepting the request
 * @param followId - The follow request ID
 * @throws NotFoundError if request not found
 * @throws ValidationError if not pending
 */
export async function acceptFollowRequest(
  profileId: string,
  followId: string
): Promise<void> {
  const [request] = await db
    .select()
    .from(follows)
    .where(
      and(
        eq(follows.id, followId),
        eq(follows.followingId, profileId),
        eq(follows.status, 'pending')
      )
    )
    .limit(1);

  if (!request) {
    throw new NotFoundError('Follow request not found');
  }

  await db
    .update(follows)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(eq(follows.id, followId));
}

/**
 * Reject a follow request.
 * @param profileId - The profile rejecting the request
 * @param followId - The follow request ID
 * @throws NotFoundError if request not found
 * @throws ValidationError if not pending
 */
export async function rejectFollowRequest(
  profileId: string,
  followId: string
): Promise<void> {
  const [request] = await db
    .select()
    .from(follows)
    .where(
      and(
        eq(follows.id, followId),
        eq(follows.followingId, profileId),
        eq(follows.status, 'pending')
      )
    )
    .limit(1);

  if (!request) {
    throw new NotFoundError('Follow request not found');
  }

  await db
    .delete(follows)
    .where(eq(follows.id, followId));
}

/**
 * Get followers list for a profile.
 * @param username - The profile's username
 * @param viewerProfileId - Optional viewer's profile ID for privacy checks
 * @returns Followers list or hidden flag for private profiles
 */
export async function getFollowers(
  username: string,
  viewerProfileId?: string
): Promise<FollowerList> {
  const targetProfileId = await resolveProfileIdFromUsername(username);

  const [targetProfile] = await db
    .select({ isPrivate: profiles.isPrivate })
    .from(profiles)
    .where(eq(profiles.id, targetProfileId))
    .limit(1);

  if (targetProfile?.isPrivate && viewerProfileId) {
    const followStatus = await getFollowStatus(viewerProfileId, targetProfileId);
    if (followStatus !== 'accepted') {
      return { hidden: true, items: [], count: 0 };
    }
  }

  if (targetProfile?.isPrivate && !viewerProfileId) {
    return { hidden: true, items: [], count: 0 };
  }

  const [countResult] = await db
    .select({ count: count() })
    .from(follows)
    .where(
      and(
        eq(follows.followingId, targetProfileId),
        eq(follows.status, 'accepted')
      )
    )
    .limit(1);

  const followersList = await db
    .select({
      id: follows.id,
      followerId: follows.followerId,
      createdAt: follows.createdAt,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(follows)
    .innerJoin(profiles, eq(follows.followerId, profiles.id))
    .where(
      and(
        eq(follows.followingId, targetProfileId),
        eq(follows.status, 'accepted')
      )
    )
    .orderBy(desc(follows.createdAt));

  return {
    items: followersList.map((f) => ({
      follower: {
        id: f.followerId,
        username: f.username,
        displayName: f.displayName,
        avatarUrl: f.avatarUrl,
      },
      createdAt: f.createdAt,
    })),
    count: Number(countResult?.count ?? 0),
  };
}

/**
 * Get following list for a profile.
 * @param username - The profile's username
 * @param viewerProfileId - Optional viewer's profile ID for privacy checks
 * @returns Following list or hidden flag for private profiles
 */
export async function getFollowing(
  username: string,
  viewerProfileId?: string
): Promise<FollowingList> {
  const targetProfileId = await resolveProfileIdFromUsername(username);

  const [targetProfile] = await db
    .select({ isPrivate: profiles.isPrivate })
    .from(profiles)
    .where(eq(profiles.id, targetProfileId))
    .limit(1);

  if (targetProfile?.isPrivate && viewerProfileId) {
    const followStatus = await getFollowStatus(viewerProfileId, targetProfileId);
    if (followStatus !== 'accepted') {
      return { hidden: true, items: [], count: 0 };
    }
  }

  if (targetProfile?.isPrivate && !viewerProfileId) {
    return { hidden: true, items: [], count: 0 };
  }

  const [countResult] = await db
    .select({ count: count() })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, targetProfileId),
        eq(follows.status, 'accepted')
      )
    )
    .limit(1);

  const followingList = await db
    .select({
      id: follows.id,
      followingId: follows.followingId,
      createdAt: follows.createdAt,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(follows)
    .innerJoin(profiles, eq(follows.followingId, profiles.id))
    .where(
      and(
        eq(follows.followerId, targetProfileId),
        eq(follows.status, 'accepted')
      )
    )
    .orderBy(desc(follows.createdAt));

  return {
    items: followingList.map((f) => ({
      following: {
        id: f.followingId,
        username: f.username,
        displayName: f.displayName,
        avatarUrl: f.avatarUrl,
      },
      createdAt: f.createdAt,
    })),
    count: Number(countResult?.count ?? 0),
  };
}

/**
 * Get following feed for a user.
 * @param followerUserId - The follower's user ID
 * @param params - Feed pagination params
 * @returns Paginated feed of documents from followed profiles
 */
export async function getFollowingFeed(
  followerUserId: string,
  params: FeedParams
): Promise<FeedResult> {
  const followerProfileId = await resolveProfileIdFromUserId(followerUserId);

  const followingIdsResult = await db
    .select({ followingId: follows.followingId })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerProfileId),
        eq(follows.status, 'accepted')
      )
    );

  const followingIds = followingIdsResult.map((f) => f.followingId);

  if (followingIds.length === 0) {
    return { items: [], nextCursor: null, total: 0 };
  }

  const privateProfilesResult = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.isPrivate, true),
        sql`${profiles.id} NOT IN (${sql`${followerProfileId}`})`
      )
    );

  const privateIds = new Set(privateProfilesResult.map((p) => p.id));
  const accessibleIds = followingIds.filter((id) => !privateIds.has(id));

  if (accessibleIds.length === 0) {
    return { items: [], nextCursor: null, total: 0 };
  }

  const limit = Math.min(params.limit ?? 20, 50);

  const authorIdsSubquery = sql`(SELECT user_id FROM profiles WHERE id IN (${sql.join(accessibleIds, sql`, `)}))`;

  const conditions: SQL[] = [
    sql`${documents.authorId} IN (${sql.join(accessibleIds, sql`, `)})`,
    eq(documents.status, 'published'),
    isNull(documents.deletedAt),
  ];

  const pageConditions = [...conditions];

  if (params.cursor) {
    const { timestamp, id } = decodeCursor(params.cursor);
    pageConditions.push(
      or(
        lt(documents.publishedAt, timestamp),
        and(eq(documents.publishedAt, timestamp), lt(documents.id, id))
      )!
    );
  }

  const documentsQuery = db
    .select({
      id: documents.id,
      title: documents.title,
      abstract: documents.abstract,
      coverImageUrl: documents.coverImageUrl,
      slug: documents.slug,
      publishedAt: documents.publishedAt,
      authorId: documents.authorId,
      authorUsername: profiles.username,
      authorDisplayName: profiles.displayName,
      authorAvatarUrl: profiles.avatarUrl,
      typeName: documentTypes.name,
      likesCount: sql<number>`(SELECT COUNT(*) FROM ${documentLikes} WHERE document_id = ${documents.id})`,
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
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .leftJoin(documentCategories, eq(documents.id, documentCategories.documentId))
    .leftJoin(categories, eq(documentCategories.categoryId, categories.id))
    .leftJoin(organizations, eq(documents.organizationId, organizations.id))
    .where(and(...pageConditions))
    .orderBy(desc(documents.publishedAt), desc(documents.id))
    .limit(limit + 1);

  const docsWithLimit = await documentsQuery;

  let nextCursor: string | null = null;
  if (docsWithLimit.length > limit) {
    const lastDoc = docsWithLimit[limit - 1]!;
    nextCursor = encodeCursor(lastDoc.publishedAt!, lastDoc.id);
  }

  const items = docsWithLimit.slice(0, limit);

  const tagRows = items.length > 0
    ? await db
        .select({
          documentId: documentTags.documentId,
          tagId: tags.id,
          tagName: tags.name,
          tagSlug: tags.slug,
        })
        .from(documentTags)
        .innerJoin(tags, eq(documentTags.tagId, tags.id))
        .where(sql`${documentTags.documentId} IN (${sql.join(items.map((i) => sql`${i.id}`), sql`, `)})`)
    : [];

  const tagsByDoc = new Map<string, { id: string; name: string; slug: string }[]>();
  for (const row of tagRows) {
    const existing = tagsByDoc.get(row.documentId) ?? [];
    existing.push({ id: row.tagId, name: row.tagName, slug: row.tagSlug });
    tagsByDoc.set(row.documentId, existing);
  }

  const documentCards: DocumentCard[] = items.map((doc) => ({
    id: doc.id,
    title: doc.title,
    abstract: doc.abstract,
    coverImageUrl: doc.coverImageUrl,
    slug: doc.slug,
    publishedAt: doc.publishedAt!,
    typeName: doc.typeName,
    author: {
      username: doc.authorUsername,
      displayName: doc.authorDisplayName,
      avatarUrl: doc.authorAvatarUrl,
    },
    authorship: {
      publicIdentifier: '',
    },
    likesCount: Number(doc.likesCount),
    category: doc.categoryId
      ? { id: doc.categoryId, name: doc.categoryName!, slug: doc.categorySlug! }
      : null,
    tags: tagsByDoc.get(doc.id) ?? [],
    organization: mapOrganization(
      doc.organizationId,
      doc.organizationOrgname,
      doc.organizationName,
      doc.organizationIsPrivate,
      followerProfileId,
      doc.authorProfileId
    ),
  }));

  const [totalResult] = await db
    .select({ count: count() })
    .from(documents)
    .innerJoin(profiles, eq(documents.authorId, profiles.id))
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .leftJoin(documentCategories, eq(documents.id, documentCategories.documentId))
    .leftJoin(categories, eq(documentCategories.categoryId, categories.id))
    .where(and(...conditions));

  return {
    items: documentCards,
    nextCursor,
    total: Number(totalResult?.count ?? 0),
  };
}

/**
 * Get follow counts for a profile.
 * @param profileId - The profile's ID
 * @returns Followers and following counts
 */
export async function getFollowCounts(profileId: string): Promise<FollowCounts> {
  const [followersResult] = await db
    .select({ count: count() })
    .from(follows)
    .where(
      and(
        eq(follows.followingId, profileId),
        eq(follows.status, 'accepted')
      )
    )
    .limit(1);

  const [followingResult] = await db
    .select({ count: count() })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, profileId),
        eq(follows.status, 'accepted')
      )
    )
    .limit(1);

  return {
    followersCount: Number(followersResult?.count ?? 0),
    followingCount: Number(followingResult?.count ?? 0),
  };
}
