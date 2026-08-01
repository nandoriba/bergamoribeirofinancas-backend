import { SetMetadata } from "@nestjs/common";

export const ALLOW_BLOCKED_TENANT_ACCESS_KEY = "allowBlockedTenantAccess";

/** Explicit escape hatch for session, billing, logout and support routes only. */
export const AllowBlockedTenantAccess = () =>
  SetMetadata(ALLOW_BLOCKED_TENANT_ACCESS_KEY, true);
