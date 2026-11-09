import { pgTable, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { profiles } from '../profiles/profiles.schema';

export const follows = pgTable('follows', {
  id: text('id').primaryKey(),
  followerId: text('follower_id').notNull().references(() => profiles.id),
  followingId: text('following_id').notNull().references(() => profiles.id),
  status: text('status').notNull().default('accepted'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  // Also serves lookups by follower_id (leading column).
  followerFollowingUnique: unique('follows_follower_following_unique').on(table.followerId, table.followingId),
  followingIdx: index('follows_following_id_idx').on(table.followingId),
}));

export type Follow = typeof follows.$inferSelect;
export type NewFollow = typeof follows.$inferInsert;
