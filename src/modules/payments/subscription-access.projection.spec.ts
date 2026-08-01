import { SubscriptionCycle, SubscriptionPaymentMethod } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  evaluateSubscriptionProjection,
  type SubscriptionAccessProjection,
} from "./subscription-access.projection";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function activeProjection(
  patch: Partial<SubscriptionAccessProjection> = {},
): SubscriptionAccessProjection {
  return {
    providerStatus: "ACTIVE",
    lastProviderEvent: "subscription.renewed",
    providerUpdatedAt: new Date("2026-07-01T12:00:01.000Z"),
    lastSuccessfulPaymentAt: new Date("2026-07-01T12:00:00.000Z"),
    accessPaidThrough: new Date("2026-08-02T12:00:00.000Z"),
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: 2,
    entitlementContractVersion: "sandbox-contract-v1",
    billingCycle: SubscriptionCycle.MONTHLY,
    paymentMethod: SubscriptionPaymentMethod.CARD,
    ...patch,
  };
}

describe("evaluateSubscriptionProjection", () => {
  it("trata ponteiro corrente nulo como primeiro pagamento pendente", () => {
    expect(evaluateSubscriptionProjection(null, () => NOW)).toMatchObject({
      effectiveStatus: "pending_payment",
      accessAllowed: false,
    });
  });

  it("libera somente uma projeção paga completa", () => {
    expect(
      evaluateSubscriptionProjection(activeProjection(), () => NOW),
    ).toEqual({
      effectiveStatus: "active",
      accessAllowed: true,
      reason: "PAID_ACCESS",
    });
  });

  it("bloqueia imediatamente quando há pedido de cancelamento em voo", () => {
    expect(
      evaluateSubscriptionProjection(
        activeProjection({
          cancelRequestedAt: new Date("2026-08-01T11:00:00.000Z"),
        }),
        () => NOW,
      ),
    ).toMatchObject({ effectiveStatus: "suspended", accessAllowed: false });
  });
});
