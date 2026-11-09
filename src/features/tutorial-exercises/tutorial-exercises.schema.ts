import { pgTable, text, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { documents } from '../documents/documents.schema';
import { profiles } from '../profiles/profiles.schema';

export const tutorialExercises = pgTable('tutorial_exercises', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  documentIdx: index('tutorial_exercises_document_id_idx').on(table.documentId),
}));

export const exerciseSubmissions = pgTable('exercise_submissions', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().references(() => profiles.id),
  exerciseId: text('exercise_id').notNull().references(() => tutorialExercises.id),
  attempts: jsonb('attempts').notNull().default('[]'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  profileExerciseUnique: unique().on(table.profileId, table.exerciseId),
}));

export type TutorialExercise = typeof tutorialExercises.$inferSelect;
export type NewTutorialExercise = typeof tutorialExercises.$inferInsert;
export type ExerciseSubmission = typeof exerciseSubmissions.$inferSelect;
export type NewExerciseSubmission = typeof exerciseSubmissions.$inferInsert;
