import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { users } from '../auth/auth.schema';
import { workspaces } from '../workspace/workspace.schema';
import { highlights } from '../highlights/highlights.schema';

export const journals = pgTable('journals', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  title: text('title').notNull(),
  description: text('description'),
  color: text('color').notNull().default('indigo'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index('journals_workspace_id_idx').on(table.workspaceId),
}));

export const journalHighlights = pgTable('journal_highlights', {
  id: text('id').primaryKey(),
  journalId: text('journal_id').notNull().references(() => journals.id),
  highlightId: text('highlight_id').notNull().references(() => highlights.id),
  position: integer('position').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  journalIdx: index('journal_highlights_journal_id_idx').on(table.journalId),
}));

export type Journal = typeof journals.$inferSelect;
export type NewJournal = typeof journals.$inferInsert;
export type JournalHighlight = typeof journalHighlights.$inferSelect;
export type NewJournalHighlight = typeof journalHighlights.$inferInsert;
