import { eq, and, isNull, isNotNull, sql, ilike, or, desc, type SQL } from 'drizzle-orm';
import { db } from '../../db/index';
import { users, sessions } from '../auth/auth.schema';
import { profiles } from '../profiles/profiles.schema';
import { workspaces } from '../workspace/workspace.schema';
import { signatures } from '../signatures/signatures.schema';
import { userApps, platformApps } from '../platform-apps/platform-apps.schema';
import { chatServers, chatServerMembers } from '../chat/chat.schema';
import { NotFoundError, ValidationError } from '../../utils/errors';
import type { ListUsersQuery } from './admin.zod';

export async function getAdminOverview() {
  const [userCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNull(users.deletedAt));

  const [adminCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.role, 'admin')));

  const [serverCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatServers);

  const [pendingMemberCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatServerMembers)
    .where(eq(chatServerMembers.status, 'pending'));

  const [activeAppsCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(platformApps)
    .where(eq(platformApps.isActive, true));

  return {
    users: { total: userCount!.count, admins: adminCount!.count },
    chat: { servers: serverCount!.count, pendingMembers: pendingMemberCount!.count },
    apps: { active: activeAppsCount!.count },
  };
}

export async function listUsers(query: ListUsersQuery) {
  const { search, role, page, limit, deleted } = query;
  const offset = (page - 1) * limit;
  const isDeletedMode = deleted === 'true';

  const conditions: SQL[] = [
    isDeletedMode ? isNotNull(users.deletedAt) : isNull(users.deletedAt),
  ];

  if (!isDeletedMode) {
    if (search) {
      const searchPattern = `%${search}%`;
      const searchCondition = or(
        ilike(users.email, searchPattern),
        ilike(users.username, searchPattern),
        ilike(profiles.displayName, searchPattern)
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }
    if (role) {
      conditions.push(eq(users.role, role));
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .leftJoin(profiles, eq(users.id, profiles.userId))
    .where(whereClause);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: users.role,
      emailVerified: users.emailVerified,
      onboardingComplete: users.onboardingComplete,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
      profileId: profiles.id,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(users)
    .leftJoin(profiles, eq(users.id, profiles.userId))
    .where(whereClause)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const items = rows.map((row) => ({
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    emailVerified: row.emailVerified,
    onboardingComplete: row.onboardingComplete,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    profile: row.profileId
      ? { id: row.profileId, displayName: row.displayName, avatarUrl: row.avatarUrl }
      : null,
  }));

  return {
    items,
    total: countResult!.count,
    page,
    limit,
  };
}

export async function getUserDetail(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: users.role,
      emailVerified: users.emailVerified,
      onboardingComplete: users.onboardingComplete,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  const [profile] = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      bio: profiles.bio,
      avatarUrl: profiles.avatarUrl,
      isPrivate: profiles.isPrivate,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const profileId = profile?.id;

  const apps = profileId
    ? await db
        .select({ slug: platformApps.slug, name: platformApps.name })
        .from(userApps)
        .innerJoin(platformApps, eq(userApps.appId, platformApps.id))
        .where(eq(userApps.profileId, profileId))
    : [];

  const servers = profileId
    ? await db
        .select({
          name: chatServers.name,
          role: chatServerMembers.role,
          status: chatServerMembers.status,
        })
        .from(chatServerMembers)
        .innerJoin(chatServers, eq(chatServerMembers.serverId, chatServers.id))
        .where(eq(chatServerMembers.profileId, profileId))
    : [];

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, type: workspaces.type })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId))
    .limit(1);

  const [signature] = await db
    .select({ userHash: signatures.userHash, createdAt: signatures.createdAt })
    .from(signatures)
    .where(eq(signatures.userId, userId))
    .limit(1);

  return {
    user,
    profile: profile ?? null,
    apps,
    servers,
    workspace: workspace ?? null,
    signature: signature ?? null,
  };
}

export async function updateUserRole(userId: string, role: 'user' | 'admin') {
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!existing) {
    throw new NotFoundError('User not found');
  }

  if (existing.role === role) {
    return { message: 'Role unchanged' };
  }

  // The role travels in the access token: drop the sessions so a demoted admin
  // cannot refresh and must sign in again (the current token still lives until
  // JWT_ACCESS_EXPIRES_IN).
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
      });
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return row;
  });

  return updated!;
}
