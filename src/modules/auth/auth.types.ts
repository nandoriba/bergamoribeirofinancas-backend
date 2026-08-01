import { PlatformRole } from '@prisma/client';

export type TenantRole = 'owner' | 'member';

export interface AuthenticatedUser {
  id: string;
  email: string;
  platformRole: PlatformRole;
  tenantRole: TenantRole;
  familyId: string;
  profileId: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  platformRole: PlatformRole;
  tenantRole: TenantRole;
  familyId: string;
  profileId: string;
}
