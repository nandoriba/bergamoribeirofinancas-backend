import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CheckoutProvisioningStatus,
  Prisma,
  RetentionRunStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../../prisma/prisma.service";
import {
  evaluateSubscriptionProjection,
  type SubscriptionAccessProjection,
} from "../payments/subscription-access.projection";
import { PaymentsService } from "../payments/payments.service";

const SERIALIZABLE_RETRIES = 3;
const TERMINAL_CHECKOUT_STATUSES = new Set([
  "EXPIRED",
  "CANCELLED",
]);

export type PurgeCategory = "pending_payment" | "cancelled";

export interface RetentionSubscriptionSnapshot extends SubscriptionAccessProjection {
  id: string;
  providerSubscriptionId: string | null;
  providerCheckoutId: string | null;
  providerCheckoutStatus: string | null;
  checkoutProvisioningStatus: CheckoutProvisioningStatus;
  checkoutCreationAllowed: boolean;
  checkoutClaimToken: string | null;
  checkoutLockedAt: Date | null;
  cancelClaimToken: string | null;
  cancelLockedAt: Date | null;
}

export interface RetentionFamilySnapshot {
  id: string;
  pendingPaymentExpiresAt: Date | null;
  cancelledAt: Date | null;
  purgeAfter: Date | null;
  currentSubscription: RetentionSubscriptionSnapshot | null;
}

export interface TenantRetentionRunResult {
  runId: string;
  pendingPaymentPurged: number;
  cancelledPurged: number;
  finishedAt: string;
}

export interface TenantRetentionHealth {
  healthy: boolean;
  checkedAt: string;
  maximumAgeHours: number;
  lastSuccessfulAt: string | null;
}

@Injectable()
export class TenantRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
  ) {}

  async run(now = new Date()): Promise<TenantRetentionRunResult> {
    assertValidDate(now);
    const staleBefore = new Date(
      now.getTime() - this.healthMaximumAgeHours() * 3_600_000,
    );
    await this.prisma.tenantPurgeRun.updateMany({
      where: {
        status: RetentionRunStatus.running,
        startedAt: { lt: staleBefore },
      },
      data: {
        status: RetentionRunStatus.failed,
        finishedAt: now,
        errorCode: "STALE_RUN_RECOVERED",
      },
    });

    const runId = randomUUID();
    try {
      await this.prisma.tenantPurgeRun.create({
        data: { id: runId, status: RetentionRunStatus.running, startedAt: now },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException({
          code: "RETENTION_RUN_ALREADY_ACTIVE",
          message: "Já existe uma execução de retenção em andamento.",
        });
      }
      throw error;
    }

    let pendingPaymentPurged = 0;
    let cancelledPurged = 0;
    try {
      let cursor: string | undefined;
      const batchSize = this.batchSize();
      while (true) {
        const candidates = await this.prisma.family.findMany({
          where: {
            id: cursor ? { gt: cursor } : undefined,
            OR: [
              { pendingPaymentExpiresAt: { lte: now } },
              { purgeAfter: { lte: now } },
            ],
          },
          orderBy: { id: "asc" },
          take: batchSize,
          select: { id: true },
        });
        if (candidates.length === 0) break;

        for (const candidate of candidates) {
          await this.payments.reconcileCheckoutBeforeRetention(
            candidate.id,
            now,
          );
          const category = await this.purgeOne(candidate.id, now);
          if (category === "pending_payment") pendingPaymentPurged += 1;
          if (category === "cancelled") cancelledPurged += 1;
        }
        cursor = candidates.at(-1)!.id;
      }

      const finishedAt = new Date();
      await this.prisma.tenantPurgeRun.update({
        where: { id: runId },
        data: {
          status: RetentionRunStatus.succeeded,
          finishedAt,
          pendingPaymentPurged,
          cancelledPurged,
          errorCode: null,
        },
      });
      return {
        runId,
        pendingPaymentPurged,
        cancelledPurged,
        finishedAt: finishedAt.toISOString(),
      };
    } catch (error) {
      await this.prisma.tenantPurgeRun.update({
        where: { id: runId },
        data: {
          status: RetentionRunStatus.failed,
          finishedAt: new Date(),
          pendingPaymentPurged,
          cancelledPurged,
          errorCode: retentionErrorCode(error),
        },
      });
      throw error;
    }
  }

  async health(now = new Date()): Promise<TenantRetentionHealth> {
    assertValidDate(now);
    const maximumAgeHours = this.healthMaximumAgeHours();
    const cutoff = new Date(now.getTime() - maximumAgeHours * 3_600_000);
    const latest = await this.prisma.tenantPurgeRun.findFirst({
      where: { status: RetentionRunStatus.succeeded },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    });

    return {
      healthy: Boolean(latest?.finishedAt && latest.finishedAt >= cutoff),
      checkedAt: now.toISOString(),
      maximumAgeHours,
      lastSuccessfulAt: latest?.finishedAt?.toISOString() ?? null,
    };
  }

  private async purgeOne(
    familyId: string,
    now: Date,
  ): Promise<PurgeCategory | null> {
    return this.withSerializableRetry(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${familyId} FOR UPDATE
      `;
      if (locked.length !== 1) return null;

      const family = await tx.family.findUnique({
        where: { id: familyId },
        select: {
          id: true,
          pendingPaymentExpiresAt: true,
          cancelledAt: true,
          purgeAfter: true,
          currentSubscription: {
            select: {
              providerStatus: true,
              lastProviderEvent: true,
              providerUpdatedAt: true,
              lastSuccessfulPaymentAt: true,
              accessPaidThrough: true,
              paymentFailedAt: true,
              graceUntil: true,
              cancelledAt: true,
              cancelRequestedAt: true,
              cancelledDueTo: true,
              lastInstallmentNumber: true,
              entitlementContractVersion: true,
              billingCycle: true,
              paymentMethod: true,
              id: true,
              providerSubscriptionId: true,
              providerCheckoutId: true,
              providerCheckoutStatus: true,
              checkoutProvisioningStatus: true,
              checkoutCreationAllowed: true,
              checkoutClaimToken: true,
              checkoutLockedAt: true,
              cancelClaimToken: true,
              cancelLockedAt: true,
            },
          },
        },
      });
      if (!family) return null;

      const category = evaluateRetentionEligibility(
        family as RetentionFamilySnapshot,
        now,
        this.leaseSeconds(),
      );
      if (!category) return null;

      await this.deleteAggregate(tx, familyId);
      return category;
    });
  }

  private async deleteAggregate(
    tx: Prisma.TransactionClient,
    familyId: string,
  ): Promise<void> {
    const [profiles, users, invites, groups] = await Promise.all([
      tx.memberProfile.findMany({
        where: { familyId },
        select: {
          id: true,
          telegramUserLinks: { select: { chatId: true } },
        },
      }),
      tx.user.findMany({ where: { familyId }, select: { id: true } }),
      tx.memberInvite.findMany({ where: { familyId }, select: { id: true } }),
      tx.telegramAuthorizedGroup.findMany({
        where: { familyId },
        select: { chatId: true },
      }),
    ]);
    const profileIds = profiles.map(({ id }) => id);
    const userIds = users.map(({ id }) => id);
    const inviteIds = invites.map(({ id }) => id);
    const chatIds = [
      ...new Set([
        ...groups.map(({ chatId }) => chatId),
        ...profiles.flatMap(({ telegramUserLinks }) =>
          telegramUserLinks.map(({ chatId }) => chatId),
        ),
      ]),
    ];

    const operations = profileIds.length
      ? await tx.telegramFinancialOperation.findMany({
          where: { memberProfileId: { in: profileIds } },
          select: { sourceUpdateId: true },
        })
      : [];
    const sourceUpdateIds = [
      ...new Set(
        operations
          .map(({ sourceUpdateId }) => sourceUpdateId)
          .filter((value): value is string => value !== null),
      ),
    ];

    await tx.family.update({
      where: { id: familyId },
      data: { ownerUserId: null, currentSubscriptionId: null },
    });

    await tx.paymentWebhookEvent.deleteMany({ where: { familyId } });
    await tx.subscriptionPayment.deleteMany({ where: { familyId } });
    await tx.subscription.deleteMany({ where: { familyId } });

    if (profileIds.length) {
      await tx.telegramFinancialOperation.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.telegramPendingConfirmation.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.telegramUserLink.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.telegramMessageLog.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
    }
    if (profileIds.length || userIds.length) {
      await tx.telegramAuthCode.deleteMany({
        where: {
          OR: [
            ...(profileIds.length
              ? [{ memberProfileId: { in: profileIds } }]
              : []),
            ...(userIds.length ? [{ userId: { in: userIds } }] : []),
          ],
        },
      });
    }
    if (chatIds.length) {
      await tx.telegramMessageLog.deleteMany({
        where: { chatId: { in: chatIds } },
      });
    }
    await tx.telegramAuthorizedGroup.deleteMany({ where: { familyId } });
    if (sourceUpdateIds.length) {
      await tx.telegramUpdate.deleteMany({
        where: {
          updateId: { in: sourceUpdateIds },
          financialOperations: { none: {} },
        },
      });
    }
    if (chatIds.length) {
      // TelegramUpdate predates tenant ownership and keeps the provider payload
      // as JSON. Delete updates attributable to this family's unique chat(s),
      // including commands/callbacks that never created a financial operation.
      // The NOT EXISTS guard keeps any cross-linked record fail-closed.
      await tx.$executeRaw`
        DELETE FROM "TelegramUpdate" AS telegram_update
         WHERE NOT EXISTS (
           SELECT 1
             FROM "TelegramFinancialOperation" AS operation
            WHERE operation."sourceUpdateId" = telegram_update."updateId"
         )
           AND (
             telegram_update."payload" #>> '{message,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{edited_message,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{channel_post,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{edited_channel_post,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{callback_query,message,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{my_chat_member,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{chat_member,chat,id}' IN (${Prisma.join(chatIds)})
             OR telegram_update."payload" #>> '{chat_join_request,chat,id}' IN (${Prisma.join(chatIds)})
           )
      `;
    }

    if (profileIds.length) {
      await tx.transaction.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.importRow.deleteMany({
        where: { importBatch: { memberProfileId: { in: profileIds } } },
      });
      await tx.importBatch.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.invoice.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.recurringTemplate.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.installmentPlan.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
      await tx.account.deleteMany({
        where: { memberProfileId: { in: profileIds } },
      });
    }
    await tx.category.deleteMany({ where: { familyId } });

    await tx.memberApproval.deleteMany({ where: { familyId } });
    if (userIds.length || inviteIds.length) {
      await tx.oAuthAttempt.deleteMany({
        where: {
          OR: [
            ...(userIds.length
              ? [{ authenticatedUserId: { in: userIds } }]
              : []),
            ...(inviteIds.length
              ? [{ memberInviteId: { in: inviteIds } }]
              : []),
          ],
        },
      });
    }
    await tx.memberInvite.deleteMany({ where: { familyId } });
    await this.deleteLegalAcceptancesForPurge(tx, familyId);
    await tx.memberProfile.deleteMany({ where: { familyId } });
    await tx.user.deleteMany({ where: { familyId } });
    await tx.family.delete({ where: { id: familyId } });
  }

  private async deleteLegalAcceptancesForPurge(
    tx: Prisma.TransactionClient,
    familyId: string,
  ): Promise<void> {
    const [authorization] = await tx.$queryRaw<Array<{ scope: string }>>`
      SELECT set_config(
        'app.tenant_retention_family_id',
        ${familyId},
        TRUE
      ) AS "scope"
    `;
    if (authorization?.scope !== familyId) {
      throw new Error("LEGAL_ACCEPTANCE_PURGE_SCOPE_NOT_ARMED");
    }

    await tx.legalAcceptance.deleteMany({ where: { familyId } });

    const [revocation] = await tx.$queryRaw<Array<{ scope: string }>>`
      SELECT set_config(
        'app.tenant_retention_family_id',
        '',
        TRUE
      ) AS "scope"
    `;
    if (revocation?.scope !== "") {
      throw new Error("LEGAL_ACCEPTANCE_PURGE_SCOPE_NOT_REVOKED");
    }
  }

  private batchSize(): number {
    return this.config.get<number>("RETENTION_PURGE_BATCH_SIZE") ?? 50;
  }

  private leaseSeconds(): number {
    return this.config.get<number>("RETENTION_PURGE_LEASE_SECONDS") ?? 900;
  }

  private healthMaximumAgeHours(): number {
    return this.config.get<number>("RETENTION_PURGE_MAX_AGE_HOURS") ?? 48;
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

export function evaluateRetentionEligibility(
  family: RetentionFamilySnapshot,
  now: Date,
  leaseSeconds: number,
): PurgeCategory | null {
  assertValidDate(now);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) return null;

  const subscription = family.currentSubscription;
  const decision = evaluateSubscriptionProjection(subscription, () => now);
  if (decision.accessAllowed || decision.effectiveStatus === "suspended")
    return null;
  if (hasUnsafeProviderState(subscription, now, leaseSeconds)) return null;

  const pendingExpired = Boolean(
    family.pendingPaymentExpiresAt && family.pendingPaymentExpiresAt <= now,
  );
  const cancellationRetentionExpired = Boolean(
    family.cancelledAt && family.purgeAfter && family.purgeAfter <= now,
  );
  const providerCancellationConfirmed = Boolean(
    subscription?.providerStatus === "CANCELLED" &&
      (subscription.lastProviderEvent === "subscription.cancelled" ||
        subscription.lastProviderEvent === "subscription.reconciled_cancelled"),
  );

  if (
    family.cancelledAt === null &&
    pendingExpired &&
    decision.effectiveStatus === "pending_payment"
  ) {
    return "pending_payment";
  }

  if (
    cancellationRetentionExpired &&
    ((decision.effectiveStatus === "cancelled" &&
      providerCancellationConfirmed) ||
      (decision.effectiveStatus === "pending_payment" && pendingExpired))
  ) {
    return "cancelled";
  }
  return null;
}

function hasUnsafeProviderState(
  subscription: RetentionSubscriptionSnapshot | null,
  now: Date,
  leaseSeconds: number,
): boolean {
  if (!subscription) return false;
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);
  const providerCancellationConfirmed = Boolean(
    subscription.providerStatus === "CANCELLED" &&
      (subscription.lastProviderEvent === "subscription.cancelled" ||
        subscription.lastProviderEvent === "subscription.reconciled_cancelled"),
  );
  if (subscription.providerSubscriptionId && !providerCancellationConfirmed) {
    return true;
  }
  if (
    (subscription.checkoutClaimToken &&
      (!subscription.checkoutLockedAt ||
        subscription.checkoutLockedAt > staleBefore)) ||
    (subscription.cancelClaimToken &&
      (!subscription.cancelLockedAt ||
        subscription.cancelLockedAt > staleBefore))
  ) {
    return true;
  }
  if (
    evaluateSubscriptionProjection(subscription, () => now).effectiveStatus ===
    "cancelled"
  ) {
    return !providerCancellationConfirmed;
  }
  if (
    subscription.checkoutProvisioningStatus ===
      CheckoutProvisioningStatus.processing ||
    subscription.checkoutProvisioningStatus ===
      CheckoutProvisioningStatus.ambiguous
  ) {
    return true;
  }
  if (
    subscription.providerCheckoutStatus &&
    TERMINAL_CHECKOUT_STATUSES.has(subscription.providerCheckoutStatus)
  ) {
    return false;
  }
  if (subscription.providerCheckoutId || subscription.providerCheckoutStatus)
    return true;
  return subscription.checkoutCreationAllowed !== true;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("A valid retention clock is required.");
  }
}

function retentionErrorCode(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return `PRISMA_${error.code}`;
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message))
    return error.message;
  return "RETENTION_RUN_FAILED";
}

function isSerializableTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;

  return error.code === "P2010" && error.meta?.code === "40001";
}
