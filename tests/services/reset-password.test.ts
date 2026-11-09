import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'r1', userId: 'u1', expiresAt: new Date(Date.now() + 60_000), usedAt: null }],
        }),
      }),
    })),
    transaction: vi.fn(),
  },
}));

import { resetPassword } from '../../src/features/email/email.service';
import { ValidationError } from '../../src/utils/errors';

describe('resetPassword', () => {
  it('applies the registration password policy', async () => {
    await expect(resetPassword('token', 'password1')).rejects.toThrow(ValidationError);
    await expect(resetPassword('token', 'Password1')).rejects.toThrow(/special character/);
  });
});
