import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WebhookProcessingStatus } from "@prisma/client";

import { PrismaService } from "../../../prisma/prisma.service";
import { addUtcMonthsClamped } from "../subscription-cancellation.service";
import type {
  AbacatePayWebhookEventType,
  NormalizedAbacatePayWebhookEvent,
} from "./abacatepay-webhook";

export const ABACATEPAY_WEBHOOK_PROVIDER = "abacatepay" as const;
export const ABACATEPAY_WEBHOOK_CLOCK = Symbol("ABACATEPAY_WEBHOOK_CLOCK");

const SERIALIZABLE_RETRIES = 3;
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const SUBSCRIPTION_CORRELATION_SELECT = {
  id: true,
  familyId: true,
  provider: true,
  externalId: true,
  providerSubscriptionId: true,
  providerCustomerId: true,
  providerCheckoutId: true,
  providerProductId: true,
  providerStatus: true,
  lastProviderEvent: true,
  amountCents: true,
  currency: true,
  paymentMethod: true,
  providerPaymentMethod: true,
  billingCycle: true,
  devMode: true,
  cancelledAt: true,
  createdAt: true,
} satisfies Prisma.SubscriptionSelect;

const PAYMENT_CORRELATION_SELECT = {
  id: true,
  subscriptionId: true,
  familyId: true,
  providerPaymentId: true,
  providerCheckoutId: true,
  providerInstallmentId: true,
  providerStatus: true,
  providerUpdatedAt: true,
  amountCents: true,
  currency: true,
  paymentMethod: true,
  providerPaymentMethod: true,
  subscription: { select: SUBSCRIPTION_CORRELATION_SELECT },
} satisfies Prisma.SubscriptionPaymentSelect;

type CorrelatedSubscription = Prisma.SubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_CORRELATION_SELECT;
}>;
type CorrelatedPayment = Prisma.SubscriptionPaymentGetPayload<{
  select: typeof PAYMENT_CORRELATION_SELECT;
}>;

interface Correlation {
  subscription: CorrelatedSubscription;
  payment: CorrelatedPayment | null;
  providerSubscriptionBindingAllowed: boolean;
}

export type AbacatePayWebhookClock = () => Date;

export interface ProcessAuthenticatedAbacatePayWebhookInput {
  /** Event produced by the authenticated v2 parser. Raw HTTP input is not accepted here. */
  readonly event: NormalizedAbacatePayWebhookEvent;
  /** Canonical lowercase SHA-256 digest of the exact authenticated raw body. */
  readonly payloadHash: string;
}

export type AbacatePayWebhookApplicationErrorCode =
  | "INVALID_PAYLOAD_HASH"
  | "INVALID_NORMALIZED_EVENT"
  | "IDEMPOTENCY_CONFLICT"
  | "RETENTION_CONFIGURATION_INVALID";

export class AbacatePayWebhookApplicationError extends Error {
  readonly incident: boolean;

  constructor(readonly code: AbacatePayWebhookApplicationErrorCode) {
    super("AbacatePay webhook application failed.");
    this.name = "AbacatePayWebhookApplicationError";
    this.incident = code === "IDEMPOTENCY_CONFLICT";
  }
}

export type AbacatePayWebhookQuarantineCode =
  | "CORRELATION_NOT_FOUND"
  | "CORRELATION_MISMATCH"
  | "CHECKOUT_CORRELATION_PENDING"
  | "ENTITLEMENT_CONTRACT_UNPROVEN";

export type ProcessAuthenticatedAbacatePayWebhookResult =
  | {
      readonly disposition: "processed";
      readonly eventRecordId: string;
      readonly subscriptionId: string;
      readonly familyRevoked: boolean;
    }
  | {
      readonly disposition: "quarantined";
      readonly eventRecordId: string;
      readonly code: AbacatePayWebhookQuarantineCode;
      readonly subscriptionId: string | null;
    }
  | {
      readonly disposition: "duplicate";
      readonly eventRecordId: string;
      readonly originalStatus: WebhookProcessingStatus;
    };

class DeterministicQuarantineError extends Error {
  constructor(readonly code: AbacatePayWebhookQuarantineCode) {
    super("Webhook event requires deterministic quarantine.");
  }
}

@Injectable()
export class AbacatePayWebhookApplicationService {
  private readonly clock: AbacatePayWebhookClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(ABACATEPAY_WEBHOOK_CLOCK)
    clock?: AbacatePayWebhookClock,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  /**
   * Applies only an event that the transport already authenticated and parsed.
   * Invalid authentication attempts never reach, and therefore never enter, the
   * canonical PaymentWebhookEvent table.
   */
  async processAuthenticatedEvent(
    input: ProcessAuthenticatedAbacatePayWebhookInput,
  ): Promise<ProcessAuthenticatedAbacatePayWebhookResult> {
    const now = readClock(this.clock);
    assertApplicationInput(input, now);

    try {
      return await this.withSerializableRetry((tx) =>
        this.processInTransaction(tx, input, now),
      );
    } catch (error) {
      if (!isPrismaError(error, "P2002")) throw error;

      // A P2002 is a duplicate delivery only when the canonical event row now
      // exists. Other unique-key collisions remain transient/conflict failures.
      const existing = await this.prisma.paymentWebhookEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: ABACATEPAY_WEBHOOK_PROVIDER,
            providerEventId: input.event.providerEventId,
          },
        },
        select: {
          id: true,
          payloadHash: true,
          processingStatus: true,
          errorCode: true,
        },
      });
      if (!existing) throw error;
      assertMatchingPayloadHash(existing, input.payloadHash);
      return isTerminalEvent(existing)
        ? duplicateResult(existing, input.payloadHash)
        : this.processAuthenticatedEvent(input);
    }
  }

  private async processInTransaction(
    tx: Prisma.TransactionClient,
    input: ProcessAuthenticatedAbacatePayWebhookInput,
    now: Date,
  ): Promise<ProcessAuthenticatedAbacatePayWebhookResult> {
    const event = input.event;
    const existing = await tx.paymentWebhookEvent.findUnique({
      where: {
        provider_providerEventId: {
          provider: ABACATEPAY_WEBHOOK_PROVIDER,
          providerEventId: event.providerEventId,
        },
      },
      select: {
        id: true,
        payloadHash: true,
        processingStatus: true,
        errorCode: true,
      },
    });
    if (existing) {
      assertMatchingPayloadHash(existing, input.payloadHash);
      if (isTerminalEvent(existing)) {
        return duplicateResult(existing, input.payloadHash);
      }
    }

    // Resolve revocation configuration only for new/recoverable work. A
    // terminal duplicate remains acknowledgeable if config later becomes bad.
    const retentionMonths = isRevocation(event) ? this.retentionMonths() : null;

    const eventRecord = existing
      ? await this.recoverEvent(tx, existing, input.payloadHash, now)
      : await tx.paymentWebhookEvent.create({
          data: {
            provider: ABACATEPAY_WEBHOOK_PROVIDER,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            apiVersion: event.apiVersion,
            devMode: event.devMode,
            payloadHash: input.payloadHash,
            sanitizedPayload: sanitizedPayload(event),
            signatureValid: true,
            processingStatus: WebhookProcessingStatus.received,
            attempts: 1,
            providerSubscriptionId: event.providerSubscriptionId,
            providerPaymentId: event.providerPaymentId,
            providerCheckoutId: event.providerCheckoutId,
            providerFailureReason:
              event.eventType === "subscription.payment_failed"
                ? event.failureReason
                : null,
            occurredAt: event.occurredAt,
            receivedAt: now,
            lastAttemptAt: now,
          },
          select: { id: true },
        });

    let correlation: Correlation | null = null;
    try {
      correlation = await this.correlate(tx, event);

      if (!isRevocation(event)) {
        if (event.kind === "subscription_success") {
          correlation = await this.bindProviderSubscriptionIdentity(
            tx,
            event,
            correlation,
          );
        }
        return this.quarantine(
          tx,
          eventRecord.id,
          "ENTITLEMENT_CONTRACT_UNPROVEN",
          now,
          correlation,
        );
      }

      if (retentionMonths === null) {
        throw new Error("Retention configuration was not resolved.");
      }
      const locked = await this.lockAndReloadCorrelation(
        tx,
        event,
        correlation,
      );
      const revocationAt = authoritativeRevocationAt(event, now);
      assertRevocationAfterSubscriptionCreation(
        locked.subscription,
        revocationAt,
      );
      const familyRevoked = await this.applyRevocation(
        tx,
        locked.subscription,
        locked.payment,
        event,
        revocationAt,
        retentionMonths,
      );

      await tx.paymentWebhookEvent.update({
        where: { id: eventRecord.id },
        data: {
          processingStatus: WebhookProcessingStatus.processed,
          familyId: locked.subscription.familyId,
          subscriptionId: locked.subscription.id,
          subscriptionPaymentId: locked.payment?.id ?? null,
          processedAt: now,
          errorCode: null,
        },
      });

      return {
        disposition: "processed",
        eventRecordId: eventRecord.id,
        subscriptionId: locked.subscription.id,
        familyRevoked,
      };
    } catch (error) {
      if (!(error instanceof DeterministicQuarantineError)) throw error;
      return this.quarantine(tx, eventRecord.id, error.code, now, correlation);
    }
  }

  private async recoverEvent(
    tx: Prisma.TransactionClient,
    existing: {
      id: string;
      payloadHash: string;
      processingStatus: WebhookProcessingStatus;
      errorCode: string | null;
    },
    payloadHash: string,
    now: Date,
  ): Promise<{ id: string }> {
    const recovered = await tx.paymentWebhookEvent.updateMany({
      where: {
        id: existing.id,
        payloadHash,
        OR: [
          {
            processingStatus: {
              in: [
                WebhookProcessingStatus.received,
                WebhookProcessingStatus.failed,
              ],
            },
          },
          {
            processingStatus: WebhookProcessingStatus.quarantined,
            errorCode: {
              in: ["CORRELATION_NOT_FOUND", "CHECKOUT_CORRELATION_PENDING"],
            },
          },
        ],
      },
      data: {
        processingStatus: WebhookProcessingStatus.received,
        attempts: { increment: 1 },
        signatureValid: true,
        lastAttemptAt: now,
        processedAt: null,
        errorCode: null,
      },
    });
    if (recovered.count !== 1) {
      throw new Error("Webhook recovery claim changed concurrently.");
    }
    return { id: existing.id };
  }

  private async correlate(
    tx: Prisma.TransactionClient,
    event: NormalizedAbacatePayWebhookEvent,
  ): Promise<Correlation> {
    const [
      subscriptionById,
      subscriptionByCheckout,
      subscriptionByExternalId,
      paymentByCheckout,
      paymentById,
      subscriptionByAuthenticatedWebhookCheckout,
    ] = await Promise.all([
      event.providerSubscriptionId
        ? tx.subscription.findUnique({
            where: {
              provider_providerSubscriptionId: {
                provider: ABACATEPAY_WEBHOOK_PROVIDER,
                providerSubscriptionId: event.providerSubscriptionId,
              },
            },
            select: SUBSCRIPTION_CORRELATION_SELECT,
          })
        : null,
      event.providerCheckoutId
        ? tx.subscription.findUnique({
            where: {
              provider_providerCheckoutId: {
                provider: ABACATEPAY_WEBHOOK_PROVIDER,
                providerCheckoutId: event.providerCheckoutId,
              },
            },
            select: SUBSCRIPTION_CORRELATION_SELECT,
          })
        : null,
      event.checkoutExternalId
        ? tx.subscription.findUnique({
            where: { externalId: event.checkoutExternalId },
            select: SUBSCRIPTION_CORRELATION_SELECT,
          })
        : null,
      event.providerCheckoutId
        ? tx.subscriptionPayment.findUnique({
            where: { providerCheckoutId: event.providerCheckoutId },
            select: PAYMENT_CORRELATION_SELECT,
          })
        : null,
      event.providerPaymentId
        ? tx.subscriptionPayment.findUnique({
            where: { providerPaymentId: event.providerPaymentId },
            select: PAYMENT_CORRELATION_SELECT,
          })
        : null,
      this.findSubscriptionByAuthenticatedWebhookCheckout(tx, event),
    ]);

    const primary = mergeSubscriptionCandidates([
      subscriptionById,
      subscriptionByCheckout,
      subscriptionByExternalId,
      paymentByCheckout?.subscription ?? null,
      paymentById?.subscription ?? null,
      subscriptionByAuthenticatedWebhookCheckout,
    ]);
    if (!primary) {
      throw new DeterministicQuarantineError("CORRELATION_NOT_FOUND");
    }

    for (const candidate of [
      subscriptionById,
      subscriptionByCheckout,
      subscriptionByExternalId,
      paymentByCheckout?.subscription,
      paymentById?.subscription,
      subscriptionByAuthenticatedWebhookCheckout,
    ]) {
      if (candidate && candidate.id !== primary.id) {
        throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
      }
    }
    if (
      paymentByCheckout &&
      paymentById &&
      paymentByCheckout.id !== paymentById.id
    ) {
      throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
    }

    const payment = paymentById ?? paymentByCheckout;
    const externalIdIsOnlyCorrelation = Boolean(
      subscriptionByExternalId &&
      !subscriptionById &&
      !subscriptionByCheckout &&
      !paymentByCheckout &&
      !paymentById &&
      !subscriptionByAuthenticatedWebhookCheckout,
    );
    if (externalIdIsOnlyCorrelation && event.providerCheckoutId !== null) {
      if (primary.providerCheckoutId === null) {
        throw new DeterministicQuarantineError("CHECKOUT_CORRELATION_PENDING");
      }
      if (primary.providerCheckoutId !== event.providerCheckoutId) {
        throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
      }
    }
    assertSubscriptionSignature(primary, event);
    if (payment) assertPaymentSignature(payment, primary, event);

    return {
      subscription: primary,
      payment,
      providerSubscriptionBindingAllowed: Boolean(
        subscriptionByCheckout || subscriptionByExternalId || paymentByCheckout,
      ),
    };
  }

  private async findSubscriptionByAuthenticatedWebhookCheckout(
    tx: Prisma.TransactionClient,
    event: NormalizedAbacatePayWebhookEvent,
  ): Promise<CorrelatedSubscription | null> {
    if (event.kind !== "checkout_risk" || event.providerCheckoutId === null) {
      return null;
    }

    const mappings = await tx.paymentWebhookEvent.findMany({
      where: {
        provider: ABACATEPAY_WEBHOOK_PROVIDER,
        providerCheckoutId: event.providerCheckoutId,
        signatureValid: true,
        eventType: {
          in: ["subscription.completed", "subscription.renewed"],
        },
        processingStatus: WebhookProcessingStatus.quarantined,
        errorCode: "ENTITLEMENT_CONTRACT_UNPROVEN",
        subscriptionId: { not: null },
        familyId: { not: null },
      },
      select: {
        subscription: { select: SUBSCRIPTION_CORRELATION_SELECT },
      },
      distinct: ["subscriptionId"],
    });

    let mapped: CorrelatedSubscription | null = null;
    for (const mapping of mappings) {
      if (!mapping.subscription) {
        throw new Error(
          "Authenticated webhook checkout mapping lost its subscription.",
        );
      }
      if (mapped && mapped.id !== mapping.subscription.id) {
        throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
      }
      mapped = mapping.subscription;
    }
    return mapped;
  }

  private async bindProviderSubscriptionIdentity(
    tx: Prisma.TransactionClient,
    event: NormalizedAbacatePayWebhookEvent,
    initial: Correlation,
  ): Promise<Correlation> {
    const providerSubscriptionId = event.providerSubscriptionId;
    if (
      providerSubscriptionId === null ||
      initial.subscription.providerSubscriptionId === providerSubscriptionId
    ) {
      return initial;
    }
    if (
      initial.subscription.providerSubscriptionId !== null ||
      !initial.providerSubscriptionBindingAllowed
    ) {
      throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
    }

    const locked = await this.lockAndReloadCorrelation(tx, event, initial);
    if (locked.subscription.providerSubscriptionId === providerSubscriptionId) {
      return locked;
    }
    if (
      locked.subscription.providerSubscriptionId !== null ||
      !locked.providerSubscriptionBindingAllowed
    ) {
      throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
    }

    const updated = await tx.subscription.updateMany({
      where: {
        id: locked.subscription.id,
        familyId: locked.subscription.familyId,
        provider: ABACATEPAY_WEBHOOK_PROVIDER,
        providerSubscriptionId: null,
      },
      data: { providerSubscriptionId },
    });
    if (updated.count !== 1) {
      // A concurrent bind must roll this transaction back. On retry, correlation
      // either converges on the same immutable ID or quarantines a mismatch.
      throw new Error(
        "Subscription identity changed during webhook correlation.",
      );
    }

    return {
      ...locked,
      subscription: {
        ...locked.subscription,
        providerSubscriptionId,
      },
    };
  }

  private async lockAndReloadCorrelation(
    tx: Prisma.TransactionClient,
    event: NormalizedAbacatePayWebhookEvent,
    initial: Correlation,
  ): Promise<Correlation> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Family"
       WHERE "id" = ${initial.subscription.familyId}
       FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new DeterministicQuarantineError("CORRELATION_NOT_FOUND");
    }

    const reloaded = await this.correlate(tx, event);
    if (
      reloaded.subscription.id !== initial.subscription.id ||
      reloaded.subscription.familyId !== initial.subscription.familyId
    ) {
      // This is concurrent state movement, not a provider contract failure. Let
      // the transaction roll back so the HTTP layer can return 5xx and retry.
      throw new Error("Webhook correlation changed during processing.");
    }
    return reloaded;
  }

  private async applyRevocation(
    tx: Prisma.TransactionClient,
    subscription: CorrelatedSubscription,
    payment: CorrelatedPayment | null,
    event: NormalizedAbacatePayWebhookEvent,
    revocationAt: Date,
    retentionMonths: number,
  ): Promise<boolean> {
    const providerCancellationConfirmed =
      event.kind === "subscription_cancelled";
    // The first authenticated provider revocation establishes the immutable
    // local cancellation boundary. Delayed/out-of-order deliveries may enrich
    // provider facts, but never move that boundary backwards or forwards.
    const effectiveCancelledAt = subscription.cancelledAt ?? revocationAt;
    if (event.kind === "checkout_risk" && payment) {
      const providerStatus =
        event.eventType === "checkout.refunded" ? "REFUNDED" : "DISPUTED";
      const providerUpdatedAt = event.providerUpdatedAt;
      if (!isValidDate(providerUpdatedAt)) {
        throw new AbacatePayWebhookApplicationError("INVALID_NORMALIZED_EVENT");
      }
      if (
        paymentRiskShouldAdvance(
          payment.providerStatus,
          payment.providerUpdatedAt,
          providerStatus,
          providerUpdatedAt,
        )
      ) {
        const paymentUpdated = await tx.subscriptionPayment.updateMany({
          where: {
            id: payment.id,
            subscriptionId: subscription.id,
            familyId: subscription.familyId,
            providerStatus: payment.providerStatus,
            providerUpdatedAt: payment.providerUpdatedAt,
          },
          data: { providerStatus, providerUpdatedAt },
        });
        if (paymentUpdated.count !== 1) {
          throw new Error(
            "Subscription payment changed during webhook revocation.",
          );
        }
      }
    }
    if (subscription.cancelledAt === null) {
      const updated = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          familyId: subscription.familyId,
          cancelledAt: null,
        },
        data: {
          // A refunded/disputed checkout revokes local access, but it does not
          // prove that the recurring provider subscription stopped charging.
          // Keep the provider status truthful and block a replacement checkout
          // until an explicit subscription.cancelled confirmation arrives.
          ...(providerCancellationConfirmed
            ? { providerStatus: "CANCELLED" }
            : {}),
          lastProviderEvent: event.eventType,
          cancelledAt: effectiveCancelledAt,
          cancelledDueTo: revocationReason(event),
          ...(providerCancellationConfirmed
            ? {
                cancelClaimToken: null,
                cancelLockedAt: null,
                cancelLastErrorCode: null,
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new Error("Subscription changed during webhook revocation.");
      }
    } else if (
      providerCancellationConfirmed &&
      (subscription.providerStatus !== "CANCELLED" ||
        subscription.lastProviderEvent !== event.eventType)
    ) {
      const confirmed = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          familyId: subscription.familyId,
          providerSubscriptionId: event.providerSubscriptionId,
          cancelledAt: subscription.cancelledAt,
        },
        data: {
          providerStatus: "CANCELLED",
          lastProviderEvent: event.eventType,
          cancelledDueTo: revocationReason(event),
          cancelClaimToken: null,
          cancelLockedAt: null,
          cancelLastErrorCode: null,
        },
      });
      if (confirmed.count !== 1) {
        throw new Error("Subscription cancellation confirmation changed.");
      }
    }

    const family = await tx.family.findUnique({
      where: { id: subscription.familyId },
      select: {
        currentSubscriptionId: true,
        cancelledAt: true,
        purgeAfter: true,
      },
    });
    if (!family) {
      // The Family row was locked earlier. Its disappearance is a transient DB
      // anomaly and must roll back every effect rather than commit quarantine.
      throw new Error("Correlated Family disappeared during revocation.");
    }
    if (family.currentSubscriptionId !== subscription.id) return false;
    if (family.cancelledAt !== null && family.purgeAfter !== null) return false;
    if (family.cancelledAt !== null || family.purgeAfter !== null) {
      throw new Error("Family retention facts are inconsistent.");
    }

    const updated = await tx.family.updateMany({
      where: {
        id: subscription.familyId,
        currentSubscriptionId: subscription.id,
        cancelledAt: null,
        purgeAfter: null,
      },
      data: {
        pendingPaymentExpiresAt: null,
        cancelledAt: effectiveCancelledAt,
        purgeAfter: addUtcMonthsClamped(effectiveCancelledAt, retentionMonths),
      },
    });
    if (updated.count !== 1) {
      throw new Error(
        "Current subscription changed during webhook revocation.",
      );
    }
    return true;
  }

  private async quarantine(
    tx: Prisma.TransactionClient,
    eventRecordId: string,
    code: AbacatePayWebhookQuarantineCode,
    now: Date,
    correlation: Correlation | null,
  ): Promise<ProcessAuthenticatedAbacatePayWebhookResult> {
    await tx.paymentWebhookEvent.update({
      where: { id: eventRecordId },
      data: {
        processingStatus: WebhookProcessingStatus.quarantined,
        familyId: correlation?.subscription.familyId ?? null,
        subscriptionId: correlation?.subscription.id ?? null,
        subscriptionPaymentId: correlation?.payment?.id ?? null,
        processedAt: now,
        errorCode: code,
      },
    });
    return {
      disposition: "quarantined",
      eventRecordId,
      code,
      subscriptionId: correlation?.subscription.id ?? null,
    };
  }

  private retentionMonths(): number {
    const value = this.config.get<number>("RETENTION_CANCELLED_MONTHS") ?? 12;
    if (!Number.isSafeInteger(value) || value < 1 || value > 120) {
      throw new AbacatePayWebhookApplicationError(
        "RETENTION_CONFIGURATION_INVALID",
      );
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

function duplicateResult(
  existing: {
    id: string;
    payloadHash: string;
    processingStatus: WebhookProcessingStatus;
  },
  payloadHash: string,
): ProcessAuthenticatedAbacatePayWebhookResult {
  assertMatchingPayloadHash(existing, payloadHash);
  return {
    disposition: "duplicate",
    eventRecordId: existing.id,
    originalStatus: existing.processingStatus,
  };
}

function assertMatchingPayloadHash(
  existing: { payloadHash: string },
  payloadHash: string,
): void {
  if (existing.payloadHash !== payloadHash) {
    throw new AbacatePayWebhookApplicationError("IDEMPOTENCY_CONFLICT");
  }
}

function isTerminalEvent(existing: {
  processingStatus: WebhookProcessingStatus;
  errorCode: string | null;
}): boolean {
  if (
    existing.processingStatus === WebhookProcessingStatus.processed ||
    existing.processingStatus === WebhookProcessingStatus.ignored
  ) {
    return true;
  }
  return (
    existing.processingStatus === WebhookProcessingStatus.quarantined &&
    existing.errorCode !== "CORRELATION_NOT_FOUND" &&
    existing.errorCode !== "CHECKOUT_CORRELATION_PENDING"
  );
}

function mergeSubscriptionCandidates(
  candidates: Array<CorrelatedSubscription | null | undefined>,
): CorrelatedSubscription | null {
  let correlated: CorrelatedSubscription | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (correlated && correlated.id !== candidate.id) {
      throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
    }
    correlated = candidate;
  }
  return correlated;
}

function assertSubscriptionSignature(
  subscription: CorrelatedSubscription,
  event: NormalizedAbacatePayWebhookEvent,
): void {
  const localMethod =
    subscription.providerPaymentMethod ?? subscription.paymentMethod;
  if (
    subscription.provider !== ABACATEPAY_WEBHOOK_PROVIDER ||
    subscription.devMode !== event.devMode ||
    (event.amountCents !== null &&
      subscription.amountCents !== event.amountCents) ||
    (event.currency !== null && subscription.currency !== event.currency) ||
    (event.paymentMethod !== null &&
      localMethod !== null &&
      localMethod !== event.paymentMethod) ||
    (event.billingCycle !== null &&
      subscription.billingCycle !== event.billingCycle) ||
    (event.providerSubscriptionId !== null &&
      subscription.providerSubscriptionId !== null &&
      subscription.providerSubscriptionId !== event.providerSubscriptionId) ||
    (event.checkoutExternalId !== null &&
      subscription.externalId !== event.checkoutExternalId) ||
    (event.providerCustomerId !== null &&
      subscription.providerCustomerId !== null &&
      subscription.providerCustomerId !== event.providerCustomerId) ||
    (event.providerProductId !== null &&
      subscription.providerProductId !== event.providerProductId) ||
    (event.kind === "checkout_risk" &&
      event.checkoutFrequency !== "SUBSCRIPTION")
  ) {
    throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
  }
}

function assertPaymentSignature(
  payment: CorrelatedPayment,
  subscription: CorrelatedSubscription,
  event: NormalizedAbacatePayWebhookEvent,
): void {
  const localMethod = payment.providerPaymentMethod ?? payment.paymentMethod;
  if (
    payment.subscriptionId !== subscription.id ||
    payment.familyId !== subscription.familyId ||
    payment.subscription.provider !== ABACATEPAY_WEBHOOK_PROVIDER ||
    (event.providerPaymentId !== null &&
      payment.providerPaymentId !== event.providerPaymentId) ||
    (event.providerCheckoutId !== null &&
      payment.providerCheckoutId !== event.providerCheckoutId &&
      subscription.providerCheckoutId !== event.providerCheckoutId) ||
    (event.amountCents !== null && payment.amountCents !== event.amountCents) ||
    (event.currency !== null && payment.currency !== event.currency) ||
    (event.paymentMethod !== null &&
      localMethod !== null &&
      localMethod !== event.paymentMethod)
  ) {
    throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
  }
}

function assertApplicationInput(
  input: ProcessAuthenticatedAbacatePayWebhookInput,
  now: Date,
): void {
  if (!SHA256_HEX_PATTERN.test(input.payloadHash)) {
    throw new AbacatePayWebhookApplicationError("INVALID_PAYLOAD_HASH");
  }
  const event = input.event;
  const expectedKind = EVENT_KIND[event.eventType];
  if (
    !expectedKind ||
    event.kind !== expectedKind ||
    event.apiVersion !== 2 ||
    typeof event.devMode !== "boolean" ||
    !/^log_[A-Za-z0-9_-]+$/.test(event.providerEventId) ||
    (event.providerSubscriptionId !== null &&
      !/^subs_[A-Za-z0-9_-]+$/.test(event.providerSubscriptionId)) ||
    (event.providerPaymentId !== null &&
      !/^char_[A-Za-z0-9_-]+$/.test(event.providerPaymentId)) ||
    (event.providerCheckoutId !== null &&
      !/^bill_[A-Za-z0-9_-]+$/.test(event.providerCheckoutId)) ||
    (event.checkoutExternalId !== null &&
      (typeof event.checkoutExternalId !== "string" ||
        event.checkoutExternalId.length === 0 ||
        event.checkoutExternalId.length > 255)) ||
    event.cycleStartedAt !== null ||
    event.cycleEndedAt !== null ||
    event.accessPaidThrough !== null ||
    event.paidAt !== null ||
    event.failedAt !== null ||
    !hasCoherentProviderTimeline(event) ||
    !providerDatesWithinClockTolerance(event, now) ||
    !hasRequiredNormalizedFacts(event)
  ) {
    throw new AbacatePayWebhookApplicationError("INVALID_NORMALIZED_EVENT");
  }
}

function hasCoherentProviderTimeline(
  event: NormalizedAbacatePayWebhookEvent,
): boolean {
  if (
    !datePairIsOrdered(event.providerCreatedAt, event.providerUpdatedAt) ||
    !datePairIsOrdered(event.paymentCreatedAt, event.paymentUpdatedAt)
  ) {
    return false;
  }
  if (event.kind !== "subscription_cancelled") return true;
  if (!isValidDate(event.cancelledAt)) return false;

  return (
    (event.providerCreatedAt === null ||
      event.providerCreatedAt <= event.cancelledAt) &&
    (event.providerUpdatedAt === null ||
      event.cancelledAt <= event.providerUpdatedAt)
  );
}

function datePairIsOrdered(start: Date | null, end: Date | null): boolean {
  return (
    (start === null || isValidDate(start)) &&
    (end === null || isValidDate(end)) &&
    (start === null || end === null || start <= end)
  );
}

function providerDatesWithinClockTolerance(
  event: NormalizedAbacatePayWebhookEvent,
  now: Date,
): boolean {
  const latestAccepted = now.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS;
  return [
    event.providerCreatedAt,
    event.providerUpdatedAt,
    event.paymentCreatedAt,
    event.paymentUpdatedAt,
    event.cancelledAt,
    event.occurredAt,
  ].every(
    (value) =>
      value === null ||
      (isValidDate(value) && value.getTime() <= latestAccepted),
  );
}

function hasRequiredNormalizedFacts(
  event: NormalizedAbacatePayWebhookEvent,
): boolean {
  if (event.kind === "subscription_success") {
    return (
      event.providerSubscriptionId !== null &&
      event.providerPaymentId !== null &&
      event.providerCheckoutId !== null &&
      event.subscriptionStatus === "ACTIVE" &&
      event.paymentStatus === "PAID" &&
      event.checkoutStatus === "PAID" &&
      event.checkoutFrequency === "SUBSCRIPTION" &&
      event.currency === "BRL" &&
      event.paymentMethod === "CARD" &&
      event.billingCycle === "MONTHLY" &&
      isValidDate(event.providerCreatedAt) &&
      isValidDate(event.providerUpdatedAt) &&
      isValidDate(event.paymentCreatedAt) &&
      isValidDate(event.paymentUpdatedAt)
    );
  }
  if (event.kind === "subscription_payment_failed") {
    return (
      event.providerSubscriptionId !== null &&
      event.subscriptionStatus === "ACTIVE" &&
      event.paymentStatus === "FAILED" &&
      event.currency === "BRL" &&
      event.paymentMethod === "CARD" &&
      event.billingCycle === "MONTHLY" &&
      isValidDate(event.providerCreatedAt) &&
      isValidDate(event.providerUpdatedAt)
    );
  }
  if (event.kind === "subscription_cancelled") {
    return (
      event.providerSubscriptionId !== null &&
      event.subscriptionStatus === "CANCELLED" &&
      event.currency === "BRL" &&
      event.paymentMethod === "CARD" &&
      event.billingCycle === "MONTHLY" &&
      isValidDate(event.providerCreatedAt) &&
      isValidDate(event.providerUpdatedAt) &&
      isValidDate(event.cancelledAt)
    );
  }
  return (
    event.providerCheckoutId !== null &&
    isValidDate(event.providerCreatedAt) &&
    isValidDate(event.providerUpdatedAt) &&
    event.paymentStatus === null &&
    event.paymentMethod === "CARD" &&
    event.checkoutStatus !== null &&
    event.checkoutFrequency !== null
  );
}

const EVENT_KIND: Record<
  AbacatePayWebhookEventType,
  NormalizedAbacatePayWebhookEvent["kind"]
> = {
  "subscription.completed": "subscription_success",
  "subscription.renewed": "subscription_success",
  "subscription.payment_failed": "subscription_payment_failed",
  "subscription.cancelled": "subscription_cancelled",
  "checkout.refunded": "checkout_risk",
  "checkout.disputed": "checkout_risk",
};

function isRevocation(event: NormalizedAbacatePayWebhookEvent): boolean {
  return (
    event.kind === "subscription_cancelled" || event.kind === "checkout_risk"
  );
}

function revocationReason(event: NormalizedAbacatePayWebhookEvent): string {
  if (event.kind === "subscription_cancelled") {
    return event.cancelledDueTo ?? "provider_subscription_cancelled";
  }
  switch (event.eventType) {
    case "subscription.cancelled":
      return "provider_subscription_cancelled";
    case "checkout.refunded":
      return "provider_checkout_refunded";
    case "checkout.disputed":
      return "provider_checkout_disputed";
    default:
      throw new Error(
        "Non-terminal webhook event cannot revoke a subscription.",
      );
  }
}

function sanitizedPayload(
  event: NormalizedAbacatePayWebhookEvent,
): Prisma.InputJsonObject {
  return {
    contract: "abacatepay-v2-normalized",
    kind: event.kind,
    subscriptionStatus: event.subscriptionStatus,
    paymentStatus: event.paymentStatus,
    checkoutStatus: event.checkoutStatus,
  };
}

function readClock(clock: AbacatePayWebhookClock): Date {
  const now = clock();
  if (!isValidDate(now)) {
    throw new AbacatePayWebhookApplicationError("INVALID_NORMALIZED_EVENT");
  }
  return new Date(now.getTime());
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

function isSerializableTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;

  return error.code === "P2010" && error.meta?.code === "40001";
}

function authoritativeRevocationAt(
  event: NormalizedAbacatePayWebhookEvent,
  receivedAt: Date,
): Date {
  // AbacatePay documents the subscription cancellation instant, but checkout
  // risk examples only expose the checkout's generic updatedAt. That value
  // orders payment observations; it is not a safe refund/dispute occurrence
  // boundary. Use authenticated receipt time for local risk revocation.
  const value =
    event.kind === "subscription_cancelled" ? event.cancelledAt : receivedAt;
  if (!isValidDate(value)) {
    // assertApplicationInput rejects this before opening a transaction. Keep
    // this guard so future call-site changes cannot silently fall back to the
    // local processing clock.
    throw new AbacatePayWebhookApplicationError("INVALID_NORMALIZED_EVENT");
  }
  return new Date(value.getTime());
}

function paymentRiskShouldAdvance(
  currentStatus: string,
  currentUpdatedAt: Date | null,
  incomingStatus: "REFUNDED" | "DISPUTED",
  incomingUpdatedAt: Date,
): boolean {
  if (currentUpdatedAt === null) return true;
  if (incomingUpdatedAt > currentUpdatedAt) return true;
  if (incomingUpdatedAt < currentUpdatedAt) return false;

  return (
    paymentRiskPriority(incomingStatus) > paymentRiskPriority(currentStatus)
  );
}

function paymentRiskPriority(status: string): number {
  if (status === "DISPUTED") return 2;
  if (status === "REFUNDED") return 1;
  return 0;
}

function assertRevocationAfterSubscriptionCreation(
  subscription: Pick<CorrelatedSubscription, "createdAt">,
  revocationAt: Date,
): void {
  if (
    revocationAt.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS <
    subscription.createdAt.getTime()
  ) {
    throw new DeterministicQuarantineError("CORRELATION_MISMATCH");
  }
}
