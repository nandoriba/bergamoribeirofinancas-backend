import { z } from "zod";

export const ABACATEPAY_WEBHOOK_EVENT_TYPES = [
  "subscription.completed",
  "subscription.renewed",
  "subscription.payment_failed",
  "subscription.cancelled",
  "checkout.refunded",
  "checkout.disputed",
] as const;

export type AbacatePayWebhookEventType =
  (typeof ABACATEPAY_WEBHOOK_EVENT_TYPES)[number];

export type AbacatePayWebhookContractErrorCode =
  | "INVALID_EXPECTED_ENVIRONMENT"
  | "INVALID_ENVELOPE"
  | "ENVIRONMENT_MISMATCH"
  | "INVALID_EVENT_PAYLOAD";

export class AbacatePayWebhookContractError extends Error {
  constructor(readonly code: AbacatePayWebhookContractErrorCode) {
    super("AbacatePay webhook contract rejected.");
    this.name = "AbacatePayWebhookContractError";
  }
}

const boundedProviderId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 1)
    .max(255)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

const providerEventIdSchema = boundedProviderId("log_");
const providerSubscriptionIdSchema = boundedProviderId("subs_");
const providerCheckoutIdSchema = boundedProviderId("bill_");
const providerPaymentIdSchema = boundedProviderId("char_");
const providerInstallmentIdSchema = boundedProviderId("intl_");
const providerCustomerIdSchema = boundedProviderId("cust_");
const providerProductIdSchema = z
  .string()
  .min(6)
  .max(255)
  .regex(/^prod[_-][A-Za-z0-9_-]+$/);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const cardMethodsSchema = z.array(z.literal("CARD")).length(1);

const envelopeSchema = z
  .object({
    id: providerEventIdSchema,
    event: z.enum(ABACATEPAY_WEBHOOK_EVENT_TYPES),
    apiVersion: z.literal(2),
    devMode: z.boolean(),
    data: z.record(z.unknown()),
  })
  .passthrough();

export type AbacatePayWebhookEnvelope = z.infer<typeof envelopeSchema>;

const retryPolicySchema = z
  .object({
    maxRetry: z.number().int().min(1).max(10),
    retryEvery: z.number().int().min(1).max(30),
  })
  .passthrough();

const subscriptionBaseShape = {
  id: providerSubscriptionIdSchema,
  amount: positiveSafeIntegerSchema,
  currency: z.literal("BRL"),
  method: z.literal("CARD"),
  frequency: z.literal("MONTHLY"),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  trialDays: z.union([z.literal(0), z.null()]).optional(),
  trialEndsAt: z.null().optional(),
};

const activeSubscriptionSchema = z
  .object({
    ...subscriptionBaseShape,
    status: z.literal("ACTIVE"),
    retryPolicy: retryPolicySchema.optional(),
    canceledAt: z.null().optional(),
    cancelPolicy: z.null().optional(),
    cancelledDueTo: z.null().optional(),
  })
  .passthrough();

const cancelledSubscriptionSchema = z
  .object({
    ...subscriptionBaseShape,
    status: z.literal("CANCELLED"),
    retryPolicy: retryPolicySchema.optional(),
    canceledAt: isoDateTimeSchema,
    cancelPolicy: z.literal("NOW"),
    cancelledDueTo: z.string().min(1).max(255).nullable(),
  })
  .passthrough();

const customerSchema = z
  .object({
    id: providerCustomerIdSchema,
  })
  .passthrough();

const paidPaymentSchema = z
  .object({
    id: providerPaymentIdSchema,
    amount: positiveSafeIntegerSchema,
    paidAmount: positiveSafeIntegerSchema,
    status: z.literal("PAID"),
    methods: cardMethodsSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .passthrough();

const failedPaymentSchema = z
  .object({
    id: providerPaymentIdSchema,
    status: z.literal("FAILED"),
    amount: positiveSafeIntegerSchema.optional(),
    paidAmount: nonNegativeSafeIntegerSchema.nullable().optional(),
    methods: cardMethodsSchema.optional(),
    createdAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .passthrough();

const paidSubscriptionCheckoutSchema = z
  .object({
    id: providerCheckoutIdSchema,
    externalId: z.string().min(1).max(255).nullable().optional(),
    url: z.string().url(),
    amount: positiveSafeIntegerSchema,
    paidAmount: positiveSafeIntegerSchema,
    frequency: z.literal("SUBSCRIPTION"),
    items: z
      .array(
        z
          .object({
            id: providerProductIdSchema,
            quantity: z.literal(1),
          })
          .passthrough(),
      )
      .length(1),
    status: z.literal("PAID"),
    methods: cardMethodsSchema,
    customerId: providerCustomerIdSchema.nullable().optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .passthrough();

const successDataSchema = z
  .object({
    subscription: activeSubscriptionSchema,
    customer: customerSchema.nullable().optional(),
    payment: paidPaymentSchema,
    checkout: paidSubscriptionCheckoutSchema,
  })
  .passthrough();

const paymentFailedDataSchema = z
  .object({
    subscription: activeSubscriptionSchema,
    customer: customerSchema.nullable().optional(),
    installmentId: providerInstallmentIdSchema.optional(),
    installmentNumber: positiveSafeIntegerSchema.optional(),
    retryNumber: nonNegativeSafeIntegerSchema.optional(),
    payment: failedPaymentSchema.optional(),
    reason: z.string().min(1).max(1_000).optional(),
  })
  .passthrough()
  .superRefine((data, context) => {
    const installmentFields = [
      data.installmentId,
      data.installmentNumber,
      data.retryNumber,
    ];
    const hasAnyInstallmentField = installmentFields.some(
      (value) => value !== undefined,
    );
    const hasEveryInstallmentField = installmentFields.every(
      (value) => value !== undefined,
    );

    if (hasAnyInstallmentField && !hasEveryInstallmentField) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "incomplete installment identity",
      });
    }
    if (hasEveryInstallmentField && !data.subscription.retryPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing retry policy",
      });
    }
    if (!hasEveryInstallmentField && !data.payment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing failed payment identity",
      });
    }
    if (data.payment && !data.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing failure reason",
      });
    }
    if (
      data.retryNumber !== undefined &&
      data.subscription.retryPolicy &&
      data.retryNumber > data.subscription.retryPolicy.maxRetry
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "retry exceeds policy",
      });
    }
    if (
      data.payment?.amount !== undefined &&
      data.payment.amount !== data.subscription.amount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payment amount mismatch",
      });
    }
  });

const cancelledDataSchema = z
  .object({
    subscription: cancelledSubscriptionSchema,
    customer: customerSchema.nullable().optional(),
    payment: paidPaymentSchema.optional(),
    checkout: paidSubscriptionCheckoutSchema.optional(),
  })
  .passthrough();

const riskCheckoutSchema = z
  .object({
    id: providerCheckoutIdSchema,
    externalId: z.string().min(1).max(255).nullable().optional(),
    amount: positiveSafeIntegerSchema,
    paidAmount: positiveSafeIntegerSchema,
    frequency: z.enum(["ONE_TIME", "SUBSCRIPTION"]),
    status: z.enum(["PAID", "REFUNDED"]),
    methods: cardMethodsSchema,
    customerId: providerCustomerIdSchema.nullable().optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    items: z
      .array(
        z
          .object({
            id: providerProductIdSchema,
            quantity: positiveSafeIntegerSchema,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const checkoutRiskDataSchema = z
  .object({
    checkout: riskCheckoutSchema,
    customer: customerSchema.nullable().optional(),
    reason: z.string().min(1).max(1_000),
  })
  .passthrough();

export type NormalizedAbacatePayWebhookKind =
  | "subscription_success"
  | "subscription_payment_failed"
  | "subscription_cancelled"
  | "checkout_risk";

/**
 * Provider facts only. Entitlement boundaries deliberately remain null because
 * the v2 webhook contract does not document a cycle start/end or paid-through.
 */
export interface NormalizedAbacatePayWebhookEvent {
  readonly kind: NormalizedAbacatePayWebhookKind;
  readonly providerEventId: string;
  readonly eventType: AbacatePayWebhookEventType;
  readonly apiVersion: 2;
  readonly devMode: boolean;
  readonly providerSubscriptionId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerCheckoutId: string | null;
  readonly checkoutExternalId: string | null;
  readonly providerInstallmentId: string | null;
  readonly providerCustomerId: string | null;
  readonly providerProductId: string | null;
  readonly amountCents: number | null;
  readonly paidAmountCents: number | null;
  readonly currency: "BRL" | null;
  readonly paymentMethod: "CARD" | null;
  readonly billingCycle: "MONTHLY" | null;
  readonly subscriptionStatus: "ACTIVE" | "CANCELLED" | null;
  readonly paymentStatus: "PAID" | "FAILED" | null;
  readonly checkoutStatus: "PAID" | "REFUNDED" | null;
  readonly checkoutFrequency: "ONE_TIME" | "SUBSCRIPTION" | null;
  readonly installmentNumber: number | null;
  readonly retryNumber: number | null;
  readonly maxRetry: number | null;
  readonly retryEveryDays: number | null;
  readonly failureReason: string | null;
  readonly cancelledDueTo: string | null;
  readonly providerCreatedAt: Date | null;
  readonly providerUpdatedAt: Date | null;
  readonly paymentCreatedAt: Date | null;
  readonly paymentUpdatedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly occurredAt: Date | null;
  readonly paidAt: null;
  readonly failedAt: null;
  readonly cycleStartedAt: null;
  readonly cycleEndedAt: null;
  readonly accessPaidThrough: null;
}

export function parseAbacatePayWebhookEnvelope(
  payload: unknown,
  expectedDevMode: boolean,
): AbacatePayWebhookEnvelope {
  if (typeof expectedDevMode !== "boolean") {
    throw new AbacatePayWebhookContractError("INVALID_EXPECTED_ENVIRONMENT");
  }

  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AbacatePayWebhookContractError("INVALID_ENVELOPE");
  }
  if (parsed.data.devMode !== expectedDevMode) {
    throw new AbacatePayWebhookContractError("ENVIRONMENT_MISMATCH");
  }
  return parsed.data;
}

export function parseAndNormalizeAbacatePayWebhook(
  payload: unknown,
  expectedDevMode: boolean,
): NormalizedAbacatePayWebhookEvent {
  return normalizeAbacatePayWebhookEvent(
    parseAbacatePayWebhookEnvelope(payload, expectedDevMode),
  );
}

export function normalizeAbacatePayWebhookEvent(
  rawEnvelope: AbacatePayWebhookEnvelope,
): NormalizedAbacatePayWebhookEvent {
  const parsedEnvelope = envelopeSchema.safeParse(rawEnvelope);
  if (!parsedEnvelope.success) {
    throw new AbacatePayWebhookContractError("INVALID_ENVELOPE");
  }
  const envelope = parsedEnvelope.data;

  switch (envelope.event) {
    case "subscription.completed":
    case "subscription.renewed":
      return assertNormalizedProviderTimeline(
        normalizeSubscriptionSuccess(envelope),
      );
    case "subscription.payment_failed":
      return assertNormalizedProviderTimeline(normalizePaymentFailed(envelope));
    case "subscription.cancelled":
      return assertNormalizedProviderTimeline(
        normalizeSubscriptionCancelled(envelope),
      );
    case "checkout.refunded":
    case "checkout.disputed":
      return assertNormalizedProviderTimeline(normalizeCheckoutRisk(envelope));
  }
}

function normalizeSubscriptionSuccess(
  envelope: AbacatePayWebhookEnvelope,
): NormalizedAbacatePayWebhookEvent {
  const data = parseEventData(successDataSchema, envelope.data);
  assertSuccessfulAmounts(
    data.subscription.amount,
    data.payment.amount,
    data.payment.paidAmount,
    data.checkout.amount,
    data.checkout.paidAmount,
  );
  const providerCustomerId = correlatedCustomerId(
    data.customer?.id,
    data.checkout.customerId,
  );

  return {
    ...normalizedBase(envelope, "subscription_success"),
    providerSubscriptionId: data.subscription.id,
    providerPaymentId: data.payment.id,
    providerCheckoutId: data.checkout.id,
    checkoutExternalId: data.checkout.externalId ?? null,
    providerInstallmentId: null,
    providerCustomerId,
    providerProductId: data.checkout.items[0].id,
    amountCents: data.subscription.amount,
    paidAmountCents: data.payment.paidAmount,
    currency: "BRL",
    paymentMethod: "CARD",
    billingCycle: "MONTHLY",
    subscriptionStatus: "ACTIVE",
    paymentStatus: "PAID",
    checkoutStatus: "PAID",
    checkoutFrequency: "SUBSCRIPTION",
    installmentNumber: null,
    retryNumber: null,
    maxRetry: data.subscription.retryPolicy?.maxRetry ?? null,
    retryEveryDays: data.subscription.retryPolicy?.retryEvery ?? null,
    failureReason: null,
    cancelledDueTo: null,
    providerCreatedAt: data.subscription.createdAt,
    providerUpdatedAt: data.subscription.updatedAt,
    paymentCreatedAt: data.payment.createdAt,
    paymentUpdatedAt: data.payment.updatedAt,
    cancelledAt: null,
    occurredAt: null,
  };
}

function normalizePaymentFailed(
  envelope: AbacatePayWebhookEnvelope,
): NormalizedAbacatePayWebhookEvent {
  const data = parseEventData(paymentFailedDataSchema, envelope.data);

  return {
    ...normalizedBase(envelope, "subscription_payment_failed"),
    providerSubscriptionId: data.subscription.id,
    providerPaymentId: data.payment?.id ?? null,
    providerCheckoutId: null,
    checkoutExternalId: null,
    providerInstallmentId: data.installmentId ?? null,
    providerCustomerId: data.customer?.id ?? null,
    providerProductId: null,
    amountCents: data.subscription.amount,
    paidAmountCents: data.payment?.paidAmount ?? null,
    currency: "BRL",
    paymentMethod: "CARD",
    billingCycle: "MONTHLY",
    subscriptionStatus: "ACTIVE",
    paymentStatus: "FAILED",
    checkoutStatus: null,
    checkoutFrequency: null,
    installmentNumber: data.installmentNumber ?? null,
    retryNumber: data.retryNumber ?? null,
    maxRetry: data.subscription.retryPolicy?.maxRetry ?? null,
    retryEveryDays: data.subscription.retryPolicy?.retryEvery ?? null,
    failureReason: data.reason ?? null,
    cancelledDueTo: null,
    providerCreatedAt: data.subscription.createdAt,
    providerUpdatedAt: data.subscription.updatedAt,
    paymentCreatedAt: data.payment?.createdAt ?? null,
    paymentUpdatedAt: data.payment?.updatedAt ?? null,
    cancelledAt: null,
    occurredAt: null,
  };
}

function normalizeSubscriptionCancelled(
  envelope: AbacatePayWebhookEnvelope,
): NormalizedAbacatePayWebhookEvent {
  const data = parseEventData(cancelledDataSchema, envelope.data);
  if (
    data.payment &&
    (data.payment.amount !== data.subscription.amount ||
      data.payment.paidAmount !== data.subscription.amount)
  ) {
    throw invalidEventPayload();
  }
  if (
    data.checkout &&
    (data.checkout.amount !== data.subscription.amount ||
      data.checkout.paidAmount !== data.subscription.amount)
  ) {
    throw invalidEventPayload();
  }
  const providerCustomerId = correlatedCustomerId(
    data.customer?.id,
    data.checkout?.customerId,
  );

  return {
    ...normalizedBase(envelope, "subscription_cancelled"),
    providerSubscriptionId: data.subscription.id,
    providerPaymentId: data.payment?.id ?? null,
    providerCheckoutId: data.checkout?.id ?? null,
    checkoutExternalId: data.checkout?.externalId ?? null,
    providerInstallmentId: null,
    providerCustomerId,
    providerProductId: data.checkout?.items[0].id ?? null,
    amountCents: data.subscription.amount,
    paidAmountCents:
      data.payment?.paidAmount ?? data.checkout?.paidAmount ?? null,
    currency: "BRL",
    paymentMethod: "CARD",
    billingCycle: "MONTHLY",
    subscriptionStatus: "CANCELLED",
    paymentStatus: data.payment ? "PAID" : null,
    checkoutStatus: data.checkout ? "PAID" : null,
    checkoutFrequency: data.checkout ? "SUBSCRIPTION" : null,
    installmentNumber: null,
    retryNumber: null,
    maxRetry: data.subscription.retryPolicy?.maxRetry ?? null,
    retryEveryDays: data.subscription.retryPolicy?.retryEvery ?? null,
    failureReason: null,
    cancelledDueTo: data.subscription.cancelledDueTo,
    providerCreatedAt: data.subscription.createdAt,
    providerUpdatedAt: data.subscription.updatedAt,
    paymentCreatedAt: data.payment?.createdAt ?? null,
    paymentUpdatedAt: data.payment?.updatedAt ?? null,
    cancelledAt: data.subscription.canceledAt,
    occurredAt: data.subscription.canceledAt,
  };
}

function normalizeCheckoutRisk(
  envelope: AbacatePayWebhookEnvelope,
): NormalizedAbacatePayWebhookEvent {
  const data = parseEventData(checkoutRiskDataSchema, envelope.data);
  if (
    envelope.event === "checkout.disputed" &&
    data.checkout.status !== "PAID"
  ) {
    throw invalidEventPayload();
  }
  if (data.checkout.paidAmount !== data.checkout.amount) {
    throw invalidEventPayload();
  }
  const providerCustomerId = correlatedCustomerId(
    data.customer?.id,
    data.checkout.customerId,
  );

  return {
    ...normalizedBase(envelope, "checkout_risk"),
    providerSubscriptionId: null,
    providerPaymentId: null,
    providerCheckoutId: data.checkout.id,
    checkoutExternalId: data.checkout.externalId ?? null,
    providerInstallmentId: null,
    providerCustomerId,
    providerProductId: data.checkout.items?.[0]?.id ?? null,
    amountCents: data.checkout.amount,
    paidAmountCents: data.checkout.paidAmount,
    currency: null,
    paymentMethod: "CARD",
    billingCycle: null,
    subscriptionStatus: null,
    // Checkout risk payloads do not contain a payment object. Keep this null
    // even when the embedded checkout reports PAID.
    paymentStatus: null,
    checkoutStatus: data.checkout.status,
    checkoutFrequency: data.checkout.frequency,
    installmentNumber: null,
    retryNumber: null,
    maxRetry: null,
    retryEveryDays: null,
    failureReason: data.reason,
    cancelledDueTo: null,
    providerCreatedAt: data.checkout.createdAt,
    providerUpdatedAt: data.checkout.updatedAt,
    paymentCreatedAt: null,
    paymentUpdatedAt: null,
    cancelledAt: null,
    occurredAt: null,
  };
}

function normalizedBase(
  envelope: AbacatePayWebhookEnvelope,
  kind: NormalizedAbacatePayWebhookKind,
) {
  return {
    kind,
    providerEventId: envelope.id,
    eventType: envelope.event,
    apiVersion: 2 as const,
    devMode: envelope.devMode,
    paidAt: null,
    failedAt: null,
    cycleStartedAt: null,
    cycleEndedAt: null,
    accessPaidThrough: null,
  };
}

function parseEventData<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw invalidEventPayload();
  return parsed.data;
}

function assertSuccessfulAmounts(
  subscriptionAmount: number,
  paymentAmount: number,
  paymentPaidAmount: number,
  checkoutAmount: number,
  checkoutPaidAmount: number,
): void {
  if (
    subscriptionAmount !== paymentAmount ||
    subscriptionAmount !== paymentPaidAmount ||
    subscriptionAmount !== checkoutAmount ||
    subscriptionAmount !== checkoutPaidAmount
  ) {
    throw invalidEventPayload();
  }
}

function correlatedCustomerId(
  customerId: string | null | undefined,
  checkoutCustomerId: string | null | undefined,
): string | null {
  if (customerId && checkoutCustomerId && customerId !== checkoutCustomerId) {
    throw invalidEventPayload();
  }
  return checkoutCustomerId ?? customerId ?? null;
}

function assertNormalizedProviderTimeline(
  event: NormalizedAbacatePayWebhookEvent,
): NormalizedAbacatePayWebhookEvent {
  if (
    !normalizedDatePairIsOrdered(
      event.providerCreatedAt,
      event.providerUpdatedAt,
    ) ||
    !normalizedDatePairIsOrdered(
      event.paymentCreatedAt,
      event.paymentUpdatedAt,
    ) ||
    (event.kind === "subscription_cancelled" &&
      (!event.cancelledAt ||
        (event.providerCreatedAt !== null &&
          event.cancelledAt < event.providerCreatedAt) ||
        (event.providerUpdatedAt !== null &&
          event.cancelledAt > event.providerUpdatedAt)))
  ) {
    throw invalidEventPayload();
  }
  return event;
}

function normalizedDatePairIsOrdered(
  start: Date | null,
  end: Date | null,
): boolean {
  return start === null || end === null || start <= end;
}

function invalidEventPayload(): AbacatePayWebhookContractError {
  return new AbacatePayWebhookContractError("INVALID_EVENT_PAYLOAD");
}
