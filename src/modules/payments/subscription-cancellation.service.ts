import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Subscription } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import {
  PAYMENT_PROVIDER,
  PaymentProviderError,
  type CancelledPaymentSubscription,
  type PaymentProvider,
} from "./payment-provider";
import { evaluateSubscriptionProjection } from "./subscription-access.projection";

const SERIALIZABLE_RETRIES = 3;
const PROVIDER_RISK_EVENTS = new Set([
  "checkout.refunded",
  "checkout.disputed",
  "checkout.reconciled_refunded",
]);

interface CancellationClaim {
  subscription: Subscription;
  token: string;
}

export interface CancellationResult {
  effectiveStatus: "cancelled";
  cancelledAt: string;
  purgeAfter: string;
}

@Injectable()
export class SubscriptionCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async cancel(user: AuthenticatedUser): Promise<CancellationResult> {
    const claim = await this.claim(user);
    let providerResult: CancelledPaymentSubscription;

    try {
      providerResult = await this.provider.cancelSubscription(
        claim.subscription.providerSubscriptionId!,
      );
      this.assertProviderResult(providerResult, claim.subscription);
    } catch (error) {
      const concurrentlyConfirmed = await this.markAmbiguous(claim, error);
      if (concurrentlyConfirmed) return concurrentlyConfirmed;
      throw new ServiceUnavailableException({
        code: "CANCELLATION_CONFIRMATION_REQUIRED",
        message:
          "O cancelamento está bloqueado enquanto aguardamos confirmação segura do provedor.",
      });
    }

    const cancelledAt = new Date();

    return this.withSerializableRetry(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${user.familyId} FOR UPDATE
      `;
      const [current, family] = await Promise.all([
        tx.subscription.findUnique({
          where: { id: claim.subscription.id },
          select: {
            providerSubscriptionId: true,
            providerStatus: true,
            lastProviderEvent: true,
            cancelledAt: true,
            cancelledDueTo: true,
          },
        }),
        tx.family.findUnique({
          where: { id: user.familyId },
          select: {
            ownerUserId: true,
            currentSubscriptionId: true,
            cancelledAt: true,
            purgeAfter: true,
          },
        }),
      ]);
      if (
        !current ||
        !family ||
        family.ownerUserId !== user.id ||
        family.currentSubscriptionId !== claim.subscription.id
      ) {
        throw new Error("Current subscription changed.");
      }
      if (
        isConfirmedCancellation(
          current,
          claim.subscription.providerSubscriptionId!,
        )
      ) {
        const confirmedAt = current.cancelledAt!;
        const retainedUntil =
          family.purgeAfter ??
          addUtcMonthsClamped(confirmedAt, this.retentionMonths());
        if (!family.cancelledAt || !family.purgeAfter) {
          await tx.family.update({
            where: { id: user.familyId },
            data: {
              pendingPaymentExpiresAt: null,
              cancelledAt: confirmedAt,
              purgeAfter: retainedUntil,
            },
          });
        }
        return cancellationResult(confirmedAt, retainedUntil);
      }

      if ((family.cancelledAt === null) !== (family.purgeAfter === null)) {
        throw new Error("Family retention facts are inconsistent.");
      }
      const effectiveCancelledAt = current.cancelledAt ?? cancelledAt;
      const effectivePurgeAfter =
        family.purgeAfter ??
        addUtcMonthsClamped(effectiveCancelledAt, this.retentionMonths());

      const updated = await tx.subscription.updateMany({
        where: {
          id: claim.subscription.id,
          familyId: user.familyId,
          cancelClaimToken: claim.token,
        },
        data: {
          providerStatus: "CANCELLED",
          lastProviderEvent: "subscription.cancelled",
          cancelledAt: effectiveCancelledAt,
          cancelledDueTo: current.cancelledDueTo ?? "owner_requested",
          cancelClaimToken: null,
          cancelLockedAt: null,
          cancelLastErrorCode: null,
        },
      });
      if (updated.count !== 1) throw new Error("Cancellation claim was lost.");

      if (family.cancelledAt === null) {
        const familyUpdated = await tx.family.updateMany({
          where: {
            id: user.familyId,
            ownerUserId: user.id,
            currentSubscriptionId: claim.subscription.id,
            cancelledAt: null,
            purgeAfter: null,
          },
          data: {
            pendingPaymentExpiresAt: null,
            cancelledAt: effectiveCancelledAt,
            purgeAfter: effectivePurgeAfter,
          },
        });
        if (familyUpdated.count !== 1) {
          throw new Error("Current subscription changed.");
        }
      }
      return cancellationResult(effectiveCancelledAt, effectivePurgeAfter);
    });
  }

  private async claim(user: AuthenticatedUser): Promise<CancellationClaim> {
    if (user.tenantRole !== "owner") {
      throw new ForbiddenException(
        "Somente o owner pode cancelar a assinatura.",
      );
    }

    return this.withSerializableRetry(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${user.familyId} FOR UPDATE
      `;
      const family = await tx.family.findUnique({
        where: { id: user.familyId },
        select: {
          ownerUserId: true,
          currentSubscription: true,
        },
      });
      const subscription = family?.currentSubscription;
      if (!family || family.ownerUserId !== user.id || !subscription) {
        throw new ForbiddenException(
          "A assinatura atual não está disponível para cancelamento.",
        );
      }

      const decision = evaluateSubscriptionProjection(subscription);
      const riskRevoked = isProviderRiskRevocation(subscription);
      if (!decision.accessAllowed && !riskRevoked) {
        throw new ForbiddenException(
          "A assinatura atual não está elegível para cancelamento.",
        );
      }
      if (!subscription.providerSubscriptionId) {
        throw new ServiceUnavailableException({
          code: "SUBSCRIPTION_RECONCILIATION_REQUIRED",
          message:
            "A assinatura precisa ser reconciliada antes do cancelamento.",
        });
      }
      if (subscription.cancelRequestedAt) {
        throw new ConflictException({
          code: "CANCELLATION_ALREADY_REQUESTED",
          message:
            "O cancelamento já foi solicitado e não será reenviado automaticamente.",
        });
      }

      const token = randomUUID();
      const now = new Date();
      const claimed = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          familyId: user.familyId,
          cancelledAt: riskRevoked ? subscription.cancelledAt : null,
          cancelRequestedAt: null,
          cancelClaimToken: null,
        },
        data: {
          cancelRequestedAt: now,
          cancelClaimToken: token,
          cancelLockedAt: now,
          cancelAttempts: { increment: 1 },
          cancelLastErrorCode: null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: "CANCELLATION_IN_PROGRESS",
          message: "Outro cancelamento está em andamento.",
        });
      }
      return { subscription, token };
    });
  }

  private assertProviderResult(
    result: CancelledPaymentSubscription,
    subscription: Subscription,
  ): void {
    const expectedDevMode =
      this.config.get<string>("NODE_ENV") !== "production";
    if (
      result.id !== subscription.providerSubscriptionId ||
      result.status !== "CANCELLED" ||
      result.amountCents !== subscription.amountCents ||
      result.currency !== "BRL" ||
      result.method !== "CARD" ||
      result.devMode !== expectedDevMode ||
      (subscription.providerCustomerId !== null &&
        result.customerId !== subscription.providerCustomerId)
    ) {
      throw new Error("Provider cancellation response mismatch.");
    }
  }

  private async markAmbiguous(
    claim: CancellationClaim,
    error: unknown,
  ): Promise<CancellationResult | null> {
    const providerCode =
      error instanceof PaymentProviderError
        ? error.code
        : error instanceof Error &&
            error.message === "Provider cancellation response mismatch."
          ? "RESOURCE_CORRELATION_MISMATCH"
          : "PROVIDER_RESPONSE_REJECTED";

    const before = await this.findConfirmedCancellation(claim.subscription);
    if (before) return before;

    const updated = await this.prisma.subscription.updateMany({
      where: {
        id: claim.subscription.id,
        cancelClaimToken: claim.token,
      },
      data: {
        cancelClaimToken: null,
        cancelLockedAt: null,
        cancelLastErrorCode: providerCode.slice(0, 120),
      },
    });
    if (updated.count === 1) return null;

    const concurrentlyConfirmed = await this.findConfirmedCancellation(
      claim.subscription,
    );
    if (concurrentlyConfirmed) return concurrentlyConfirmed;
    throw new Error("Cancellation claim was lost.");
  }

  private async findConfirmedCancellation(
    subscription: Subscription,
  ): Promise<CancellationResult | null> {
    const confirmed = await this.prisma.subscription.findUnique({
      where: { id: subscription.id },
      select: {
        providerSubscriptionId: true,
        providerStatus: true,
        lastProviderEvent: true,
        cancelledAt: true,
        currentForFamily: { select: { cancelledAt: true, purgeAfter: true } },
      },
    });
    if (
      confirmed?.currentForFamily &&
      isConfirmedCancellation(confirmed, subscription.providerSubscriptionId!)
    ) {
      const confirmedAt = confirmed.cancelledAt!;
      return cancellationResult(
        confirmedAt,
        confirmed.currentForFamily.purgeAfter ??
          addUtcMonthsClamped(confirmedAt, this.retentionMonths()),
      );
    }
    return null;
  }

  private retentionMonths(): number {
    const value = this.config.get<number>("RETENTION_CANCELLED_MONTHS") ?? 12;
    if (!Number.isSafeInteger(value) || value < 1 || value > 120) {
      throw new ServiceUnavailableException({
        code: "RETENTION_CONFIGURATION_INVALID",
        message: "A retenção de cancelamento está indisponível.",
      });
    }
    return value;
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          isSerializableTransactionConflict(error) &&
          attempt < SERIALIZABLE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Serializable retry budget exhausted.");
  }
}

function isSerializableTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;

  return error.code === "P2010" && error.meta?.code === "40001";
}

export function addUtcMonthsClamped(input: Date, months: number): Date {
  const year = input.getUTCFullYear();
  const monthIndex = input.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(input.getUTCDate(), lastDay),
      input.getUTCHours(),
      input.getUTCMinutes(),
      input.getUTCSeconds(),
      input.getUTCMilliseconds(),
    ),
  );
}

function isConfirmedCancellation(
  subscription: {
    providerSubscriptionId: string | null;
    providerStatus: string | null;
    lastProviderEvent: string | null;
    cancelledAt: Date | null;
  },
  providerSubscriptionId: string,
): boolean {
  return Boolean(
    subscription.providerSubscriptionId === providerSubscriptionId &&
      subscription.cancelledAt &&
      subscription.providerStatus === "CANCELLED" &&
      (subscription.lastProviderEvent === "subscription.cancelled" ||
        subscription.lastProviderEvent === "subscription.reconciled_cancelled"),
  );
}

function cancellationResult(
  cancelledAt: Date,
  purgeAfter: Date,
): CancellationResult {
  return {
    effectiveStatus: "cancelled",
    cancelledAt: cancelledAt.toISOString(),
    purgeAfter: purgeAfter.toISOString(),
  };
}

function isProviderRiskRevocation(subscription: Subscription): boolean {
  return Boolean(
    subscription.cancelledAt &&
      subscription.providerStatus !== "CANCELLED" &&
      subscription.lastProviderEvent &&
      PROVIDER_RISK_EVENTS.has(subscription.lastProviderEvent),
  );
}
