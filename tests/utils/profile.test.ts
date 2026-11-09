import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[], calls: 0 }));

vi.mock('../../src/db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            rows.calls += 1;
            return rows.value;
          },
        }),
      }),
    }),
  },
}));

import { resolveProfileIdFromUserId } from '../../src/utils/profile';
import { NotFoundError } from '../../src/utils/errors';

describe('resolveProfileIdFromUserId', () => {
  beforeEach(() => {
    rows.calls = 0;
  });

  it('queries once per user and serves repeats from memory', async () => {
    rows.value = [{ id: 'p-1' }];
    await expect(resolveProfileIdFromUserId('u-cache')).resolves.toBe('p-1');
    await expect(resolveProfileIdFromUserId('u-cache')).resolves.toBe('p-1');
    expect(rows.calls).toBe(1);
  });

  it('does not cache a missing profile (onboarding creates it later)', async () => {
    rows.value = [];
    await expect(resolveProfileIdFromUserId('u-new')).rejects.toThrow(NotFoundError);
    rows.value = [{ id: 'p-new' }];
    await expect(resolveProfileIdFromUserId('u-new')).resolves.toBe('p-new');
    expect(rows.calls).toBe(2);
  });
});
