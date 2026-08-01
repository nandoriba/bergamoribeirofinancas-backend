import { PlatformRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '../modules/auth/auth.types';
import { TenantContext } from './tenant-context';

const authenticatedUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'membro@example.com',
  platformRole: PlatformRole.user,
  tenantRole: 'member',
  familyId: 'family-1',
  profileId: 'profile-1',
};

describe('TenantContext', () => {
  it('deriva um contexto imutável somente dos dados da sessão revalidada', () => {
    const context = TenantContext.fromAuthenticatedUser(authenticatedUser);

    expect(context).toEqual({
      userId: 'user-1',
      platformRole: PlatformRole.user,
      tenantRole: 'member',
      familyId: 'family-1',
      authorProfileId: 'profile-1',
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it.each([
    undefined,
    { ...authenticatedUser, id: '' },
    { ...authenticatedUser, familyId: '' },
    { ...authenticatedUser, profileId: '' },
    { ...authenticatedUser, tenantRole: 'admin' as never },
  ])('falha fechado quando a sessão não contém um tenant válido', (user) => {
    expect(() => TenantContext.fromAuthenticatedUser(user)).toThrow('Sessão de tenant inválida');
  });
});
