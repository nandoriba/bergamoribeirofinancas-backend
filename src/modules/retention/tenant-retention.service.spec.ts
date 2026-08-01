import { ConfigService } from "@nestjs/config";
import {
  CheckoutProvisioningStatus,
  Prisma,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../../prisma/prisma.service";
import type { PaymentsService } from "../payments/payments.service";
import {
  TenantRetentionService,
  evaluateRetentionEligibility,
  type RetentionFamilySnapshot,
  type RetentionSubscriptionSnapshot,
} from "./tenant-retention.service";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function pendingSubscription(
  patch: Partial<RetentionSubscriptionSnapshot> = {},
): RetentionSubscriptionSnapshot {
  return {
    id: "subscription-1",
    providerSubscriptionId: null,
    providerStatus: null,
    lastProviderEvent: null,
    providerUpdatedAt: null,
    lastSuccessfulPaymentAt: null,
    accessPaidThrough: null,
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: null,
    entitlementContractVersion: null,
    billingCycle: SubscriptionCycle.MONTHLY,
    paymentMethod: null,
    providerCheckoutId: null,
    providerCheckoutStatus: null,
    checkoutProvisioningStatus: CheckoutProvisioningStatus.pending,
    checkoutCreationAllowed: true,
    checkoutClaimToken: null,
    checkoutLockedAt: null,
    cancelClaimToken: null,
    cancelLockedAt: null,
    ...patch,
  };
}

function family(
  patch: Partial<RetentionFamilySnapshot> = {},
): RetentionFamilySnapshot {
  return {
    id: "family-1",
    pendingPaymentExpiresAt: new Date(NOW.getTime() - 1),
    cancelledAt: null,
    purgeAfter: null,
    currentSubscription: pendingSubscription(),
    ...patch,
  };
}

describe("TenantRetentionService serializable retry", () => {
  it.each([
    ["P2034", prismaRequestError("P2034")],
    ["P2010/SQLSTATE 40001", prismaRequestError("P2010", "40001")],
  ])("repete conflito serializável exposto como %s", async (_label, error) => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("ok");
    const service = serializableRetryHarness(transaction);

    await expect(service.withSerializableRetry(vi.fn())).resolves.toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("não repete P2010 com SQLSTATE diferente", async () => {
    const error = prismaRequestError("P2010", "23505");
    const transaction = vi.fn().mockRejectedValueOnce(error);
    const service = serializableRetryHarness(transaction);

    await expect(service.withSerializableRetry(vi.fn())).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("TenantRetentionService pre-purge reconciliation", () => {
  it("consulta o provider antes de abrir a transação que bloqueia o tenant", async () => {
    let transactionActive = false;
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "family-pre-purge" }]),
      family: { findUnique: vi.fn(async () => null) },
    };
    const prisma = {
      tenantPurgeRun: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => ({ id: "run-1" })),
        update: vi.fn(async () => ({ id: "run-1" })),
      },
      family: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "family-pre-purge" }])
          .mockResolvedValueOnce([]),
      },
      $transaction: vi.fn(
        async (operation: (client: typeof tx) => Promise<unknown>) => {
          transactionActive = true;
          try {
            return await operation(tx);
          } finally {
            transactionActive = false;
          }
        },
      ),
    };
    const payments = {
      reconcileCheckoutBeforeRetention: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        return false;
      }),
    };
    const service = new TenantRetentionService(
      prisma as unknown as PrismaService,
      new ConfigService({ RETENTION_PURGE_BATCH_SIZE: 20 }),
      payments as unknown as PaymentsService,
    );

    await expect(service.run(NOW)).resolves.toMatchObject({
      pendingPaymentPurged: 0,
      cancelledPurged: 0,
    });
    expect(payments.reconcileCheckoutBeforeRetention).toHaveBeenCalledWith(
      "family-pre-purge",
      NOW,
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});

describe("evaluateRetentionEligibility", () => {
  it.each([
    ["um milissegundo antes", new Date(NOW.getTime() + 1), null],
    ["no limite exato", NOW, "pending_payment"],
    ["depois do limite", new Date(NOW.getTime() - 1), "pending_payment"],
  ])("aplica o limite pending: %s", (_label, expiry, expected) => {
    expect(
      evaluateRetentionEligibility(
        family({ pendingPaymentExpiresAt: expiry }),
        NOW,
        900,
      ),
    ).toBe(expected);
  });

  it("purga cancelado no limite exato de purgeAfter", () => {
    const cancelledAt = new Date("2025-08-01T12:00:00.000Z");
    expect(
      evaluateRetentionEligibility(
        family({
          pendingPaymentExpiresAt: null,
          cancelledAt,
          purgeAfter: NOW,
          currentSubscription: pendingSubscription({
            providerStatus: "CANCELLED",
            lastProviderEvent: "subscription.cancelled",
            cancelledAt,
            cancelledDueTo: "owner_requested",
          }),
        }),
        NOW,
        900,
      ),
    ).toBe("cancelled");
  });

  it.each(["checkout.refunded", "checkout.disputed"])(
    "não purga revogação %s enquanto a recorrência externa não foi cancelada",
    (lastProviderEvent) => {
      const revokedAt = new Date("2025-08-01T12:00:00.000Z");
      expect(
        evaluateRetentionEligibility(
          family({
            pendingPaymentExpiresAt: null,
            cancelledAt: revokedAt,
            purgeAfter: NOW,
            currentSubscription: pendingSubscription({
              providerStatus: "ACTIVE",
              providerSubscriptionId: "subs_still_active",
              lastProviderEvent,
              checkoutProvisioningStatus:
                CheckoutProvisioningStatus.ambiguous,
              checkoutCreationAllowed: false,
              cancelledAt: revokedAt,
              cancelledDueTo: `provider_${lastProviderEvent.replace(".", "_")}`,
            }),
          }),
          NOW,
          900,
        ),
      ).toBeNull();
    },
  );

  it("mantém retenção original durante nova assinatura e purga somente se o novo prazo também venceu", () => {
    const retained = family({
      cancelledAt: new Date("2025-08-01T12:00:00.000Z"),
      purgeAfter: NOW,
      pendingPaymentExpiresAt: new Date(NOW.getTime() + 1),
    });
    expect(evaluateRetentionEligibility(retained, NOW, 900)).toBeNull();
    retained.pendingPaymentExpiresAt = NOW;
    expect(evaluateRetentionEligibility(retained, NOW, 900)).toBe("cancelled");
  });

  it.each([
    [
      "checkout em processamento",
      { checkoutProvisioningStatus: CheckoutProvisioningStatus.processing },
    ],
    [
      "resultado ambíguo",
      { checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous },
    ],
    [
      "checkout pendente no provider",
      { providerCheckoutId: "bill_1", providerCheckoutStatus: "PENDING" },
    ],
    [
      "checkout pago sem webhook",
      { providerCheckoutId: "bill_1", providerCheckoutStatus: "PAID" },
    ],
    ["criação possivelmente enviada", { checkoutCreationAllowed: false }],
    [
      "lease fresco",
      {
        checkoutClaimToken: "claim",
        checkoutLockedAt: new Date(NOW.getTime() - 1),
      },
    ],
  ])("não purga %s", (_label, patch) => {
    expect(
      evaluateRetentionEligibility(
        family({ currentSubscription: pendingSubscription(patch) }),
        NOW,
        900,
      ),
    ).toBeNull();
  });

  it("aceita checkout terminal como seguro para a faxina", () => {
    expect(
      evaluateRetentionEligibility(
        family({
          currentSubscription: pendingSubscription({
            providerCheckoutId: "bill_1",
            providerCheckoutStatus: "EXPIRED",
            checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
            checkoutCreationAllowed: false,
          }),
        }),
        NOW,
        900,
      ),
    ).toBe("pending_payment");
  });

  it("não trata REFUNDED como terminal seguro mesmo sem assinatura vinculada", () => {
    expect(
      evaluateRetentionEligibility(
        family({
          currentSubscription: pendingSubscription({
            providerCheckoutId: "bill_1",
            providerCheckoutStatus: "REFUNDED",
            checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
            checkoutCreationAllowed: false,
          }),
        }),
        NOW,
        900,
      ),
    ).toBeNull();
  });

  it("aceita cancelamento confirmado por reconciliação autenticada", () => {
    const cancelledAt = new Date("2025-08-01T12:00:00.000Z");
    expect(
      evaluateRetentionEligibility(
        family({
          pendingPaymentExpiresAt: null,
          cancelledAt,
          purgeAfter: NOW,
          currentSubscription: pendingSubscription({
            providerSubscriptionId: "subs_reconciled",
            providerStatus: "CANCELLED",
            lastProviderEvent: "subscription.reconciled_cancelled",
            cancelledAt,
            cancelledDueTo: "owner_requested",
          }),
        }),
        NOW,
        900,
      ),
    ).toBe("cancelled");
  });

  it("purga cancelamento confirmado mesmo com checkout local ambíguo", () => {
    const cancelledAt = new Date("2025-08-01T12:00:00.000Z");
    expect(
      evaluateRetentionEligibility(
        family({
          pendingPaymentExpiresAt: null,
          cancelledAt,
          purgeAfter: NOW,
          currentSubscription: pendingSubscription({
            providerSubscriptionId: "subs_cancelled_after_ambiguity",
            providerStatus: "CANCELLED",
            lastProviderEvent: "subscription.cancelled",
            cancelledAt,
            cancelledDueTo: "owner_requested",
            checkoutProvisioningStatus:
              CheckoutProvisioningStatus.ambiguous,
            checkoutCreationAllowed: false,
          }),
        }),
        NOW,
        900,
      ),
    ).toBe("cancelled");
  });

  it("nunca purga active ou past_due apenas porque há deadline antigo", () => {
    const active = pendingSubscription({
      providerStatus: "ACTIVE",
      lastProviderEvent: "subscription.renewed",
      providerUpdatedAt: new Date("2026-07-01T12:00:01.000Z"),
      lastSuccessfulPaymentAt: new Date("2026-07-01T12:00:00.000Z"),
      accessPaidThrough: new Date("2026-08-02T12:00:00.000Z"),
      lastInstallmentNumber: 2,
      entitlementContractVersion: "sandbox-contract-v1",
      paymentMethod: SubscriptionPaymentMethod.CARD,
    });
    expect(
      evaluateRetentionEligibility(
        family({ currentSubscription: active }),
        NOW,
        900,
      ),
    ).toBeNull();
  });

  it("falha fechado para snapshot contraditório", () => {
    expect(
      evaluateRetentionEligibility(
        family({
          currentSubscription: pendingSubscription({
            providerStatus: "UNKNOWN",
          }),
        }),
        NOW,
        900,
      ),
    ).toBeNull();
  });
});

function serializableRetryHarness(transaction: ReturnType<typeof vi.fn>) {
  const service = new TenantRetentionService(
    { $transaction: transaction } as unknown as PrismaService,
    new ConfigService(),
    {
      reconcileCheckoutBeforeRetention: vi.fn(),
    } as unknown as PaymentsService,
  );
  return service as unknown as {
    withSerializableRetry<T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T>;
  };
}

function prismaRequestError(
  code: string,
  sqlState?: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("simulated Prisma error", {
    code,
    clientVersion: "6.1.0",
    ...(sqlState ? { meta: { code: sqlState } } : {}),
  });
}
