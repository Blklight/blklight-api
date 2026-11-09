import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { canvas } from '../canvas/canvas.schema';

export const notes = pgTable('notes', {
  id: text('id').primaryKey(),
  canvasId: text('canvas_id').notNull().references(() => canvas.id),
  title: text('title'),
  content: text('content').notNull(),
  type: text('type').default('text').notNull(),
  language: text('language'),
  color: text('color').default('yellow').notNull(),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  canvasIdx: index('notes_canvas_id_idx').on(table.canvasId),
}));

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;