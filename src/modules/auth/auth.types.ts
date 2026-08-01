import { PlatformRole } from '@prisma/client';

export type TenantRole = 'owner' | 'member';
export type RequiredAction = 'payment' | null;

export function requiredActionFromPendingPayment(
  pendingPaymentExpiresAt: Date | null,
): RequiredAction {
  return pendingPaymentExpiresAt === null ? null : 'payment';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  platformRole: PlatformRole;
  tenantRole: TenantRole;
  familyId: string;
  profileId: string;
  /**
   * Always populated by JwtStrategy and AuthService. Optional only for internal
   * non-HTTP tenant contexts that predate the onboarding access gate.
   */
  requiredAction?: RequiredAction;
}

export interface JwtPayload {
  jti: string;
  sub: string;
  email: string;
  platformRole: PlatformRole;
  tenantRole: TenantRole;
  familyId: string;
  profileId: string;
  authVersion: number;
}
