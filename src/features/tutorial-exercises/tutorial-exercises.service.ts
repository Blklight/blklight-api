import { eq, and, isNull, asc } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db/index';
import { tutorialExercises, exerciseSubmissions, TutorialExercise } from './tutorial-exercises.schema';
import { documents, documentTypes } from '../documents/documents.schema';
import { executeCode, type SupportedLanguage } from '../../utils/sandbox';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import type { CreateExerciseInput, UpdateExerciseInput, SubmitAnswerInput } from './tutorial-exercises.zod';

export interface SubmissionResult {
  isCorrect: boolean;
  attemptsCount: number;
}

async function getDocumentAuthorId(documentId: string): Promise<string | null> {
  const result = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);
  return result.length > 0 ? result[0]!.authorId : null;
}

/**
 * Validate that a document exists, is not deleted, and is of type 'tutorial'.
 * @param documentId - The document ID to validate
 * @throws NotFoundError if document not found or deleted
 * @throws ValidationError if document type is not 'tutorial'
 */
export async function validateTutorialType(documentId: string): Promise<void> {
  const result = await db
    .select({
      id: documents.id,
      typeName: documentTypes.name,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.typeId, documentTypes.id))
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (result.length === 0) {
    throw new NotFoundError('Document not found');
  }

  const doc = result[0]!;
  if (doc.typeName !== 'tutorial') {
    throw new ValidationError('Document type must be tutorial');
  }
}

/**
 * Create a new exercise for a tutorial document.
 * @param authorId - The author's profile ID
 * @param documentId - The document ID
 * @param data - The exercise data (code or quiz type)
 * @returns The created exercise
 * @throws NotFoundError if document not found
 * @throws ValidationError if document is not a tutorial
 * @throws ForbiddenError if author does not own the document
 */
export async function createExercise(
  authorId: string,
  documentId: string,
  data: CreateExerciseInput
): Promise<TutorialExercise> {
  await validateTutorialType(documentId);

  const docAuthorId = await getDocumentAuthorId(documentId);
  if (docAuthorId !== authorId) {
    throw new ForbiddenError('You do not own this document');
  }

  const now = new Date();
  const newExercise = {
    id: createId(),
    documentId,
    type: data.type,
    data: data.data as unknown as Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(tutorialExercises).values(newExercise);

  const created = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.id, newExercise.id))
    .limit(1);

  return created[0]!;
}

/**
 * Update an existing exercise.
 * @param authorId - The author's profile ID
 * @param id - The exercise ID
 * @param data - The partial exercise data to update
 * @returns The updated exercise
 * @throws NotFoundError if exercise not found
 * @throws ForbiddenError if author does not own the document
 */
export async function updateExercise(
  authorId: string,
  id: string,
  data: UpdateExerciseInput
): Promise<TutorialExercise> {
  const exerciseResult = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.id, id))
    .limit(1);

  if (exerciseResult.length === 0) {
    throw new NotFoundError('Exercise not found');
  }

  const exercise = exerciseResult[0]!;
  const docAuthorId = await getDocumentAuthorId(exercise.documentId);
  if (docAuthorId !== authorId) {
    throw new ForbiddenError('You do not own this document');
  }

  const existingData = exercise.data as Record<string, unknown>;
  const newData = { ...existingData, ...data.data };

  const now = new Date();
  await db
    .update(tutorialExercises)
    .set({ data: newData, updatedAt: now })
    .where(eq(tutorialExercises.id, id));

  const updated = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.id, id))
    .limit(1);

  return updated[0]!;
}

/**
 * Delete an exercise.
 * @param authorId - The author's profile ID
 * @param id - The exercise ID
 * @throws NotFoundError if exercise not found
 * @throws ForbiddenError if author does not own the document
 */
export async function deleteExercise(authorId: string, id: string): Promise<void> {
  const exerciseResult = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.id, id))
    .limit(1);

  if (exerciseResult.length === 0) {
    throw new NotFoundError('Exercise not found');
  }

  const exercise = exerciseResult[0]!;
  const docAuthorId = await getDocumentAuthorId(exercise.documentId);
  if (docAuthorId !== authorId) {
    throw new ForbiddenError('You do not own this document');
  }

  await db.delete(tutorialExercises).where(eq(tutorialExercises.id, id));
}

/**
 * Get all exercises for a document. Correct answers are stripped from the response.
 * @param documentId - The document ID
 * @param viewerProfileId - Profile reading the exercises; only the author can read a draft's
 * @returns Array of exercises with answers hidden
 * @throws NotFoundError if document not found
 */
export async function getExercises(documentId: string, viewerProfileId?: string): Promise<unknown[]> {
  const [doc] = await db
    .select({ id: documents.id, status: documents.status, authorId: documents.authorId })
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  // Drafts are visible to their author only; 404 keeps them unlisted.
  if (!doc || (doc.status !== 'published' && doc.authorId !== viewerProfileId)) {
    throw new NotFoundError('Document not found');
  }

  const exercises = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.documentId, documentId))
    .orderBy(asc(tutorialExercises.createdAt));

  return exercises.map((ex) => {
    const data = ex.data as Record<string, unknown>;
    if (ex.type === 'code') {
      const { expectedOutput, ...safeData } = data;
      return { ...ex, data: safeData };
    }
    if (ex.type === 'quiz') {
      const { correctIndex, ...safeData } = data;
      return { ...ex, data: safeData };
    }
    return ex;
  });
}

/**
 * Submit an answer to an exercise.
 * @param profileId - The profile ID of the submitting user
 * @param exerciseId - The exercise ID
 * @param submission - The answer submission
 * @returns Result indicating if the answer is correct and attempt count
 * @throws NotFoundError if exercise not found
 */
export async function submitAnswer(
  profileId: string,
  exerciseId: string,
  submission: SubmitAnswerInput
): Promise<SubmissionResult> {
  const exerciseResult = await db
    .select()
    .from(tutorialExercises)
    .where(eq(tutorialExercises.id, exerciseId))
    .limit(1);

  if (exerciseResult.length === 0) {
    throw new NotFoundError('Exercise not found');
  }

  const exercise = exerciseResult[0]!;
  const data = exercise.data as Record<string, unknown>;

  let isCorrect = false;

  if (submission.type === 'quiz') {
    const correctIndex = data.correctIndex as number;
    isCorrect = submission.answerIndex === correctIndex;
  } else {
    const expectedOutput = data.expectedOutput as string;
    const language = data.language as SupportedLanguage;
    const output = await executeCode(submission.code, language);
    isCorrect = output.trim() === expectedOutput.trim();
  }

  const attempt = {
    isCorrect,
    submittedAt: new Date().toISOString(),
    codeSubmitted: submission.type === 'code' ? submission.code : null,
  };

  const existingSubmission = await db
    .select()
    .from(exerciseSubmissions)
    .where(
      and(
        eq(exerciseSubmissions.profileId, profileId),
        eq(exerciseSubmissions.exerciseId, exerciseId)
      )
    )
    .limit(1);

  if (existingSubmission.length > 0) {
    const current = existingSubmission[0]!;
    const currentAttempts = (current.attempts as unknown[]) ?? [];
    const updatedAttempts = [...currentAttempts, attempt];

    await db
      .update(exerciseSubmissions)
      .set({ attempts: updatedAttempts as unknown, updatedAt: new Date() })
      .where(eq(exerciseSubmissions.id, current.id));

    return { isCorrect, attemptsCount: updatedAttempts.length };
  }

  const newSubmission = {
    id: createId(),
    profileId,
    exerciseId,
    attempts: [attempt],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(exerciseSubmissions).values(newSubmission);

  return { isCorrect, attemptsCount: 1 };
}
