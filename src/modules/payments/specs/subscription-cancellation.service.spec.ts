import { ConfigService } from "@nestjs/config";
import {
  PlatformRole,
  Prisma,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../../../prisma/prisma.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import type { PaymentProvider } from "../payment-provider";
import {
  addUtcMonthsClamped,
  SubscriptionCancellationService,
} from "../subscription-cancellation.service";

describe("addUtcMonthsClamped", () => {
  it.each([
    ["fim de mês", "2024-01-31T10:15:00.000Z", 1, "2024-02-29T10:15:00.000Z"],
    [
      "ano bissexto",
      "2024-02-29T10:15:00.000Z",
      12,
      "2025-02-28T10:15:00.000Z",
    ],
    [
      "retenção padrão",
      "2026-08-01T12:00:00.000Z",
      12,
      "2027-08-01T12:00:00.000Z",
    ],
  ])("%s", (_label, source, months, expected) => {
    expect(addUtcMonthsClamped(new Date(source), months).toISOString()).toBe(
      expected,
    );
  });
});

describe("SubscriptionCancellationService", () => {
  const user: AuthenticatedUser = {
    id: "owner-1",
    email: "owner@example.com",
    platformRole: PlatformRole.user,
    tenantRole: "owner",
    familyId: "family-1",
    profileId: "profile-1",
  };

  function fixture() {
    const subscription = {
      id: "subscription-1",
      familyId: user.familyId,
      provider: "abacatepay",
      externalId: "local-1",
      providerSubscriptionId: "subs_123",
      providerCustomerId: "cust_123",
      providerCheckoutId: "bill_123",
      providerCheckoutUrl: "https://example.test/checkout",
      providerCheckoutStatus: "PAID",
      providerProductId: "prod_123",
      providerStatus: "ACTIVE",
      lastProviderEvent: "subscription.renewed",
      providerUpdatedAt: new Date("2026-07-01T12:00:01.000Z"),
      lastSuccessfulPaymentAt: new Date("2026-07-01T12:00:00.000Z"),
      accessPaidThrough: new Date(Date.now() + 86_400_000),
      paymentFailedAt: null,
      graceUntil: null,
      cancelledAt: null,
      cancelledDueTo: null,
      lastInstallmentNumber: 2,
      entitlementContractVersion: "sandbox-contract-v1",
      amountCents: 1990,
      currency: "BRL",
      paymentMethod: SubscriptionPaymentMethod.CARD,
      providerPaymentMethod: "CARD",
      billingCycle: SubscriptionCycle.MONTHLY,
      devMode: true,
      checkoutProvisioningStatus: "ready",
      checkoutCreationAllowed: false,
      checkoutAttempts: 1,
      checkoutClaimToken: null,
      checkoutLockedAt: null,
      checkoutReadyAt: new Date(),
      checkoutClosedAt: null,
      checkoutCloseReason: null,
      checkoutLastErrorCode: null,
      cancelRequestedAt: null,
      cancelClaimToken: null,
      cancelLockedAt: null,
      cancelAttempts: 0,
      cancelLastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: user.familyId }]),
      family: {
        findUnique: vi.fn().mockImplementation(({ select }) =>
          Promise.resolve(
            select.currentSubscription
              ? { ownerUserId: user.id, currentSubscription: subscription }
              : {
                  ownerUserId: user.id,
                  currentSubscriptionId: subscription.id,
                  cancelledAt: null,
                  purgeAfter: null,
                },
          ),
        ),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: {
        findUnique: vi.fn().mockResolvedValue(subscription),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
      subscription: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const provider = {
      cancelSubscription: vi.fn().mockResolvedValue({
        id: "subs_123",
        customerId: "cust_123",
        amountCents: 1990,
        currency: "BRL",
        method: "CARD",
        status: "CANCELLED",
        devMode: true,
      }),
    };
    const config = new ConfigService({
      NODE_ENV: "test",
      RETENTION_CANCELLED_MONTHS: 12,
    });
    const service = new SubscriptionCancellationService(
      prisma as unknown as PrismaService,
      config,
      provider as unknown as PaymentProvider,
    );
    return { service, prisma, provider, tx, subscription };
  }

  it("confirma uma única chamada e persiste bloqueio e retenção", async () => {
    const { service, provider, tx } = fixture();

    await expect(service.cancel(user)).resolves.toMatchObject({
      effectiveStatus: "cancelled",
    });
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
    expect(tx.subscription.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.family.updateMany).toHaveBeenCalledOnce();
  });

  it("repete SQLSTATE 40001 encapsulado como P2010 antes de chamar o provider", async () => {
    const { service, prisma, provider } = fixture();
    prisma.$transaction
      .mockRejectedValueOnce(rawQueryError("40001"))
      .mockRejectedValueOnce(rawQueryError("40001"));

    await expect(service.cancel(user)).resolves.toMatchObject({
      effectiveStatus: "cancelled",
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });

  it("não repete P2010 com SQLSTATE não serializável", async () => {
    const { service, prisma, provider } = fixture();
    const error = rawQueryError("23505");
    prisma.$transaction.mockRejectedValueOnce(error);

    await expect(service.cancel(user)).rejects.toBe(error);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it("mantém cancelRequestedAt e não repete POST quando o resultado é ambíguo", async () => {
    const { service, provider, prisma } = fixture();
    provider.cancelSubscription.mockRejectedValueOnce(new Error("timeout"));

    await expect(service.cancel(user)).rejects.toMatchObject({
      response: { code: "CANCELLATION_CONFIRMATION_REQUIRED" },
    });
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.any(Object),
    );
    expect(
      prisma.subscription.updateMany.mock.calls[0]![0].data,
    ).not.toHaveProperty("cancelRequestedAt");
  });

  it("reconhece idempotentemente quando o webhook vence a finalização local", async () => {
    const { service, tx, subscription } = fixture();
    const cancelledAt = new Date("2026-08-01T12:00:00.000Z");
    const purgeAfter = new Date("2027-08-01T12:00:00.000Z");
    tx.subscription.findUnique.mockResolvedValue({
      ...subscription,
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt,
    });
    tx.family.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscription: subscription,
      })
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscriptionId: subscription.id,
        cancelledAt,
        purgeAfter,
      });

    await expect(service.cancel(user)).resolves.toEqual({
      effectiveStatus: "cancelled",
      cancelledAt: cancelledAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    });
    expect(tx.subscription.updateMany).toHaveBeenCalledOnce();
    expect(tx.family.updateMany).not.toHaveBeenCalled();
  });

  it("reconhece confirmação do webhook durante timeout sem reenviar cancelamento", async () => {
    const { service, provider, prisma, subscription } = fixture();
    const cancelledAt = new Date("2026-08-01T12:00:00.000Z");
    const purgeAfter = new Date("2027-08-01T12:00:00.000Z");
    provider.cancelSubscription.mockRejectedValueOnce(new Error("timeout"));
    prisma.subscription.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.subscription.findUnique.mockResolvedValueOnce({
      ...subscription,
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt,
      currentForFamily: { cancelledAt, purgeAfter },
    });

    await expect(service.cancel(user)).resolves.toEqual({
      effectiveStatus: "cancelled",
      cancelledAt: cancelledAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    });
    expect(provider.cancelSubscription).toHaveBeenCalledOnce();
  });

  it("conclui cancelamento externo se refund revogar acesso durante o POST", async () => {
    const { service, tx, subscription } = fixture();
    const revokedAt = new Date("2026-08-01T11:59:00.000Z");
    const purgeAfter = new Date("2027-08-01T11:59:00.000Z");
    tx.subscription.findUnique.mockResolvedValue({
      ...subscription,
      providerStatus: "ACTIVE",
      lastProviderEvent: "checkout.refunded",
      cancelledAt: revokedAt,
      cancelledDueTo: "provider_checkout_refunded",
    });
    tx.family.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscription: subscription,
      })
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscriptionId: subscription.id,
        cancelledAt: revokedAt,
        purgeAfter,
      });

    await expect(service.cancel(user)).resolves.toEqual({
      effectiveStatus: "cancelled",
      cancelledAt: revokedAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    });
    expect(tx.subscription.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.subscription.updateMany.mock.calls[1]![0].data).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledDueTo: "provider_checkout_refunded",
    });
    expect(tx.family.updateMany).not.toHaveBeenCalled();
  });

  it("permite ao owner encerrar a recorrência depois de refund já revogar o tenant", async () => {
    const { service, provider, tx, subscription } = fixture();
    const revokedAt = new Date("2026-08-01T11:59:00.000Z");
    const purgeAfter = new Date("2027-08-01T11:59:00.000Z");
    Object.assign(subscription, {
      providerStatus: "ACTIVE",
      lastProviderEvent: "checkout.refunded",
      cancelledAt: revokedAt,
      cancelledDueTo: "provider_checkout_refunded",
    });
    tx.family.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscription: subscription,
      })
      .mockResolvedValueOnce({
        ownerUserId: user.id,
        currentSubscriptionId: subscription.id,
        cancelledAt: revokedAt,
        purgeAfter,
      });

    await expect(service.cancel(user)).resolves.toEqual({
      effectiveStatus: "cancelled",
      cancelledAt: revokedAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    });
    expect(provider.cancelSubscription).toHaveBeenCalledWith("subs_123");
    expect(tx.subscription.updateMany.mock.calls[0]![0].where).toMatchObject({
      cancelledAt: revokedAt,
    });
    expect(tx.subscription.updateMany.mock.calls[1]![0].data).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledDueTo: "provider_checkout_refunded",
    });
  });

  it("limpa o claim ambíguo se refund vencer um timeout sem fingir cancelamento externo", async () => {
    const { service, provider, prisma, subscription } = fixture();
    const revokedAt = new Date("2026-08-01T11:59:00.000Z");
    provider.cancelSubscription.mockRejectedValueOnce(new Error("timeout"));
    prisma.subscription.findUnique.mockResolvedValue({
      ...subscription,
      providerStatus: "ACTIVE",
      lastProviderEvent: "checkout.refunded",
      cancelledAt: revokedAt,
      currentForFamily: {
        cancelledAt: revokedAt,
        purgeAfter: new Date("2027-08-01T11:59:00.000Z"),
      },
    });

    await expect(service.cancel(user)).rejects.toMatchObject({
      response: { code: "CANCELLATION_CONFIRMATION_REQUIRED" },
    });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cancelClaimToken: expect.any(String),
        }),
        data: expect.objectContaining({
          cancelClaimToken: null,
          cancelLastErrorCode: "PROVIDER_RESPONSE_REJECTED",
        }),
      }),
    );
  });
});

function rawQueryError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("simulated raw query error", {
    code: "P2010",
    clientVersion: "6.1.0",
    meta: { code: sqlState },
  });
}
