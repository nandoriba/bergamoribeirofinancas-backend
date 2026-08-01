import {
  ALLOW_BLOCKED_TENANT_ACCESS_KEY,
  AllowBlockedTenantAccess,
} from './allow-blocked-tenant-access.decorator';

/** @deprecated Use AllowBlockedTenantAccess for every fail-closed subscription state. */
export const ALLOW_PENDING_PAYMENT_ACCESS_KEY = ALLOW_BLOCKED_TENANT_ACCESS_KEY;

/** @deprecated Use AllowBlockedTenantAccess. Kept as a compatibility alias. */
export const AllowPendingPaymentAccess = AllowBlockedTenantAccess;
