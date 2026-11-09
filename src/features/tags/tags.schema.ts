import { pgTable, text, timestamp, unique, index } from 'drizzle-orm/pg-core';

export const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documentTags = pgTable('document_tags', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  tagId: text('tag_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  documentTagUnique: unique().on(table.documentId, table.tagId),
  tagIdx: index('document_tags_tag_id_idx').on(table.tagId),
}));

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type DocumentTag = typeof documentTags.$inferSelect;
export type NewDocumentTag = typeof documentTags.$inferInsert;
