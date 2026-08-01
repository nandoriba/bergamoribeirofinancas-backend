import { describe, expect, it } from "vitest";

import {
  evaluateSubscriptionAccess,
  type SubscriptionAccessDecision,
  type SubscriptionAccessFacts,
} from "./subscription-access.policy";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const LAST_PAYMENT = new Date("2026-07-01T12:00:00.000Z");
const PAID_THROUGH = new Date("2026-08-01T12:00:00.000Z");
const FUTURE_PAID_THROUGH = new Date("2026-08-02T12:00:00.000Z");
const PAYMENT_FAILED_AT = new Date("2026-08-01T09:00:00.000Z");
const GRACE_UNTIL = new Date("2026-08-04T12:00:00.000Z");

function successfulFacts(
  patch: Partial<SubscriptionAccessFacts> = {},
): SubscriptionAccessFacts {
  return {
    providerStatus: "ACTIVE",
    lastProviderEvent: "subscription.renewed",
    providerUpdatedAt: new Date("2026-07-01T12:00:01.000Z"),
    lastSuccessfulPaymentAt: LAST_PAYMENT,
    accessPaidThrough: FUTURE_PAID_THROUGH,
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    cancelledDueTo: null,
    entitlementContractVersion: "sandbox-contract-v1",
    lastInstallmentNumber: 2,
    billingCycle: "MONTHLY",
    paymentMethod: "CARD",
    ...patch,
  };
}

function pendingFacts(
  patch: Partial<SubscriptionAccessFacts> = {},
): SubscriptionAccessFacts {
  return {
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
    entitlementContractVersion: null,
    lastInstallmentNumber: null,
    billingCycle: "MONTHLY",
    paymentMethod: null,
    ...patch,
  };
}

function failedFacts(
  patch: Partial<SubscriptionAccessFacts> = {},
): SubscriptionAccessFacts {
  return successfulFacts({
    lastProviderEvent: "subscription.payment_failed",
    accessPaidThrough: PAID_THROUGH,
    paymentFailedAt: PAYMENT_FAILED_AT,
    graceUntil: GRACE_UNTIL,
    ...patch,
  });
}

function decide(
  facts: SubscriptionAccessFacts | null | undefined,
  now: Date = NOW,
): SubscriptionAccessDecision {
  return evaluateSubscriptionAccess(facts, () => now);
}

describe("evaluateSubscriptionAccess", () => {
  it.each([
    ["assinatura nula", null],
    ["assinatura ausente", undefined],
  ])("mantém %s em pagamento pendente", (_label, facts) => {
    expect(decide(facts)).toEqual({
      effectiveStatus: "pending_payment",
      accessAllowed: false,
      reason: "SUBSCRIPTION_ABSENT",
    });
  });

  it.each([["null", null]])(
    "não libera o primeiro pagamento quando accessPaidThrough é %s",
    (_label, value) => {
      expect(decide(pendingFacts({ accessPaidThrough: value }))).toEqual({
        effectiveStatus: "pending_payment",
        accessAllowed: false,
        reason: "FIRST_PAYMENT_UNCONFIRMED",
      });
    },
  );

  it("não trata providerStatus ACTIVE isolado como prova de pagamento", () => {
    expect(
      decide(
        pendingFacts({ providerStatus: "ACTIVE", accessPaidThrough: null }),
      ).effectiveStatus,
    ).toBe("suspended");
  });

  it("trata campo ausente em snapshot parcial como suspenso, não como primeiro pagamento", () => {
    expect(decide({ accessPaidThrough: null })).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "INVALID_TIMESTAMP",
    });
  });

  it.each([
    ["status ativo isolado", { providerStatus: "ACTIVE" }],
    [
      "evento de sucesso isolado",
      { lastProviderEvent: "subscription.completed" },
    ],
    ["timestamp do provider isolado", { providerUpdatedAt: LAST_PAYMENT }],
    ["último pagamento isolado", { lastSuccessfulPaymentAt: LAST_PAYMENT }],
    ["falha isolada", { paymentFailedAt: PAYMENT_FAILED_AT }],
    ["tolerância isolada", { graceUntil: GRACE_UNTIL }],
    ["motivo de cancelamento isolado", { cancelledDueTo: "manual" }],
    ["contrato de entitlement isolado", { entitlementContractVersion: "v1" }],
    ["parcela isolada", { lastInstallmentNumber: 1 }],
    ["método isolado", { paymentMethod: "CARD" }],
  ])(
    "não mascara fato parcial como primeiro pagamento: %s",
    (_label, patch) => {
      expect(decide(pendingFacts(patch))).toMatchObject({
        effectiveStatus: "suspended",
        accessAllowed: false,
        reason: "CONTRADICTORY_FACTS",
      });
    },
  );

  it.each([
    ["provider", { providerStatus: "CANCELLED" }],
    ["evento", { lastProviderEvent: "subscription.cancelled" }],
    ["timestamp", { cancelledAt: new Date("2026-08-01T11:59:59.999Z") }],
  ])(
    "cancelamento confirmado por %s prevalece sobre acesso futuro",
    (_label, marker) => {
      expect(decide(successfulFacts(marker))).toEqual({
        effectiveStatus: "cancelled",
        accessAllowed: false,
        reason: "CANCELLATION_CONFIRMED",
      });
    },
  );

  it("cancelamento prevalece até sobre fatos de falha contraditórios", () => {
    expect(
      decide(
        failedFacts({
          providerStatus: "CANCELLED",
          graceUntil: new Date("invalid"),
        }),
      ).effectiveStatus,
    ).toBe("cancelled");
  });

  it("bloqueia durante cancelamento ainda não confirmado pelo provedor", () => {
    expect(
      decide(successfulFacts({ cancelRequestedAt: PAYMENT_FAILED_AT })),
    ).toEqual({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "CANCELLATION_PENDING",
    });
  });

  it.each([
    ["antes do limite", new Date(PAID_THROUGH.getTime() - 1), "active", true],
    ["no limite exato", PAID_THROUGH, "suspended", false],
    [
      "depois do limite",
      new Date(PAID_THROUGH.getTime() + 1),
      "suspended",
      false,
    ],
  ])(
    "aplica a borda estrita de accessPaidThrough: %s",
    (_label, now, effectiveStatus, accessAllowed) => {
      expect(
        decide(successfulFacts({ accessPaidThrough: PAID_THROUGH }), now),
      ).toMatchObject({
        effectiveStatus,
        accessAllowed,
      });
    },
  );

  it.each([
    ["antes do limite", new Date(GRACE_UNTIL.getTime() - 1), "past_due", true],
    ["no limite exato", GRACE_UNTIL, "past_due", true],
    [
      "depois do limite",
      new Date(GRACE_UNTIL.getTime() + 1),
      "suspended",
      false,
    ],
  ])(
    "aplica a borda inclusiva de graceUntil: %s",
    (_label, now, effectiveStatus, accessAllowed) => {
      expect(decide(failedFacts(), now)).toMatchObject({
        effectiveStatus,
        accessAllowed,
      });
    },
  );

  it("reconhece inadimplência mesmo quando o provider ainda informa ACTIVE", () => {
    expect(decide(failedFacts())).toEqual({
      effectiveStatus: "past_due",
      accessAllowed: true,
      reason: "PAYMENT_GRACE",
    });
  });

  it("não exige job para suspender depois da tolerância", () => {
    expect(decide(failedFacts(), new Date("2026-08-05T00:00:00.000Z"))).toEqual(
      {
        effectiveStatus: "suspended",
        accessAllowed: false,
        reason: "GRACE_EXPIRED",
      },
    );
  });

  it.each([
    ["relógio inválido", () => new Date("invalid")],
    [
      "relógio que lança",
      () => {
        throw new Error("clock unavailable");
      },
    ],
  ])("falha fechado com %s", (_label, clock) => {
    expect(evaluateSubscriptionAccess(successfulFacts(), clock)).toEqual({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "INVALID_CLOCK",
    });
  });

  it.each([
    ["array", []],
    ["Date", NOW],
    ["string", "ACTIVE"],
    ["número", 1],
  ])("falha fechado quando o conjunto de fatos é %s", (_label, facts) => {
    expect(evaluateSubscriptionAccess(facts as never, () => NOW).reason).toBe(
      "INVALID_FACTS",
    );
  });

  it.each([
    [
      "accessPaidThrough string",
      { accessPaidThrough: PAID_THROUGH.toISOString() },
    ],
    ["accessPaidThrough inválido", { accessPaidThrough: new Date("invalid") }],
    ["providerUpdatedAt string", { providerUpdatedAt: NOW.toISOString() }],
    [
      "lastSuccessfulPaymentAt inválido",
      { lastSuccessfulPaymentAt: new Date("invalid") },
    ],
    [
      "paymentFailedAt string",
      { paymentFailedAt: PAYMENT_FAILED_AT.toISOString() },
    ],
    ["graceUntil inválido", { graceUntil: new Date("invalid") }],
    [
      "cancelledAt futuro inválido para cancelamento",
      { cancelledAt: new Date("invalid") },
    ],
    [
      "cancelRequestedAt string",
      { cancelRequestedAt: PAYMENT_FAILED_AT.toISOString() },
    ],
  ])("suspende timestamp malformado: %s", (_label, patch) => {
    expect(decide(successfulFacts(patch))).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "INVALID_TIMESTAMP",
    });
  });

  it.each([
    [
      "providerUpdatedAt futuro",
      { providerUpdatedAt: new Date(NOW.getTime() + 1) },
    ],
    [
      "lastSuccessfulPaymentAt futuro",
      {
        lastSuccessfulPaymentAt: new Date(NOW.getTime() + 1),
        accessPaidThrough: new Date(NOW.getTime() + 2),
      },
    ],
    [
      "paymentFailedAt futuro",
      { paymentFailedAt: new Date(NOW.getTime() + 1) },
    ],
    ["cancelledAt futuro", { cancelledAt: new Date(NOW.getTime() + 1) }],
    [
      "cancelRequestedAt futuro",
      { cancelRequestedAt: new Date(NOW.getTime() + 1) },
    ],
  ])("suspende timestamp causal no futuro: %s", (_label, patch) => {
    const facts =
      "paymentFailedAt" in patch ? failedFacts(patch) : successfulFacts(patch);
    expect(decide(facts)).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "CONTRADICTORY_FACTS",
    });
  });

  it.each([
    ["providerStatus ausente", { providerStatus: undefined }, "INVALID_FACTS"],
    [
      "providerStatus desconhecido",
      { providerStatus: "PAUSED" },
      "UNKNOWN_PROVIDER_STATUS",
    ],
    [
      "providerStatus minúsculo",
      { providerStatus: "active" },
      "UNKNOWN_PROVIDER_STATUS",
    ],
    ["evento ausente", { lastProviderEvent: undefined }, "INVALID_FACTS"],
    [
      "evento desconhecido",
      { lastProviderEvent: "subscription.paused" },
      "UNKNOWN_PROVIDER_EVENT",
    ],
    ["ciclo anual", { billingCycle: "YEARLY" }, "UNSUPPORTED_BILLING_CYCLE"],
    ["ciclo ausente", { billingCycle: undefined }, "INVALID_FACTS"],
    ["Pix", { paymentMethod: "PIX" }, "UNSUPPORTED_PAYMENT_METHOD"],
    ["método ausente", { paymentMethod: undefined }, "INVALID_FACTS"],
    [
      "contrato ausente",
      { entitlementContractVersion: undefined },
      "INVALID_FACTS",
    ],
  ])(
    "suspende fato desconhecido ou fora do produto: %s",
    (_label, patch, reason) => {
      expect(decide(successfulFacts(patch))).toMatchObject({
        effectiveStatus: "suspended",
        accessAllowed: false,
        reason,
      });
    },
  );

  it.each([
    ["providerUpdatedAt ausente", { providerUpdatedAt: null }],
    ["último pagamento ausente", { lastSuccessfulPaymentAt: null }],
    ["parcela ausente", { lastInstallmentNumber: null }],
    ["parcela zero", { lastInstallmentNumber: 0 }],
    ["parcela fracionária", { lastInstallmentNumber: 1.5 }],
    ["contrato vazio", { entitlementContractVersion: "  " }],
  ])("suspende fato obrigatório ausente ou inválido: %s", (_label, patch) => {
    expect(decide(successfulFacts(patch))).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "INVALID_FACTS",
    });
  });

  it.each([
    [
      "pagamento no mesmo instante do fim do acesso",
      { lastSuccessfulPaymentAt: FUTURE_PAID_THROUGH },
    ],
    ["motivo de cancelamento sem cancelamento", { cancelledDueTo: "manual" }],
    ["falha residual após renewed", { paymentFailedAt: PAYMENT_FAILED_AT }],
    ["tolerância residual após renewed", { graceUntil: GRACE_UNTIL }],
  ])("suspende fatos contraditórios de sucesso: %s", (_label, patch) => {
    expect(decide(successfulFacts(patch))).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "CONTRADICTORY_FACTS",
    });
  });

  it.each([
    ["falha sem paymentFailedAt", { paymentFailedAt: null }],
    ["falha sem graceUntil", { graceUntil: null }],
    [
      "falha anterior ao último pagamento",
      { paymentFailedAt: new Date(LAST_PAYMENT.getTime() - 1) },
    ],
    ["tolerância anterior ao período pago", { graceUntil: PAID_THROUGH }],
    [
      "tolerância anterior à falha",
      {
        accessPaidThrough: new Date("2026-07-02T12:00:00.000Z"),
        graceUntil: new Date(PAYMENT_FAILED_AT.getTime() - 1),
      },
    ],
  ])("suspende fatos contraditórios de inadimplência: %s", (_label, patch) => {
    expect(decide(failedFacts(patch))).toMatchObject({
      effectiveStatus: "suspended",
      accessAllowed: false,
      reason: "CONTRADICTORY_FACTS",
    });
  });

  it("aceita completed como primeiro evento pago válido", () => {
    expect(
      decide(successfulFacts({ lastProviderEvent: "subscription.completed" })),
    ).toEqual({
      effectiveStatus: "active",
      accessAllowed: true,
      reason: "PAID_ACCESS",
    });
  });

  it("não muta os fatos nem o Date fornecido pelo relógio", () => {
    const facts = successfulFacts();
    const before = JSON.stringify(facts);
    const nowBefore = NOW.getTime();

    decide(facts);

    expect(JSON.stringify(facts)).toBe(before);
    expect(NOW.getTime()).toBe(nowBefore);
  });
});
