import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ doc: [] as unknown[], exercises: [] as unknown[] }));

vi.mock('../../src/db/index', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => state.doc,
          orderBy: async () => state.exercises,
        }),
      }),
    })),
  },
}));

import { getExercises } from '../../src/features/tutorial-exercises/tutorial-exercises.service';
import { NotFoundError } from '../../src/utils/errors';

describe('getExercises visibility', () => {
  it('hides a draft from anyone but its author', async () => {
    state.doc = [{ id: 'd1', status: 'draft', authorId: 'author' }];
    await expect(getExercises('d1', 'someone-else')).rejects.toThrow(NotFoundError);
    await expect(getExercises('d1')).rejects.toThrow(NotFoundError);
    await expect(getExercises('d1', 'author')).resolves.toEqual([]);
  });

  it('shows a published document to any viewer, without the answers', async () => {
    state.doc = [{ id: 'd1', status: 'published', authorId: 'author' }];
    state.exercises = [{ id: 'e1', type: 'quiz', data: { question: 'q', correctIndex: 2 } }];
    await expect(getExercises('d1', 'someone-else')).resolves.toEqual([
      { id: 'e1', type: 'quiz', data: { question: 'q' } },
    ]);
  });
});
