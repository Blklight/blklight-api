import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { profiles } from '../profiles/profiles.schema';
import { documents } from '../documents/documents.schema';

export const highlights = pgTable('highlights', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().references(() => profiles.id),
  documentId: text('document_id').notNull().references(() => documents.id),
  selection: jsonb('selection').notNull(),
  annotation: jsonb('annotation'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  profileDocumentIdx: index('highlights_profile_id_document_id_idx').on(table.profileId, table.documentId),
}));

export const highlightPalette = pgTable('highlight_palette', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().unique().references(() => profiles.id),
  colors: jsonb('colors').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Highlight = typeof highlights.$inferSelect;
export type NewHighlight = typeof highlights.$inferInsert;
export type HighlightPalette = typeof highlightPalette.$inferSelect;
export type NewHighlightPalette = typeof highlightPalette.$inferInsert;
