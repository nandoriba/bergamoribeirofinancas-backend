import { PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../modules/auth/auth.types';
import { TenantContext } from '../shared/tenant-context';
import { TenantScopeService } from './tenant-scope.service';

const context = TenantContext.fromAuthenticatedUser({
  id: 'user-1',
  email: 'membro@example.com',
  platformRole: PlatformRole.admin,
  tenantRole: 'member',
  familyId: 'family-1',
  profileId: 'profile-1',
} satisfies AuthenticatedUser);

describe('TenantScopeService', () => {
  it('mantém o admin de plataforma preso ao próprio tenant e perfil autor', () => {
    const service = new TenantScopeService({} as never);

    expect(service.byAuthor(context)).toEqual({ memberProfileId: 'profile-1' });
    expect(service.byFamily(context)).toEqual({ familyId: 'family-1' });
    expect(service.byFamilyProfiles(context)).toEqual({ memberProfile: { familyId: 'family-1' } });
  });

  it('resolve a visão consolidada com perfis ativos e inativos, excluindo pendentes', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'profile-1' }, { id: 'profile-2' }]);
    const service = new TenantScopeService({ memberProfile: { findMany } } as never);

    await expect(service.resolveProfileIds(context, { family: true })).resolves.toEqual(['profile-1', 'profile-2']);
    expect(findMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', status: { in: ['active', 'inactive'] } },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });
  });

  it('valida o filtro de perfil contra a família e os estados financeiros visíveis', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new TenantScopeService({ memberProfile: { findFirst } } as never);

    await expect(service.resolveProfileIds(context, { profileId: 'foreign-profile' })).rejects.toThrow('Perfil inválido');
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-profile',
        familyId: 'family-1',
        status: { in: ['active', 'inactive'] },
      },
      select: { id: true },
    });
  });

  it('aceita explicitamente um perfil inativo da família para consultar o histórico', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'inactive-profile' });
    const service = new TenantScopeService({ memberProfile: { findFirst } } as never);

    await expect(service.resolveProfileIds(context, { profileId: 'inactive-profile' })).resolves.toEqual([
      'inactive-profile',
    ]);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'inactive-profile',
        familyId: 'family-1',
        status: { in: ['active', 'inactive'] },
      },
      select: { id: true },
    });
  });

  it('usa somente o perfil autor quando a visão familiar não é solicitada', async () => {
    const service = new TenantScopeService({} as never);
    await expect(service.resolveProfileIds(context)).resolves.toEqual(['profile-1']);
  });
});
