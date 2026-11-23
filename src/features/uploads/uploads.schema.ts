import { pgTable, pgEnum, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from '../auth/auth.schema';

export const uploadPurposeEnum = pgEnum('upload_purpose', ['editor', 'avatar']);

/** One row per stored object: who uploaded what, for moderation and later orphan cleanup. */
export const uploads = pgTable('uploads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  key: text('key').notNull().unique(),
  purpose: uploadPurposeEnum('purpose').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('uploads_user_id_idx').on(table.userId),
}));

export type Upload = typeof uploads.$inferSelect;
export type UploadPurpose = (typeof uploadPurposeEnum.enumValues)[number];
