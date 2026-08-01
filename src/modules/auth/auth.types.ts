import { PlatformRole } from '@prisma/client';

import type { SubscriptionAccessDecision } from '../payments/subscription-access.policy';

export type TenantRole = 'owner' | 'member';
export type RequiredAction = 'payment' | null;

export function requiredActionFromSubscriptionAccess(
  access: SubscriptionAccessDecision,
): RequiredAction {
  return access.accessAllowed ? null : 'payment';
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
  /** Freshly derived from the current subscription by JwtStrategy on every request. */
  subscriptionAccess?: SubscriptionAccessDecision;
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
