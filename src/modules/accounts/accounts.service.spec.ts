import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AccountsService } from './accounts.service';

describe('AccountsService', () => {
  const user: AuthenticatedUser = {
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  };

  it('allows viewing family accounts but blocks updates outside the logged profile', async () => {
    const update = vi.fn();
    const service = new AccountsService({
      account: {
        findFirst: vi.fn().mockResolvedValue(null),
        update,
      },
    } as never);

    await expect(service.update(user, 'account-from-other-profile', { name: 'Outra conta' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Conta não encontrada' }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('clears credit-card-only fields when account type is not credit card', async () => {
    const create = vi.fn(async (args) => args.data);
    const service = new AccountsService({ account: { create } } as never);

    await service.create(user, {
      name: 'Conta corrente',
      type: 'checking',
      lastFourDigits: '1234',
      closingDay: 5,
      dueDay: 10,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberProfileId: user.profileId,
          lastFourDigits: null,
          closingDay: null,
          dueDay: null,
        }),
      }),
    );
  });
});
