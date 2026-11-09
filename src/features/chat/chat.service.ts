import { eq, and, asc, desc, lt, sql, isNull, count, or } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import { chatServers, chatServerMembers, chatChannels, chatMessages, ChatServer, ChatServerMember, ChatChannel, ChatMessage } from './chat.schema';
import { profiles } from '../profiles/profiles.schema';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../../utils/errors';
import { resolveProfileIdFromUserId } from '../../utils/profile';
import { encodeCursor, decodeCursor } from '../../utils/cursor';
import { generateSlug, resolveUniqueSlug } from '../../utils/slug';
import { broadcastToChannel, disconnectProfileFromChannels } from './ws-registry';
import type { CreateServerInput, CreateChannelInput, MessageQueryInput } from './chat.zod';

export { resolveProfileIdFromUserId } from '../../utils/profile';

const MAX_LIMIT = 50;

/**
 * Ensure a chat server exists.
 * @param serverId - The server ID
 * @returns The chat server row
 * @throws NotFoundError if server not found
 */
async function assertServerExists(serverId: string): Promise<ChatServer> {
  const [server] = await db
    .select()
    .from(chatServers)
    .where(eq(chatServers.id, serverId))
    .limit(1);

  if (!server) {
    throw new NotFoundError('Chat server not found');
  }

  return server;
}

/**
 * Get a profile's membership in a server.
 * @param serverId - The server ID
 * @param profileId - The profile ID
 * @returns Membership row or null
 */
async function getMembership(serverId: string, profileId: string): Promise<ChatServerMember | null> {
  const [member] = await db
    .select()
    .from(chatServerMembers)
    .where(
      and(
        eq(chatServerMembers.serverId, serverId),
        eq(chatServerMembers.profileId, profileId)
      )
    )
    .limit(1);

  return member ?? null;
}

/**
 * Ensure a profile is an accepted member of a server.
 * @param serverId - The server ID
 * @param profileId - The profile ID
 * @returns Membership row
 * @throws ForbiddenError if not an accepted member
 */
async function assertAcceptedMember(serverId: string, profileId: string): Promise<ChatServerMember> {
  const member = await getMembership(serverId, profileId);

  if (!member || member.status !== 'accepted') {
    throw new ForbiddenError('You must be a member of this server');
  }

  return member;
}

/**
 * Ensure a profile can manage a server (owner or admin).
 * @param serverId - The server ID
 * @param profileId - The profile ID
 * @returns Membership row
 * @throws ForbiddenError if not owner/admin
 */
async function assertManager(serverId: string, profileId: string): Promise<ChatServerMember> {
  const member = await assertAcceptedMember(serverId, profileId);

  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Owner or admin access required');
  }

  return member;
}

/**
 * Resolve the server that owns a channel.
 * @param channelId - The channel ID
 * @returns Channel and its parent server
 * @throws NotFoundError if channel not found
 */
async function resolveServerFromChannel(channelId: string): Promise<{ channel: ChatChannel; server: ChatServer }> {
  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);

  if (!channel) {
    throw new NotFoundError('Channel not found');
  }

  const server = await assertServerExists(channel.serverId);

  return { channel, server };
}

/**
 * Ensure a profile is an accepted member of the server that owns a channel.
 * Used by the WebSocket subscribe handler to reuse the same business rule.
 * @param profileId - The profile ID
 * @param channelId - The channel ID
 * @throws NotFoundError if channel not found
 * @throws ForbiddenError if not an accepted member of the parent server
 */
export async function assertCanAccessChannel(profileId: string, channelId: string): Promise<void> {
  const { server } = await resolveServerFromChannel(channelId);
  await assertAcceptedMember(server.id, profileId);
}

async function isServerSlugTaken(slug: string): Promise<boolean> {
  const existing = await db
    .select({ id: chatServers.id })
    .from(chatServers)
    .where(eq(chatServers.slug, slug))
    .limit(1);

  return existing.length > 0;
}

/**
 * Create a chat server (admin only).
 * The creator becomes the owner and is added as an accepted member.
 * @param userId - The user's ID
 * @param data - Server data
 * @returns Created server
 */
export async function createServer(userId: string, data: CreateServerInput): Promise<ChatServer> {
  const profileId = await resolveProfileIdFromUserId(userId);
  const slug = await resolveUniqueSlug(generateSlug(data.name), isServerSlugTaken);

  const server = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(chatServers)
      .values({
        id: createId(),
        name: data.name.trim(),
        slug,
        ownerId: profileId,
        iconUrl: data.iconUrl ?? null,
        createdAt: new Date(),
      })
      .returning();

    await tx.insert(chatServerMembers).values({
      id: createId(),
      serverId: created!.id,
      profileId,
      role: 'owner',
      status: 'accepted',
      invitedBy: profileId,
      requestedAt: new Date(),
    });

    return created!;
  });

  return server;
}

/**
 * List servers where the authenticated user is an accepted member.
 * @param userId - The user's ID
 * @returns List of servers
 */
export async function listMyServers(userId: string): Promise<ChatServer[]> {
  const profileId = await resolveProfileIdFromUserId(userId);

  return db
    .select({
      id: chatServers.id,
      name: chatServers.name,
      slug: chatServers.slug,
      ownerId: chatServers.ownerId,
      iconUrl: chatServers.iconUrl,
      createdAt: chatServers.createdAt,
    })
    .from(chatServers)
    .innerJoin(chatServerMembers, eq(chatServers.id, chatServerMembers.serverId))
    .where(
      and(
        eq(chatServerMembers.profileId, profileId),
        eq(chatServerMembers.status, 'accepted')
      )
    )
    .orderBy(desc(chatServers.createdAt));
}

/**
 * List all chat servers (admin only — no membership filter).
 * Includes accepted member count per server.
 * @returns All servers with member counts
 */
export async function listAllServers(): Promise<Array<ChatServer & { memberCount: number }>> {
  return db
    .select({
      id: chatServers.id,
      name: chatServers.name,
      slug: chatServers.slug,
      ownerId: chatServers.ownerId,
      iconUrl: chatServers.iconUrl,
      createdAt: chatServers.createdAt,
      memberCount: sql<number>`count(${chatServerMembers.id})::int`,
    })
    .from(chatServers)
    .leftJoin(
      chatServerMembers,
      and(
        eq(chatServers.id, chatServerMembers.serverId),
        eq(chatServerMembers.status, 'accepted')
      )
    )
    .groupBy(chatServers.id)
    .orderBy(desc(chatServers.createdAt));
}

/**
 * Get a server with its channels.
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @returns Server and channel list
 */
export async function getServerDetail(
  userId: string,
  serverId: string
): Promise<{ server: ChatServer; channels: ChatChannel[] }> {
  const profileId = await resolveProfileIdFromUserId(userId);
  await assertAcceptedMember(serverId, profileId);
  const server = await assertServerExists(serverId);

  const channels = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.serverId, serverId))
    .orderBy(asc(chatChannels.position), asc(chatChannels.createdAt));

  return { server, channels };
}

/**
 * Add a member to a server (owner/admin only).
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @param profileId - The profile ID to add
 * @returns Created membership row
 */
export async function addMember(userId: string, serverId: string, profileId: string): Promise<ChatServerMember> {
  const callerProfileId = await resolveProfileIdFromUserId(userId);
  await assertManager(serverId, callerProfileId);

  const [targetProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1);

  if (!targetProfile) {
    throw new NotFoundError('Profile not found');
  }

  const existing = await getMembership(serverId, profileId);

  if (existing) {
    throw new ConflictError('Profile is already a member');
  }

  const [member] = await db
    .insert(chatServerMembers)
    .values({
      id: createId(),
      serverId,
      profileId,
      role: 'member',
      status: 'accepted',
      invitedBy: callerProfileId,
      requestedAt: new Date(),
    })
    .returning();

  return member!;
}

export interface ServerMemberItem {
  id: string;
  profileId: string;
  role: string;
  status: string;
  invitedBy: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * List members of a server.
 * Pending members are only visible to owners/admins.
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @returns List of members with profile info
 */
export async function listMembers(userId: string, serverId: string): Promise<ServerMemberItem[]> {
  const profileId = await resolveProfileIdFromUserId(userId);
  const caller = await assertAcceptedMember(serverId, profileId);
  const isManager = caller.role === 'owner' || caller.role === 'admin';

  const rows = await db
    .select({
      id: chatServerMembers.id,
      profileId: chatServerMembers.profileId,
      role: chatServerMembers.role,
      status: chatServerMembers.status,
      invitedBy: chatServerMembers.invitedBy,
      requestedAt: chatServerMembers.requestedAt,
      decidedAt: chatServerMembers.decidedAt,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(chatServerMembers)
    .innerJoin(profiles, eq(chatServerMembers.profileId, profiles.id))
    .where(eq(chatServerMembers.serverId, serverId))
    .orderBy(asc(chatServerMembers.requestedAt));

  return isManager ? rows : rows.filter((r) => r.status === 'accepted');
}

/**
 * List members of a server with admin bypass (admin only).
 * Skips membership check — returns all members including pending.
 * @param serverId - The server ID
 * @returns All members with profile info
 */
export async function listMembersAdminBypass(serverId: string): Promise<ServerMemberItem[]> {
  await assertServerExists(serverId);

  return db
    .select({
      id: chatServerMembers.id,
      profileId: chatServerMembers.profileId,
      role: chatServerMembers.role,
      status: chatServerMembers.status,
      invitedBy: chatServerMembers.invitedBy,
      requestedAt: chatServerMembers.requestedAt,
      decidedAt: chatServerMembers.decidedAt,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(chatServerMembers)
    .innerJoin(profiles, eq(chatServerMembers.profileId, profiles.id))
    .where(eq(chatServerMembers.serverId, serverId))
    .orderBy(asc(chatServerMembers.requestedAt));
}

/**
 * Approve or reject a pending member (owner/admin only).
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @param memberId - The membership row ID
 * @param status - New status
 * @returns Updated membership row
 */
export async function decideMember(
  userId: string,
  serverId: string,
  memberId: string,
  status: 'accepted' | 'rejected'
): Promise<ChatServerMember> {
  const callerProfileId = await resolveProfileIdFromUserId(userId);
  await assertManager(serverId, callerProfileId);

  const [member] = await db
    .select()
    .from(chatServerMembers)
    .where(
      and(
        eq(chatServerMembers.id, memberId),
        eq(chatServerMembers.serverId, serverId)
      )
    )
    .limit(1);

  if (!member) {
    throw new NotFoundError('Member not found');
  }

  if (member.status !== 'pending') {
    throw new ValidationError('Only pending members can be approved or rejected');
  }

  const [updated] = await db
    .update(chatServerMembers)
    .set({ status, decidedAt: new Date() })
    .where(eq(chatServerMembers.id, memberId))
    .returning();

  return updated!;
}

/**
 * Remove a member from a server.
 * Allowed for owners/admins, or for the member leaving themselves.
 * The owner cannot be removed.
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @param memberId - The membership row ID
 */
export async function removeMember(userId: string, serverId: string, memberId: string): Promise<void> {
  const callerProfileId = await resolveProfileIdFromUserId(userId);
  const server = await assertServerExists(serverId);
  const caller = await getMembership(serverId, callerProfileId);

  const [member] = await db
    .select()
    .from(chatServerMembers)
    .where(
      and(
        eq(chatServerMembers.id, memberId),
        eq(chatServerMembers.serverId, serverId)
      )
    )
    .limit(1);

  if (!member) {
    throw new NotFoundError('Member not found');
  }

  if (member.profileId === server.ownerId) {
    throw new ForbiddenError('The server owner cannot be removed');
  }

  const callerIsManager = caller?.role === 'owner' || caller?.role === 'admin';
  const callerIsSelf = caller?.profileId === member.profileId;

  if (!callerIsManager && !callerIsSelf) {
    throw new ForbiddenError('Owner or admin access required');
  }

  await db
    .delete(chatServerMembers)
    .where(eq(chatServerMembers.id, memberId));

  const serverChannels = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(eq(chatChannels.serverId, serverId));
  disconnectProfileFromChannels(serverChannels.map((c) => c.id), member.profileId);
}

/**
 * Create a channel in a server (owner/admin only).
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @param data - Channel data
 * @returns Created channel
 */
export async function createChannel(userId: string, serverId: string, data: CreateChannelInput): Promise<ChatChannel> {
  const profileId = await resolveProfileIdFromUserId(userId);
  await assertManager(serverId, profileId);

  const [positionResult] = await db
    .select({ max: sql<number>`COALESCE(MAX(${chatChannels.position}), -1)` })
    .from(chatChannels)
    .where(eq(chatChannels.serverId, serverId));

  const [channel] = await db
    .insert(chatChannels)
    .values({
      id: createId(),
      serverId,
      name: data.name.trim(),
      type: data.type ?? 'text',
      position: Number(positionResult?.max ?? -1) + 1,
      createdAt: new Date(),
    })
    .returning();

  return channel!;
}

/**
 * List channels of a server.
 * @param userId - The user's ID
 * @param serverId - The server ID
 * @returns List of channels ordered by position
 */
export async function listChannels(userId: string, serverId: string): Promise<ChatChannel[]> {
  const profileId = await resolveProfileIdFromUserId(userId);
  await assertAcceptedMember(serverId, profileId);

  return db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.serverId, serverId))
    .orderBy(asc(chatChannels.position), asc(chatChannels.createdAt));
}

/**
 * Send a message to a channel.
 * @param userId - The user's ID
 * @param channelId - The channel ID
 * @param content - Message content
 * @returns Created message
 */
export async function sendMessage(userId: string, channelId: string, content: string): Promise<ChatMessage> {
  const profileId = await resolveProfileIdFromUserId(userId);
  const { server } = await resolveServerFromChannel(channelId);
  await assertAcceptedMember(server.id, profileId);

  const [message] = await db
    .insert(chatMessages)
    .values({
      id: createId(),
      channelId,
      authorId: profileId,
      content,
      createdAt: new Date(),
    })
    .returning();

  broadcastToChannel(channelId, {
    type: 'message:new',
    channelId,
    message: message!,
  });

  return message!;
}

export interface MessageItem {
  id: string;
  channelId: string;
  authorId: string;
  content: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  authorUsername: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}

export interface MessagePage {
  items: MessageItem[];
  nextCursor: string | null;
  total: number;
}

/**
 * List messages in a channel, paginated by cursor.
 * Soft-deleted messages keep their metadata with content set to null.
 * @param userId - The user's ID
 * @param channelId - The channel ID
 * @param params - Pagination params
 * @returns Paginated messages
 */
export async function listMessages(
  userId: string,
  channelId: string,
  params: MessageQueryInput
): Promise<MessagePage> {
  const profileId = await resolveProfileIdFromUserId(userId);
  const { server } = await resolveServerFromChannel(channelId);
  await assertAcceptedMember(server.id, profileId);

  const limit = Math.min(params.limit ?? 20, MAX_LIMIT);
  const conditions = [eq(chatMessages.channelId, channelId)];

  if (params.cursor) {
    const { timestamp, id } = decodeCursor(params.cursor);
    conditions.push(
      or(
        lt(chatMessages.createdAt, timestamp),
        and(eq(chatMessages.createdAt, timestamp), lt(chatMessages.id, id))
      )!
    );
  }

  const results = await db
    .select({
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      authorId: chatMessages.authorId,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      editedAt: chatMessages.editedAt,
      deletedAt: chatMessages.deletedAt,
      authorUsername: profiles.username,
      authorDisplayName: profiles.displayName,
      authorAvatarUrl: profiles.avatarUrl,
    })
    .from(chatMessages)
    .innerJoin(profiles, eq(chatMessages.authorId, profiles.id))
    .where(and(...conditions))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  if (hasMore) {
    results.pop();
  }

  const items = results.map((r) => ({
    ...r,
    content: r.deletedAt ? null : r.content,
  }));

  const lastResult = results[results.length - 1];
  const nextCursor = hasMore && lastResult
    ? encodeCursor(lastResult.createdAt, lastResult.id)
    : null;

  const [totalResult] = await db
    .select({ count: count() })
    .from(chatMessages)
    .where(eq(chatMessages.channelId, channelId));

  return { items, nextCursor, total: Number(totalResult?.count ?? 0) };
}

/**
 * Edit a message (author only).
 * @param userId - The user's ID
 * @param messageId - The message ID
 * @param content - New message content
 * @returns Updated message
 */
export async function editMessage(userId: string, messageId: string, content: string): Promise<ChatMessage> {
  const profileId = await resolveProfileIdFromUserId(userId);

  const [message] = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, messageId),
        isNull(chatMessages.deletedAt)
      )
    )
    .limit(1);

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.authorId !== profileId) {
    throw new ForbiddenError('Only the message author can edit it');
  }

  const [updated] = await db
    .update(chatMessages)
    .set({ content, editedAt: new Date() })
    .where(eq(chatMessages.id, messageId))
    .returning();

  broadcastToChannel(message.channelId, {
    type: 'message:updated',
    channelId: message.channelId,
    message: updated!,
  });

  return updated!;
}

/**
 * Soft delete a message.
 * Allowed for the author or for owners/admins of the parent server.
 * @param userId - The user's ID
 * @param messageId - The message ID
 */
export async function deleteMessage(userId: string, messageId: string): Promise<void> {
  const profileId = await resolveProfileIdFromUserId(userId);

  const [message] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1);

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.authorId !== profileId) {
    const { server } = await resolveServerFromChannel(message.channelId);
    await assertManager(server.id, profileId);
  }

  await db
    .update(chatMessages)
    .set({ deletedAt: new Date() })
    .where(eq(chatMessages.id, messageId));

  broadcastToChannel(message.channelId, {
    type: 'message:deleted',
    channelId: message.channelId,
    messageId,
  });
}
