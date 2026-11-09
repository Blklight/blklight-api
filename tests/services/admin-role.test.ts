import { describe, it, expect, vi } from 'vitest';

const calls = vi.hoisted(() => ({ deletedSessions: 0 }));

vi.mock('../../src/db/index', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'u1', role: 'admin' }] }) }),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: () => ({ where: () => ({ returning: async () => [{ id: 'u1', role: 'user' }] }) }),
        }),
        delete: () => ({
          where: async () => {
            calls.deletedSessions += 1;
          },
        }),
      })
    ),
  },
}));

import { updateUserRole } from '../../src/features/admin/admin.service';

describe('updateUserRole', () => {
  it('revokes the sessions of a user whose role changes', async () => {
    const updated = await updateUserRole('u1', 'user');
    expect(updated).toMatchObject({ role: 'user' });
    expect(calls.deletedSessions).toBe(1);
  });
});
