import { describe, expect, it } from "vitest";

import {
  ABACATEPAY_WEBHOOK_EVENT_TYPES,
  AbacatePayWebhookContractError,
  type AbacatePayWebhookContractErrorCode,
  normalizeAbacatePayWebhookEvent,
  parseAbacatePayWebhookEnvelope,
  parseAndNormalizeAbacatePayWebhook,
} from "./abacatepay-webhook";

const createdAt = "2026-06-01T12:00:00.000Z";
const updatedAt = "2026-07-01T12:00:05.000Z";
const cancelledAt = "2026-07-02T09:30:00.000Z";

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subs_golden",
    amount: 2990,
    currency: "BRL",
    method: "CARD",
    status: "ACTIVE",
    frequency: "MONTHLY",
    createdAt,
    updatedAt,
    canceledAt: null,
    cancelPolicy: null,
    cancelledDueTo: null,
    futureSubscriptionField: { accepted: true },
    ...overrides,
  };
}

function paidPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "char_golden",
    amount: 2990,
    paidAmount: 2990,
    status: "PAID",
    methods: ["CARD"],
    createdAt,
    updatedAt,
    futurePaymentField: true,
    ...overrides,
  };
}

function paidCheckout(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill_golden",
    externalId: null,
    url: "https://app.abacatepay.com/pay/bill_golden",
    amount: 2990,
    paidAmount: 2990,
    frequency: "SUBSCRIPTION",
    items: [{ id: "prod_monthly", quantity: 1, futureItemField: true }],
    status: "PAID",
    methods: ["CARD"],
    customerId: "cust_golden",
    createdAt,
    updatedAt,
    futureCheckoutField: true,
    ...overrides,
  };
}

function successData(overrides: Record<string, unknown> = {}) {
  return {
    subscription: subscription(),
    customer: { id: "cust_golden", futureCustomerField: true },
    payment: paidPayment(),
    checkout: paidCheckout(),
    payerInformation: { ignored: true },
    ...overrides,
  };
}

function webhook(
  event: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "log_golden",
    event,
    apiVersion: 2,
    devMode: true,
    data: { ...data, futureDataField: ["accepted"] },
    futureEnvelopeField: "accepted",
    ...overrides,
  };
}

function expectContractError(
  code: AbacatePayWebhookContractErrorCode,
  action: () => unknown,
): void {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(AbacatePayWebhookContractError);
    expect(error).toMatchObject({ code });
  }
}

describe("parseAbacatePayWebhookEnvelope", () => {
  it("accepts the minimal v2 envelope and preserves future fields", () => {
    const parsed = parseAbacatePayWebhookEnvelope(
      webhook("subscription.completed", successData()),
      true,
    );

    expect(parsed).toMatchObject({
      id: "log_golden",
      event: "subscription.completed",
      apiVersion: 2,
      devMode: true,
      futureEnvelopeField: "accepted",
      data: { futureDataField: ["accepted"] },
    });
  });

  it.each(ABACATEPAY_WEBHOOK_EVENT_TYPES)("allowlists %s", (event) => {
    expect(parseAbacatePayWebhookEnvelope(webhook(event, {}), true).event).toBe(
      event,
    );
  });

  it.each([
    ["wrong event id prefix", { id: "evt_golden" }],
    ["empty event id", { id: "log_" }],
    ["unknown event", { event: "subscription.plan_changed" }],
    ["string API version", { apiVersion: "2" }],
    ["wrong API version", { apiVersion: 1 }],
    ["missing API version", { apiVersion: undefined }],
    ["missing devMode", { devMode: undefined }],
    ["non-boolean devMode", { devMode: "true" }],
    ["non-object data", { data: [] }],
  ])("rejects %s", (_label, overrides) => {
    expectContractError("INVALID_ENVELOPE", () =>
      parseAbacatePayWebhookEnvelope(
        webhook("subscription.completed", successData(), overrides),
        true,
      ),
    );
  });

  it("rejects a webhook from the other provider environment", () => {
    expectContractError("ENVIRONMENT_MISMATCH", () =>
      parseAbacatePayWebhookEnvelope(
        webhook("subscription.completed", successData(), { devMode: false }),
        true,
      ),
    );
  });

  it("fails closed when the expected environment is malformed at runtime", () => {
    expectContractError("INVALID_EXPECTED_ENVIRONMENT", () =>
      parseAbacatePayWebhookEnvelope(
        webhook("subscription.completed", successData()),
        "true" as unknown as boolean,
      ),
    );
  });
});

describe("successful subscription webhook normalization", () => {
  it.each(["subscription.completed", "subscription.renewed"] as const)(
    "normalizes %s without inventing entitlement or cycle timestamps",
    (event) => {
      const normalized = parseAndNormalizeAbacatePayWebhook(
        webhook(event, successData()),
        true,
      );

      expect(normalized).toMatchObject({
        kind: "subscription_success",
        providerEventId: "log_golden",
        eventType: event,
        providerSubscriptionId: "subs_golden",
        providerPaymentId: "char_golden",
        providerCheckoutId: "bill_golden",
        checkoutExternalId: null,
        providerCustomerId: "cust_golden",
        providerProductId: "prod_monthly",
        amountCents: 2990,
        paidAmountCents: 2990,
        currency: "BRL",
        paymentMethod: "CARD",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        paymentStatus: "PAID",
        checkoutStatus: "PAID",
        paidAt: null,
        occurredAt: null,
        cycleStartedAt: null,
        cycleEndedAt: null,
        accessPaidThrough: null,
      });
      expect(normalized.providerCreatedAt).toEqual(new Date(createdAt));
      expect(normalized.providerUpdatedAt).toEqual(new Date(updatedAt));
      expect(normalized).not.toHaveProperty("payerInformation");
      expect(normalized).not.toHaveProperty("futureEnvelopeField");
    },
  );

  it("accepts a null customer and uses the correlated checkout customer", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("subscription.completed", successData({ customer: null })),
      true,
    );
    expect(normalized.providerCustomerId).toBe("cust_golden");
  });

  it.each([
    ["missing subscription", successData({ subscription: undefined })],
    ["missing payment", successData({ payment: undefined })],
    ["missing checkout", successData({ checkout: undefined })],
    [
      "bad subscription id",
      successData({ subscription: subscription({ id: "bill_wrong" }) }),
    ],
    [
      "bad payment id",
      successData({ payment: paidPayment({ id: "pay_wrong" }) }),
    ],
    [
      "bad checkout id",
      successData({ checkout: paidCheckout({ id: "char_wrong" }) }),
    ],
    [
      "PIX subscription",
      successData({ subscription: subscription({ method: "PIX" }) }),
    ],
    [
      "annual subscription",
      successData({ subscription: subscription({ frequency: "ANNUALLY" }) }),
    ],
    [
      "trial subscription",
      successData({ subscription: subscription({ trialDays: 7 }) }),
    ],
    [
      "inactive subscription",
      successData({ subscription: subscription({ status: "CANCELLED" }) }),
    ],
    [
      "failed payment",
      successData({ payment: paidPayment({ status: "FAILED" }) }),
    ],
    [
      "PIX payment",
      successData({ payment: paidPayment({ methods: ["PIX"] }) }),
    ],
    [
      "one-time checkout",
      successData({ checkout: paidCheckout({ frequency: "ONE_TIME" }) }),
    ],
    [
      "pending checkout",
      successData({ checkout: paidCheckout({ status: "PENDING" }) }),
    ],
    [
      "amount mismatch",
      successData({ payment: paidPayment({ amount: 3990 }) }),
    ],
    ["customer mismatch", successData({ customer: { id: "cust_other" } })],
  ])("rejects %s", (_label, data) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("subscription.completed", data),
        true,
      ),
    );
  });

  it.each([
    [
      "subscription created after its update",
      successData({
        subscription: subscription({
          createdAt: "2026-07-01T12:00:06.000Z",
        }),
      }),
    ],
    [
      "payment created after its update",
      successData({
        payment: paidPayment({ createdAt: "2026-07-01T12:00:06.000Z" }),
      }),
    ],
  ])("rejects an incoherent provider timeline: %s", (_label, data) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("subscription.completed", data),
        true,
      ),
    );
  });
});

describe("subscription.payment_failed normalization", () => {
  it("accepts the documented installment/retry variant without inventing failedAt", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("subscription.payment_failed", {
        subscription: subscription({
          retryPolicy: { maxRetry: 3, retryEvery: 2, futureRetryField: true },
        }),
        installmentId: "intl_golden",
        installmentNumber: 2,
        retryNumber: 1,
      }),
      true,
    );

    expect(normalized).toMatchObject({
      kind: "subscription_payment_failed",
      providerSubscriptionId: "subs_golden",
      providerPaymentId: null,
      providerInstallmentId: "intl_golden",
      installmentNumber: 2,
      retryNumber: 1,
      maxRetry: 3,
      retryEveryDays: 2,
      paymentStatus: "FAILED",
      failedAt: null,
      cycleStartedAt: null,
      cycleEndedAt: null,
      accessPaidThrough: null,
    });
  });

  it("accepts the changelog payment/reason variant without installment fields", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("subscription.payment_failed", {
        subscription: subscription(),
        customer: null,
        payment: {
          id: "char_failed",
          status: "FAILED",
          amount: 2990,
          paidAmount: 0,
          methods: ["CARD"],
          futurePaymentField: "accepted",
        },
        reason: "card_declined",
      }),
      true,
    );

    expect(normalized).toMatchObject({
      providerPaymentId: "char_failed",
      providerInstallmentId: null,
      installmentNumber: null,
      retryNumber: null,
      maxRetry: null,
      failureReason: "card_declined",
      paidAmountCents: 0,
      failedAt: null,
    });
  });

  it.each([
    [
      "no installment or payment identity",
      {
        subscription: subscription({
          retryPolicy: { maxRetry: 3, retryEvery: 2 },
        }),
      },
    ],
    [
      "partial installment identity",
      {
        subscription: subscription({
          retryPolicy: { maxRetry: 3, retryEvery: 2 },
        }),
        installmentId: "intl_golden",
        installmentNumber: 2,
      },
    ],
    [
      "installment identity without retry policy",
      {
        subscription: subscription(),
        installmentId: "intl_golden",
        installmentNumber: 2,
        retryNumber: 1,
      },
    ],
    [
      "retry beyond maxRetry",
      {
        subscription: subscription({
          retryPolicy: { maxRetry: 3, retryEvery: 2 },
        }),
        installmentId: "intl_golden",
        installmentNumber: 2,
        retryNumber: 4,
      },
    ],
    [
      "payment without reason",
      {
        subscription: subscription(),
        payment: { id: "char_failed", status: "FAILED" },
      },
    ],
    [
      "paid payment in a failed event",
      {
        subscription: subscription(),
        payment: { id: "char_failed", status: "PAID" },
        reason: "declined",
      },
    ],
    [
      "payment amount mismatch",
      {
        subscription: subscription(),
        payment: { id: "char_failed", status: "FAILED", amount: 3990 },
        reason: "declined",
      },
    ],
  ])("rejects %s", (_label, data) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("subscription.payment_failed", data),
        true,
      ),
    );
  });
});

describe("subscription.cancelled normalization", () => {
  function cancelledSubscription(overrides: Record<string, unknown> = {}) {
    return subscription({
      status: "CANCELLED",
      updatedAt: cancelledAt,
      canceledAt: cancelledAt,
      cancelPolicy: "NOW",
      cancelledDueTo: null,
      ...overrides,
    });
  }

  it("accepts the automatic minimal max-retry variant", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("subscription.cancelled", {
        subscription: cancelledSubscription({
          retryPolicy: { maxRetry: 3, retryEvery: 2 },
          cancelledDueTo: "max_payment_retries_exceeded",
        }),
        customer: { id: "cust_golden" },
      }),
      true,
    );

    expect(normalized).toMatchObject({
      kind: "subscription_cancelled",
      providerSubscriptionId: "subs_golden",
      providerPaymentId: null,
      providerCheckoutId: null,
      checkoutExternalId: null,
      subscriptionStatus: "CANCELLED",
      cancelledDueTo: "max_payment_retries_exceeded",
      accessPaidThrough: null,
    });
    expect(normalized.cancelledAt).toEqual(new Date(cancelledAt));
    expect(normalized.occurredAt).toEqual(new Date(cancelledAt));
  });

  it("accepts the manual full variant and a null customer", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("subscription.cancelled", {
        subscription: cancelledSubscription(),
        customer: null,
        payment: paidPayment(),
        checkout: paidCheckout(),
      }),
      true,
    );

    expect(normalized).toMatchObject({
      providerPaymentId: "char_golden",
      providerCheckoutId: "bill_golden",
      checkoutExternalId: null,
      providerCustomerId: "cust_golden",
      paymentStatus: "PAID",
      checkoutStatus: "PAID",
      cancelledDueTo: null,
    });
  });

  it.each([
    ["missing canceledAt", cancelledSubscription({ canceledAt: undefined })],
    ["active status", cancelledSubscription({ status: "ACTIVE" })],
    [
      "non-immediate policy",
      cancelledSubscription({ cancelPolicy: "END_OF_CYCLE" }),
    ],
    ["PIX method", cancelledSubscription({ method: "PIX" })],
    ["annual frequency", cancelledSubscription({ frequency: "ANNUALLY" })],
  ])("rejects %s", (_label, invalidSubscription) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("subscription.cancelled", {
          subscription: invalidSubscription,
        }),
        true,
      ),
    );
  });

  it.each([
    [
      "cancellation before provider creation",
      cancelledSubscription({
        createdAt: "2026-07-02T09:30:01.000Z",
      }),
    ],
    [
      "cancellation after provider update",
      cancelledSubscription({
        updatedAt: "2026-07-02T09:29:59.000Z",
      }),
    ],
  ])("rejects %s", (_label, invalidSubscription) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("subscription.cancelled", {
          subscription: invalidSubscription,
        }),
        true,
      ),
    );
  });
});

describe("checkout refund/dispute normalization", () => {
  function riskCheckout(overrides: Record<string, unknown> = {}) {
    return {
      id: "bill_risk",
      externalId: "local-payment",
      amount: 2990,
      paidAmount: 2990,
      frequency: "ONE_TIME",
      status: "PAID",
      methods: ["CARD"],
      customerId: "cust_golden",
      items: [{ id: "prod_monthly", quantity: 1 }],
      createdAt,
      updatedAt,
      futureCheckoutField: true,
      ...overrides,
    };
  }

  it.each([
    ["checkout.refunded", "checkout_risk"],
    ["checkout.disputed", "checkout_risk"],
  ] as const)("accepts the documented PAID checkout in %s", (event, kind) => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook(event, {
        checkout: riskCheckout(),
        customer: { id: "cust_golden" },
        reason: "requested_by_customer",
      }),
      true,
    );

    expect(normalized).toMatchObject({
      kind,
      providerSubscriptionId: null,
      providerPaymentId: null,
      providerCheckoutId: "bill_risk",
      checkoutExternalId: "local-payment",
      providerCustomerId: "cust_golden",
      providerProductId: "prod_monthly",
      checkoutStatus: "PAID",
      checkoutFrequency: "ONE_TIME",
      paymentMethod: "CARD",
      paymentStatus: null,
      billingCycle: null,
      failureReason: "requested_by_customer",
      occurredAt: null,
      accessPaidThrough: null,
    });
  });

  it("accepts a subscription checkout and the REFUNDED status variant for refund", () => {
    const normalized = parseAndNormalizeAbacatePayWebhook(
      webhook("checkout.refunded", {
        checkout: riskCheckout({
          frequency: "SUBSCRIPTION",
          status: "REFUNDED",
        }),
        reason: "refund_confirmed",
      }),
      true,
    );
    expect(normalized).toMatchObject({
      checkoutFrequency: "SUBSCRIPTION",
      checkoutStatus: "REFUNDED",
    });
  });

  it("rejects a checkout update before its creation", () => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("checkout.refunded", {
          checkout: riskCheckout({
            createdAt: "2026-07-01T12:00:06.000Z",
          }),
          reason: "requested_by_customer",
        }),
        true,
      ),
    );
  });

  it.each([
    ["missing checkout", { reason: "requested" }],
    ["missing reason", { checkout: riskCheckout() }],
    [
      "bad checkout id",
      { checkout: riskCheckout({ id: "char_wrong" }), reason: "requested" },
    ],
    [
      "PIX checkout",
      { checkout: riskCheckout({ methods: ["PIX"] }), reason: "requested" },
    ],
    [
      "refunded status in dispute event",
      { checkout: riskCheckout({ status: "REFUNDED" }), reason: "requested" },
    ],
    [
      "customer mismatch",
      {
        checkout: riskCheckout(),
        customer: { id: "cust_other" },
        reason: "requested",
      },
    ],
    [
      "paid amount mismatch",
      {
        checkout: riskCheckout({ paidAmount: 1990 }),
        reason: "requested",
      },
    ],
  ])("rejects %s", (_label, data) => {
    expectContractError("INVALID_EVENT_PAYLOAD", () =>
      parseAndNormalizeAbacatePayWebhook(
        webhook("checkout.disputed", data),
        true,
      ),
    );
  });

  it("does not let a caller bypass envelope validation before normalization", () => {
    const parsed = parseAbacatePayWebhookEnvelope(
      webhook("checkout.refunded", {
        checkout: riskCheckout(),
        reason: "requested",
      }),
      true,
    );
    const tampered = { ...parsed, id: "evt_tampered" };

    expectContractError("INVALID_ENVELOPE", () =>
      normalizeAbacatePayWebhookEvent(tampered as typeof parsed),
    );
  });
});
