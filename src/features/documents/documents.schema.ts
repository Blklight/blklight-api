import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { profiles } from '../profiles/profiles.schema';
import { organizations } from '../organizations/organizations.schema';

export const documentTypes = pgTable('document_types', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull().references(() => profiles.id),
  typeId: text('type_id').notNull().references(() => documentTypes.id),
  organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  status: text('status').default('draft').notNull(),
  title: text('title').notNull(),
  abstract: text('abstract'),
  content: jsonb('content'),
  coverImageUrl: text('cover_image_url'),
  slug: text('slug').notNull(),
  authorship: jsonb('authorship'),
  publishedAt: timestamp('published_at'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  authorSlugUnique: unique().on(table.authorId, table.slug),
  organizationIdx: index('documents_organization_id_idx').on(table.organizationId),
  // Public feed: published, not deleted, newest first (keyset on published_at, id).
  publishedFeedIdx: index('documents_published_feed_idx')
    .on(table.publishedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
    .where(sql`${table.status} = 'published' AND ${table.deletedAt} IS NULL`),
}));

export const documentStyles = pgTable('document_styles', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().unique().references(() => documents.id),
  typography: text('typography').default('sans').notNull(),
  paperStyle: jsonb('paper_style'),
  paperTexture: jsonb('paper_texture'),
  coverSettings: jsonb('cover_settings'),
  documentHeader: jsonb('document_header'),
  documentFooter: jsonb('document_footer'),
  documentSignature: jsonb('document_signature'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type DocumentType = typeof documentTypes.$inferSelect;
export type NewDocumentType = typeof documentTypes.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentStyle = typeof documentStyles.$inferSelect;
export type NewDocumentStyle = typeof documentStyles.$inferInsert;
