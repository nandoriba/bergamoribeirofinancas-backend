import type { ExecutionContext } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '../modules/auth/auth.types';
import { TenantOwnerGuard } from './tenant-owner.guard';

function contextFor(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantOwnerGuard', () => {
  const baseUser: AuthenticatedUser = {
    id: 'user-1',
    email: 'user@example.com',
    platformRole: PlatformRole.user,
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  };

  it('allows the derived tenant owner', () => {
    expect(new TenantOwnerGuard().canActivate(contextFor({ ...baseUser, tenantRole: 'owner' }))).toBe(true);
  });

  it('denies members even when they are platform admins', () => {
    expect(
      new TenantOwnerGuard().canActivate(
        contextFor({ ...baseUser, platformRole: PlatformRole.admin, tenantRole: 'member' }),
      ),
    ).toBe(false);
  });

  it('denies unauthenticated requests', () => {
    expect(new TenantOwnerGuard().canActivate(contextFor())).toBe(false);
  });
});
