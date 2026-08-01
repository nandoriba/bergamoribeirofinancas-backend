import { Injectable } from "@nestjs/common";

export type EffectiveSubscriptionStatus =
  | "pending_payment"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled";

export type SubscriptionAccessReason =
  | "SUBSCRIPTION_ABSENT"
  | "FIRST_PAYMENT_UNCONFIRMED"
  | "CANCELLATION_CONFIRMED"
  | "CANCELLATION_PENDING"
  | "INVALID_CLOCK"
  | "INVALID_FACTS"
  | "INVALID_TIMESTAMP"
  | "UNKNOWN_PROVIDER_STATUS"
  | "UNKNOWN_PROVIDER_EVENT"
  | "UNSUPPORTED_BILLING_CYCLE"
  | "UNSUPPORTED_PAYMENT_METHOD"
  | "CONTRADICTORY_FACTS"
  | "PAYMENT_GRACE"
  | "PAID_ACCESS"
  | "ACCESS_EXPIRED"
  | "GRACE_EXPIRED";

export interface SubscriptionAccessDecision {
  effectiveStatus: EffectiveSubscriptionStatus;
  accessAllowed: boolean;
  reason: SubscriptionAccessReason;
}

/**
 * The boundary deliberately accepts unknown values. Prisma currently returns Date/null,
 * but authorization must remain fail-closed if a projection, cache or migration supplies
 * an absent or malformed fact at runtime.
 */
export interface SubscriptionAccessFacts {
  providerStatus?: unknown;
  lastProviderEvent?: unknown;
  providerUpdatedAt?: unknown;
  lastSuccessfulPaymentAt?: unknown;
  accessPaidThrough?: unknown;
  paymentFailedAt?: unknown;
  graceUntil?: unknown;
  cancelledAt?: unknown;
  cancelRequestedAt?: unknown;
  cancelledDueTo?: unknown;
  entitlementContractVersion?: unknown;
  lastInstallmentNumber?: unknown;
  billingCycle?: unknown;
  paymentMethod?: unknown;
}

export type SubscriptionAccessClock = () => Date;

/**
 * Injectable facade over the pure entitlement decision table. HTTP sessions and
 * non-HTTP workers must depend on this same policy so they cannot drift into
 * separate authorization rules.
 */
@Injectable()
export class SubscriptionAccessPolicy {
  evaluate(
    facts: SubscriptionAccessFacts | null | undefined,
    clock: SubscriptionAccessClock = () => new Date(),
  ): SubscriptionAccessDecision {
    return evaluateSubscriptionAccess(facts, clock);
  }

  allows(decision: SubscriptionAccessDecision | null | undefined): boolean {
    return (
      decision?.accessAllowed === true &&
      (decision.effectiveStatus === "active" ||
        decision.effectiveStatus === "past_due")
    );
  }
}

const SUCCESS_EVENTS = new Set([
  "subscription.completed",
  "subscription.renewed",
]);
const PAYMENT_FAILED_EVENT = "subscription.payment_failed";
const CANCELLATION_EVENT = "subscription.cancelled";

const DECISIONS = {
  subscriptionAbsent: blocked("pending_payment", "SUBSCRIPTION_ABSENT"),
  firstPaymentUnconfirmed: blocked(
    "pending_payment",
    "FIRST_PAYMENT_UNCONFIRMED",
  ),
  cancelled: blocked("cancelled", "CANCELLATION_CONFIRMED"),
  cancellationPending: blocked("suspended", "CANCELLATION_PENDING"),
  invalidClock: blocked("suspended", "INVALID_CLOCK"),
  invalidFacts: blocked("suspended", "INVALID_FACTS"),
  invalidTimestamp: blocked("suspended", "INVALID_TIMESTAMP"),
  unknownProviderStatus: blocked("suspended", "UNKNOWN_PROVIDER_STATUS"),
  unknownProviderEvent: blocked("suspended", "UNKNOWN_PROVIDER_EVENT"),
  unsupportedBillingCycle: blocked("suspended", "UNSUPPORTED_BILLING_CYCLE"),
  unsupportedPaymentMethod: blocked("suspended", "UNSUPPORTED_PAYMENT_METHOD"),
  contradictoryFacts: blocked("suspended", "CONTRADICTORY_FACTS"),
  paymentGrace: allowed("past_due", "PAYMENT_GRACE"),
  paidAccess: allowed("active", "PAID_ACCESS"),
  accessExpired: blocked("suspended", "ACCESS_EXPIRED"),
  graceExpired: blocked("suspended", "GRACE_EXPIRED"),
} as const;

/**
 * Pure, derived authorization policy. The clock is injected so every exact temporal
 * boundary is deterministic in HTTP, Telegram and tests. No provider call or write is
 * permitted here.
 */
export function evaluateSubscriptionAccess(
  facts: SubscriptionAccessFacts | null | undefined,
  clock: SubscriptionAccessClock,
): SubscriptionAccessDecision {
  const now = readClock(clock);
  if (!now) return DECISIONS.invalidClock;
  if (facts === null || facts === undefined)
    return DECISIONS.subscriptionAbsent;
  if (!isRecord(facts)) return DECISIONS.invalidFacts;

  const cancelledAt = timestamp(facts.cancelledAt);
  const cancelRequestedAt = timestamp(facts.cancelRequestedAt);
  const providerUpdatedAt = timestamp(facts.providerUpdatedAt);
  const lastSuccessfulPaymentAt = timestamp(facts.lastSuccessfulPaymentAt);
  const accessPaidThrough = timestamp(facts.accessPaidThrough);
  const paymentFailedAt = timestamp(facts.paymentFailedAt);
  const graceUntil = timestamp(facts.graceUntil);
  const cancellationConfirmed =
    facts.providerStatus === "CANCELLED" ||
    facts.lastProviderEvent === CANCELLATION_EVENT ||
    (cancelledAt.kind === "valid" &&
      cancelledAt.value.getTime() <= now.getTime());

  // A cancellation fact always wins over future entitlement and failure state.
  if (cancellationConfirmed) return DECISIONS.cancelled;

  if (
    !hasCompleteRuntimeShape(facts) ||
    [
      cancelledAt,
      cancelRequestedAt,
      providerUpdatedAt,
      lastSuccessfulPaymentAt,
      accessPaidThrough,
      paymentFailedAt,
      graceUntil,
    ].some((value) => value.kind === "invalid")
  ) {
    return [
      cancelledAt,
      cancelRequestedAt,
      providerUpdatedAt,
      lastSuccessfulPaymentAt,
      accessPaidThrough,
      paymentFailedAt,
      graceUntil,
    ].some((value) => value.kind === "invalid")
      ? DECISIONS.invalidTimestamp
      : DECISIONS.invalidFacts;
  }

  if (
    (cancelledAt.kind === "valid" &&
      cancelledAt.value.getTime() > now.getTime()) ||
    (providerUpdatedAt.kind === "valid" &&
      providerUpdatedAt.value.getTime() > now.getTime()) ||
    (lastSuccessfulPaymentAt.kind === "valid" &&
      lastSuccessfulPaymentAt.value.getTime() > now.getTime()) ||
    (paymentFailedAt.kind === "valid" &&
      paymentFailedAt.value.getTime() > now.getTime())
  ) {
    return DECISIONS.contradictoryFacts;
  }

  if (cancelRequestedAt.kind === "valid") {
    return cancelRequestedAt.value.getTime() <= now.getTime()
      ? DECISIONS.cancellationPending
      : DECISIONS.contradictoryFacts;
  }

  if (accessPaidThrough.kind === "absent") {
    return isGenuinePendingPayment(facts, {
      cancelledAt,
      cancelRequestedAt,
      providerUpdatedAt,
      lastSuccessfulPaymentAt,
      paymentFailedAt,
      graceUntil,
    })
      ? DECISIONS.firstPaymentUnconfirmed
      : DECISIONS.contradictoryFacts;
  }

  if (facts.providerStatus !== "ACTIVE") return DECISIONS.unknownProviderStatus;
  if (facts.billingCycle !== "MONTHLY")
    return DECISIONS.unsupportedBillingCycle;
  if (facts.paymentMethod !== "CARD") return DECISIONS.unsupportedPaymentMethod;
  if (
    providerUpdatedAt.kind !== "valid" ||
    lastSuccessfulPaymentAt.kind !== "valid" ||
    accessPaidThrough.kind !== "valid"
  ) {
    return DECISIONS.invalidFacts;
  }
  if (!isPositiveInteger(facts.lastInstallmentNumber))
    return DECISIONS.invalidFacts;
  if (!isNonBlankString(facts.entitlementContractVersion))
    return DECISIONS.invalidFacts;
  if (
    lastSuccessfulPaymentAt.value.getTime() >=
      accessPaidThrough.value.getTime() ||
    (facts.cancelledDueTo !== null && facts.cancelledDueTo !== undefined)
  ) {
    return DECISIONS.contradictoryFacts;
  }

  if (facts.lastProviderEvent === PAYMENT_FAILED_EVENT) {
    if (paymentFailedAt.kind !== "valid" || graceUntil.kind !== "valid") {
      return DECISIONS.contradictoryFacts;
    }
    if (
      paymentFailedAt.value.getTime() <=
        lastSuccessfulPaymentAt.value.getTime() ||
      graceUntil.value.getTime() <= accessPaidThrough.value.getTime() ||
      graceUntil.value.getTime() < paymentFailedAt.value.getTime()
    ) {
      return DECISIONS.contradictoryFacts;
    }
    return now.getTime() <= graceUntil.value.getTime()
      ? DECISIONS.paymentGrace
      : DECISIONS.graceExpired;
  }

  if (!SUCCESS_EVENTS.has(String(facts.lastProviderEvent))) {
    return DECISIONS.unknownProviderEvent;
  }
  if (paymentFailedAt.kind !== "absent" || graceUntil.kind !== "absent") {
    return DECISIONS.contradictoryFacts;
  }
  return now.getTime() < accessPaidThrough.value.getTime()
    ? DECISIONS.paidAccess
    : DECISIONS.accessExpired;
}

function readClock(clock: SubscriptionAccessClock): Date | null {
  try {
    const now = clock();
    return isValidDate(now) ? now : null;
  } catch {
    return null;
  }
}

type Timestamp =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: Date };

function timestamp(value: unknown): Timestamp {
  if (value === null) return { kind: "absent" };
  if (!isValidDate(value)) return { kind: "invalid" };
  return { kind: "valid", value };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const REQUIRED_FACT_KEYS = [
  "providerStatus",
  "lastProviderEvent",
  "providerUpdatedAt",
  "lastSuccessfulPaymentAt",
  "accessPaidThrough",
  "paymentFailedAt",
  "graceUntil",
  "cancelledAt",
  "cancelRequestedAt",
  "cancelledDueTo",
  "entitlementContractVersion",
  "lastInstallmentNumber",
  "billingCycle",
  "paymentMethod",
] as const;

function hasCompleteRuntimeShape(facts: Record<string, unknown>): boolean {
  if (!REQUIRED_FACT_KEYS.every((key) => Object.hasOwn(facts, key)))
    return false;
  return (
    isNullableString(facts.providerStatus) &&
    isNullableString(facts.lastProviderEvent) &&
    isNullableString(facts.cancelledDueTo) &&
    isNullableString(facts.entitlementContractVersion) &&
    isNullableInteger(facts.lastInstallmentNumber) &&
    typeof facts.billingCycle === "string" &&
    isNullableString(facts.paymentMethod)
  );
}

function isGenuinePendingPayment(
  facts: Record<string, unknown>,
  timestamps: {
    cancelledAt: Timestamp;
    cancelRequestedAt: Timestamp;
    providerUpdatedAt: Timestamp;
    lastSuccessfulPaymentAt: Timestamp;
    paymentFailedAt: Timestamp;
    graceUntil: Timestamp;
  },
): boolean {
  return (
    facts.providerStatus === null &&
    facts.lastProviderEvent === null &&
    timestamps.providerUpdatedAt.kind === "absent" &&
    timestamps.lastSuccessfulPaymentAt.kind === "absent" &&
    timestamps.paymentFailedAt.kind === "absent" &&
    timestamps.graceUntil.kind === "absent" &&
    timestamps.cancelledAt.kind === "absent" &&
    timestamps.cancelRequestedAt.kind === "absent" &&
    facts.cancelledDueTo === null &&
    facts.entitlementContractVersion === null &&
    facts.lastInstallmentNumber === null &&
    facts.billingCycle === "MONTHLY" &&
    facts.paymentMethod === null
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function blocked(
  effectiveStatus: Exclude<EffectiveSubscriptionStatus, "active" | "past_due">,
  reason: SubscriptionAccessReason,
): SubscriptionAccessDecision {
  return Object.freeze({ effectiveStatus, accessAllowed: false, reason });
}

function allowed(
  effectiveStatus: "active" | "past_due",
  reason: SubscriptionAccessReason,
): SubscriptionAccessDecision {
  return Object.freeze({ effectiveStatus, accessAllowed: true, reason });
}
