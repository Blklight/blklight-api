import { pgTable, text, timestamp, integer, unique, index } from 'drizzle-orm/pg-core';
import { profiles } from '../profiles/profiles.schema';

export const chatServers = pgTable('chat_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerId: text('owner_id').notNull().references(() => profiles.id),
  iconUrl: text('icon_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const chatServerMembers = pgTable('chat_server_members', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => chatServers.id, { onDelete: 'cascade' }),
  profileId: text('profile_id').notNull().references(() => profiles.id),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('pending'),
  invitedBy: text('invited_by').references(() => profiles.id),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
}, (table) => ({
  serverProfileUnique: unique().on(table.serverId, table.profileId),
  profileIdx: index('chat_server_members_profile_id_idx').on(table.profileId),
}));

export const chatChannels = pgTable('chat_channels', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => chatServers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull().default('text'),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  serverIdx: index('chat_channels_server_id_idx').on(table.serverId),
}));

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => profiles.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  editedAt: timestamp('edited_at'),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  channelCreatedIdx: index('chat_messages_channel_id_created_at_idx').on(table.channelId, table.createdAt),
}));

export type ChatServer = typeof chatServers.$inferSelect;
export type NewChatServer = typeof chatServers.$inferInsert;
export type ChatServerMember = typeof chatServerMembers.$inferSelect;
export type NewChatServerMember = typeof chatServerMembers.$inferInsert;
export type ChatChannel = typeof chatChannels.$inferSelect;
export type NewChatChannel = typeof chatChannels.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
