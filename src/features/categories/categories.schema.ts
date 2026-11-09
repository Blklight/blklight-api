import { pgTable, text, timestamp, unique, index } from 'drizzle-orm/pg-core';

export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  parentId: text('parent_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documentCategories = pgTable('document_categories', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  categoryId: text('category_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  documentUnique: unique().on(table.documentId),
  categoryIdx: index('document_categories_category_id_idx').on(table.categoryId),
}));

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type DocumentCategory = typeof documentCategories.$inferSelect;
export type NewDocumentCategory = typeof documentCategories.$inferInsert;
