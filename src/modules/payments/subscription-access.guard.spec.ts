import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PlatformRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ALLOW_BLOCKED_TENANT_ACCESS_KEY } from "../../shared/allow-blocked-tenant-access.decorator";
import { IS_PUBLIC_KEY } from "../../shared/public.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { SubscriptionAccessGuard } from "./subscription-access.guard";

function fixtureUser(
  subscriptionAccess?: AuthenticatedUser["subscriptionAccess"],
): AuthenticatedUser {
  return {
    id: "user-1",
    email: "owner@example.com",
    platformRole: PlatformRole.user,
    tenantRole: "owner",
    familyId: "family-1",
    profileId: "profile-1",
    requiredAction: subscriptionAccess?.accessAllowed ? null : "payment",
    subscriptionAccess,
  };
}

function context(user?: AuthenticatedUser): ExecutionContext {
  return {
    getHandler: () => fixtureUser,
    getClass: () => SubscriptionAccessGuard,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe("SubscriptionAccessGuard", () => {
  it.each([IS_PUBLIC_KEY, ALLOW_BLOCKED_TENANT_ACCESS_KEY])(
    "libera somente o escape explícito %s",
    (allowedKey) => {
      const reflector = {
        getAllAndOverride: vi.fn((key: string) => key === allowedKey),
      };
      const guard = new SubscriptionAccessGuard(
        reflector as unknown as Reflector,
      );

      expect(guard.canActivate(context())).toBe(true);
    },
  );

  it("libera active e past_due derivados", () => {
    const reflector = { getAllAndOverride: vi.fn(() => undefined) };
    const guard = new SubscriptionAccessGuard(
      reflector as unknown as Reflector,
    );

    for (const effectiveStatus of ["active", "past_due"] as const) {
      expect(
        guard.canActivate(
          context(
            fixtureUser({
              effectiveStatus,
              accessAllowed: true,
              reason: "PAID_ACCESS",
            }),
          ),
        ),
      ).toBe(true);
    }
  });

  it.each([
    ["pending_payment", "PAYMENT_REQUIRED"],
    ["suspended", "SUBSCRIPTION_SUSPENDED"],
    ["cancelled", "SUBSCRIPTION_CANCELLED"],
  ] as const)("nega %s por padrão", (effectiveStatus, code) => {
    const reflector = { getAllAndOverride: vi.fn(() => undefined) };
    const guard = new SubscriptionAccessGuard(
      reflector as unknown as Reflector,
    );

    expect(() =>
      guard.canActivate(
        context(
          fixtureUser({
            effectiveStatus,
            accessAllowed: false,
            reason: "CONTRADICTORY_FACTS",
          }),
        ),
      ),
    ).toThrowError(
      new ForbiddenException({
        code,
        message: "A assinatura não permite acesso a este recurso.",
      }),
    );
  });

  it("nega snapshot ausente em rota sem metadado (default deny)", () => {
    const reflector = { getAllAndOverride: vi.fn(() => undefined) };
    const guard = new SubscriptionAccessGuard(
      reflector as unknown as Reflector,
    );

    expect(() => guard.canActivate(context(fixtureUser()))).toThrowError(
      new ForbiddenException({
        code: "SUBSCRIPTION_ACCESS_UNAVAILABLE",
        message: "A assinatura não permite acesso a este recurso.",
      }),
    );
  });
});
