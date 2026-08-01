import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { TenantContext } from '../../shared/tenant-context';
import { AccountsService } from './accounts.service';

describe('AccountsService', () => {
  const user = {
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  } satisfies AuthenticatedUser;
  const context = TenantContext.fromAuthenticatedUser(user);

  it('lists the consolidated family view', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tenantScope = {
      resolveProfileIds: vi.fn().mockResolvedValue(['profile-1', 'inactive-profile']),
      byFamilyProfiles: vi.fn().mockReturnValue({ memberProfile: { familyId: 'family-1' } }),
    };
    const service = new AccountsService({ account: { findMany } } as never, tenantScope as never);

    await service.list(context);

    expect(tenantScope.resolveProfileIds).toHaveBeenCalledWith(context, { family: true, profileId: undefined });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        memberProfileId: { in: ['profile-1', 'inactive-profile'] },
        memberProfile: { familyId: 'family-1' },
      },
      include: { memberProfile: { select: { id: true, displayName: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  });

  it('applies an exact same-family profile filter and rejects invalid profiles before querying accounts', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const resolveProfileIds = vi.fn().mockResolvedValueOnce(['inactive-profile']).mockRejectedValueOnce(
      new Error('Perfil inválido'),
    );
    const tenantScope = {
      resolveProfileIds,
      byFamilyProfiles: vi.fn().mockReturnValue({ memberProfile: { familyId: 'family-1' } }),
    };
    const service = new AccountsService({ account: { findMany } } as never, tenantScope as never);

    await service.list(context, { profileId: 'inactive-profile' });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          memberProfileId: { in: ['inactive-profile'] },
          memberProfile: { familyId: 'family-1' },
        },
      }),
    );

    await expect(service.list(context, { profileId: 'foreign-profile' })).rejects.toThrow('Perfil inválido');
    expect(findMany).toHaveBeenCalledOnce();
  });

  it('blocks updates outside the author profile', async () => {
    const update = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new AccountsService({
      account: {
        findFirst,
        update,
      },
    } as never);

    await expect(service.update(context, 'account-from-other-profile', { name: 'Outra conta' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Conta não encontrada' }),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'account-from-other-profile', memberProfileId: 'profile-1' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the author profile in the final update and delete predicates', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'account-1', type: 'checking' });
    const update = vi.fn().mockResolvedValue({ id: 'account-1' });
    const remove = vi.fn().mockResolvedValue({ id: 'account-1' });
    const service = new AccountsService({ account: { findFirst, update, delete: remove } } as never);

    await service.update(context, 'account-1', { name: 'Conta pessoal' });
    await service.remove(context, 'account-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'account-1', memberProfileId: 'profile-1' } }),
    );
    expect(remove).toHaveBeenCalledWith({ where: { id: 'account-1', memberProfileId: 'profile-1' } });
  });

  it('clears credit-card-only fields when account type is not credit card', async () => {
    const create = vi.fn(async (args) => args.data);
    const service = new AccountsService({ account: { create } } as never);

    await service.create(context, {
      name: 'Conta corrente',
      type: 'checking',
      lastFourDigits: '1234',
      closingDay: 5,
      dueDay: 10,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberProfileId: context.authorProfileId,
          lastFourDigits: null,
          closingDay: null,
          dueDay: null,
        }),
      }),
    );
  });
});
