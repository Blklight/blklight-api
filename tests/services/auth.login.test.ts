import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../src/db/index', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => rows.value }) }),
    })),
  },
}));

vi.mock('../../src/utils/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/crypto')>('../../src/utils/crypto');
  return { ...actual, verifyPasswordDummy: vi.fn(async () => undefined) };
});

vi.mock('../../src/features/signatures/signatures.service', () => ({}));
vi.mock('../../src/features/profiles/profiles.service', () => ({}));

import { loginUser } from '../../src/features/auth/auth.service';
import { verifyPasswordDummy } from '../../src/utils/crypto';
import { UnauthorizedError } from '../../src/utils/errors';

describe('loginUser timing parity', () => {
  beforeEach(() => {
    vi.mocked(verifyPasswordDummy).mockClear();
  });

  it('runs the dummy check when the account does not exist', async () => {
    rows.value = [];
    await expect(loginUser('ghost@example.com', 'Secret1!')).rejects.toThrow(UnauthorizedError);
    expect(verifyPasswordDummy).toHaveBeenCalledWith('Secret1!');
  });

  it('runs the dummy check for an OAuth-only account without a password', async () => {
    rows.value = [{ id: 'u1', deletedAt: null, passwordHash: null, salt: null }];
    await expect(loginUser('oauth@example.com', 'Secret1!')).rejects.toThrow(UnauthorizedError);
    expect(verifyPasswordDummy).toHaveBeenCalledTimes(1);
  });
});
