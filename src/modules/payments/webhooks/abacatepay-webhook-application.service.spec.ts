import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
  WebhookProcessingStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../../../prisma/prisma.service";
import { parseAndNormalizeAbacatePayWebhook } from "./abacatepay-webhook";
import {
  AbacatePayWebhookApplicationError,
  AbacatePayWebhookApplicationService,
} from "./abacatepay-webhook-application.service";

const NOW = new Date("2024-02-29T12:30:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CREATED_AT = "2024-01-01T12:00:00.000Z";
const UPDATED_AT = "2024-02-28T12:00:00.000Z";
const CANCELLATION_OCCURRED_AT = new Date("2024-02-28T18:00:00.000Z");

interface MemorySubscription {
  id: string;
  familyId: string;
  provider: string;
  externalId: string;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  providerCheckoutId: string | null;
  providerProductId: string;
  amountCents: number;
  currency: string;
  paymentMethod: SubscriptionPaymentMethod | null;
  providerPaymentMethod: string | null;
  billingCycle: SubscriptionCycle;
  devMode: boolean;
  providerStatus: string | null;
  lastProviderEvent: string | null;
  cancelledAt: Date | null;
  cancelledDueTo: string | null;
  cancelClaimToken: string | null;
  cancelLockedAt: Date | null;
  cancelLastErrorCode: string | null;
  createdAt: Date;
}

interface MemoryPayment {
  id: string;
  subscriptionId: string;
  familyId: string;
  providerPaymentId: string | null;
  providerCheckoutId: string | null;
  providerInstallmentId: string | null;
  providerStatus: string;
  providerUpdatedAt: Date | null;
  amountCents: number;
  currency: string;
  paymentMethod: SubscriptionPaymentMethod | null;
  providerPaymentMethod: string | null;
}

interface MemoryFamily {
  id: string;
  currentSubscriptionId: string | null;
  pendingPaymentExpiresAt: Date | null;
  cancelledAt: Date | null;
  purgeAfter: Date | null;
}

interface MemoryEvent extends Record<string, unknown> {
  id: string;
  provider: string;
  providerEventId: string;
  payloadHash: string;
  processingStatus: WebhookProcessingStatus;
  errorCode: string | null;
}

interface MemoryState {
  subscriptions: Map<string, MemorySubscription>;
  payments: Map<string, MemoryPayment>;
  families: Map<string, MemoryFamily>;
  events: Map<string, MemoryEvent>;
}

class MemoryWebhookPrisma {
  state: MemoryState = {
    subscriptions: new Map(),
    payments: new Map(),
    families: new Map(),
    events: new Map(),
  };

  readonly calls = {
    eventCreates: 0,
    subscriptionUpdates: 0,
    paymentUpdates: 0,
    familyUpdates: 0,
  };

  failNextEventFinalization = false;
  failNextPaymentUpdate = false;
  serializationFailures = 0;
  private nextEventId = 1;
  private transactionTail: Promise<void> = Promise.resolve();

  readonly paymentWebhookEvent = {
    findUnique: vi.fn(async (args: unknown) => findEvent(this.state, args)),
  };

  readonly $transaction = vi.fn(
    async (
      operation: (
        tx: ReturnType<MemoryWebhookPrisma["transactionClient"]>,
      ) => Promise<unknown>,
      _options?: unknown,
    ) => this.transaction(operation),
  );

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  seedSubscription(
    overrides: Partial<MemorySubscription> = {},
  ): MemorySubscription {
    const subscription: MemorySubscription = {
      id: "subscription-current",
      familyId: "family-1",
      provider: "abacatepay",
      externalId: "local_golden",
      providerSubscriptionId: "subs_golden",
      providerCustomerId: "cust_golden",
      providerCheckoutId: "bill_golden",
      providerProductId: "prod_monthly",
      amountCents: 2_990,
      currency: "BRL",
      paymentMethod: SubscriptionPaymentMethod.CARD,
      providerPaymentMethod: "CARD",
      billingCycle: SubscriptionCycle.MONTHLY,
      devMode: true,
      providerStatus: "ACTIVE",
      lastProviderEvent: null,
      cancelledAt: null,
      cancelledDueTo: null,
      cancelClaimToken: null,
      cancelLockedAt: null,
      cancelLastErrorCode: null,
      createdAt: new Date(CREATED_AT),
      ...overrides,
    };
    this.state.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  seedFamily(overrides: Partial<MemoryFamily> = {}): MemoryFamily {
    const family: MemoryFamily = {
      id: "family-1",
      currentSubscriptionId: "subscription-current",
      pendingPaymentExpiresAt: new Date("2024-03-10T00:00:00.000Z"),
      cancelledAt: null,
      purgeAfter: null,
      ...overrides,
    };
    this.state.families.set(family.id, family);
    return family;
  }

  seedPayment(overrides: Partial<MemoryPayment> = {}): MemoryPayment {
    const payment: MemoryPayment = {
      id: "payment-1",
      subscriptionId: "subscription-current",
      familyId: "family-1",
      providerPaymentId: "char_golden",
      providerCheckoutId: "bill_golden",
      providerInstallmentId: null,
      providerStatus: "PAID",
      providerUpdatedAt: new Date(CREATED_AT),
      amountCents: 2_990,
      currency: "BRL",
      paymentMethod: SubscriptionPaymentMethod.CARD,
      providerPaymentMethod: "CARD",
      ...overrides,
    };
    this.state.payments.set(payment.id, payment);
    return payment;
  }

  private async transaction(
    operation: (
      tx: ReturnType<MemoryWebhookPrisma["transactionClient"]>,
    ) => Promise<unknown>,
  ): Promise<unknown> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const draft = structuredClone(this.state);
    try {
      const result = await operation(this.transactionClient(draft));
      if (this.serializationFailures > 0) {
        this.serializationFailures -= 1;
        throw prismaError("P2034");
      }
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }

  private transactionClient(draft: MemoryState) {
    return {
      $queryRaw: vi.fn(async (...args: unknown[]) => {
        const familyId = args[1] as string;
        return draft.families.has(familyId) ? [{ id: familyId }] : [];
      }),
      paymentWebhookEvent: {
        findUnique: vi.fn(async (args: unknown) => findEvent(draft, args)),
        findMany: vi.fn(async (args: unknown) => {
          const where = (
            args as {
              where: {
                provider: string;
                providerCheckoutId: string;
                signatureValid: boolean;
                eventType: { in: string[] };
                processingStatus: WebhookProcessingStatus;
                errorCode: string;
              };
            }
          ).where;
          const seen = new Set<string>();
          const mappings: Array<{
            subscription: MemorySubscription | null;
          }> = [];
          for (const record of draft.events.values()) {
            if (
              record.provider !== where.provider ||
              record.providerCheckoutId !== where.providerCheckoutId ||
              record.signatureValid !== where.signatureValid ||
              !where.eventType.in.includes(String(record.eventType)) ||
              record.processingStatus !== where.processingStatus ||
              record.errorCode !== where.errorCode ||
              typeof record.subscriptionId !== "string" ||
              seen.has(record.subscriptionId)
            ) {
              continue;
            }
            seen.add(record.subscriptionId);
            mappings.push({
              subscription:
                draft.subscriptions.get(record.subscriptionId) ?? null,
            });
          }
          return mappings;
        }),
        create: vi.fn(async (args: unknown) => {
          const data = (args as { data: Record<string, unknown> }).data;
          const key = eventKey(
            String(data.provider),
            String(data.providerEventId),
          );
          if (draft.events.has(key)) throw prismaError("P2002");
          this.calls.eventCreates += 1;
          const record: MemoryEvent = {
            ...structuredClone(data),
            id: `webhook-event-${this.nextEventId++}`,
            provider: String(data.provider),
            providerEventId: String(data.providerEventId),
            payloadHash: String(data.payloadHash),
            processingStatus: data.processingStatus as WebhookProcessingStatus,
            errorCode:
              typeof data.errorCode === "string" ? data.errorCode : null,
          };
          draft.events.set(key, record);
          return { id: record.id };
        }),
        updateMany: vi.fn(async (args: unknown) => {
          const input = args as {
            where: {
              id: string;
              payloadHash: string;
              OR: Array<{
                processingStatus:
                  | WebhookProcessingStatus
                  | { in: WebhookProcessingStatus[] };
                errorCode?: string | null | { in: string[] };
              }>;
            };
            data: Record<string, unknown>;
          };
          const record = [...draft.events.values()].find(
            (candidate) =>
              candidate.id === input.where.id &&
              candidate.payloadHash === input.where.payloadHash &&
              input.where.OR.some(
                (condition) =>
                  (typeof condition.processingStatus === "string"
                    ? candidate.processingStatus === condition.processingStatus
                    : condition.processingStatus.in.includes(
                        candidate.processingStatus,
                      )) &&
                  (condition.errorCode === undefined ||
                    (condition.errorCode !== null &&
                    typeof condition.errorCode === "object"
                      ? condition.errorCode.in.includes(
                          String(candidate.errorCode),
                        )
                      : candidate.errorCode === condition.errorCode)),
              ),
          );
          if (!record) return { count: 0 };
          const attempts = input.data.attempts as
            | { increment?: number }
            | undefined;
          Object.assign(record, structuredClone(input.data), {
            attempts:
              Number(record.attempts ?? 0) + Number(attempts?.increment ?? 0),
          });
          return { count: 1 };
        }),
        update: vi.fn(async (args: unknown) => {
          const input = args as {
            where: { id: string };
            data: Record<string, unknown>;
          };
          if (this.failNextEventFinalization) {
            this.failNextEventFinalization = false;
            throw new Error("simulated finalization failure");
          }
          const record = [...draft.events.values()].find(
            (candidate) => candidate.id === input.where.id,
          );
          if (!record) throw new Error("event not found");
          Object.assign(record, structuredClone(input.data));
          return record;
        }),
      },
      subscription: {
        findUnique: vi.fn(async (args: unknown) =>
          findSubscription(draft, args),
        ),
        updateMany: vi.fn(async (args: unknown) => {
          const input = args as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          };
          const subscription = [...draft.subscriptions.values()].find(
            (candidate) => matches(candidate, input.where),
          );
          if (!subscription) return { count: 0 };
          this.calls.subscriptionUpdates += 1;
          Object.assign(subscription, structuredClone(input.data));
          return { count: 1 };
        }),
      },
      subscriptionPayment: {
        findUnique: vi.fn(async (args: unknown) => findPayment(draft, args)),
        updateMany: vi.fn(async (args: unknown) => {
          const input = args as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          };
          const payment = [...draft.payments.values()].find((candidate) =>
            matches(candidate, input.where),
          );
          if (!payment) return { count: 0 };
          if (this.failNextPaymentUpdate) {
            this.failNextPaymentUpdate = false;
            return { count: 0 };
          }
          this.calls.paymentUpdates += 1;
          Object.assign(payment, structuredClone(input.data));
          return { count: 1 };
        }),
      },
      family: {
        findUnique: vi.fn(async (args: unknown) => {
          const id = (args as { where: { id: string } }).where.id;
          return draft.families.get(id) ?? null;
        }),
        updateMany: vi.fn(async (args: unknown) => {
          const input = args as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          };
          const family = [...draft.families.values()].find((candidate) =>
            matches(candidate, input.where),
          );
          if (!family) return { count: 0 };
          this.calls.familyUpdates += 1;
          Object.assign(family, structuredClone(input.data));
          return { count: 1 };
        }),
      },
    };
  }
}

describe("AbacatePayWebhookApplicationService", () => {
  it.each(["subscription.completed", "subscription.renewed"] as const)(
    "quarantines %s even when a positive-entitlement flag is enabled",
    async (eventType) => {
      const fixture = makeFixture({
        ABACATEPAY_POSITIVE_ENTITLEMENT_ENABLED: true,
      });
      const before = structuredClone(
        fixture.prisma.state.subscriptions.get("subscription-current"),
      );

      await expect(
        fixture.service.processAuthenticatedEvent({
          event: normalizedSuccess(eventType),
          payloadHash: HASH_A,
        }),
      ).resolves.toMatchObject({
        disposition: "quarantined",
        code: "ENTITLEMENT_CONTRACT_UNPROVEN",
        subscriptionId: "subscription-current",
      });

      expect(
        fixture.prisma.state.subscriptions.get("subscription-current"),
      ).toEqual(before);
      expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
      expect(fixture.prisma.calls.familyUpdates).toBe(0);
    },
  );

  it("quarantines payment_failed without inventing failedAt, grace or entitlement", async () => {
    const fixture = makeFixture();
    const before = structuredClone(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    );

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedPaymentFailed(),
      payloadHash: HASH_A,
    });

    expect(result).toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toEqual(before);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
  });

  it("stores only the bounded normalized payment failure reason in its dedicated column", async () => {
    const fixture = makeFixture();

    await fixture.service.processAuthenticatedEvent({
      event: normalizedPaymentFailedWithReason(),
      payloadHash: HASH_A,
    });

    expect(singleEvent(fixture.prisma)).toMatchObject({
      providerFailureReason: "card_declined",
      processingStatus: WebhookProcessingStatus.quarantined,
    });
    expect(
      JSON.stringify(singleEvent(fixture.prisma).sanitizedPayload),
    ).not.toContain("card_declined");
  });

  it("recovers an externalId-only event after the checkout ID is reconciled", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: null,
        providerCheckoutId: null,
      },
    );

    const input = {
      event: normalizedProvisioningRace(),
      payloadHash: HASH_A,
    };
    const result = await fixture.service.processAuthenticatedEvent(input);

    expect(result).toMatchObject({
      disposition: "quarantined",
      code: "CHECKOUT_CORRELATION_PENDING",
      subscriptionId: null,
    });
    expect(singleEvent(fixture.prisma)).toMatchObject({
      subscriptionId: null,
      familyId: null,
      providerSubscriptionId: "subs_race",
      providerCheckoutId: "bill_race",
      providerPaymentId: "char_race",
      errorCode: "CHECKOUT_CORRELATION_PENDING",
      attempts: 1,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: null,
      providerStatus: "ACTIVE",
      lastProviderEvent: null,
      cancelledAt: null,
    });

    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerCheckoutId = "bill_race";
    await expect(
      fixture.service.processAuthenticatedEvent(input),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: "subscription-current",
    });
    expect(singleEvent(fixture.prisma)).toMatchObject({
      subscriptionId: "subscription-current",
      familyId: "family-1",
      errorCode: "ENTITLEMENT_CONTRACT_UNPROVEN",
      attempts: 2,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ providerSubscriptionId: "subs_race" });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
  });

  it("uses an authenticated quarantined renewal as the map for its new checkout", async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRenewalWithNewCheckout(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: "subscription-current",
    });
    expect(singleEvent(fixture.prisma)).toMatchObject({
      eventType: "subscription.renewed",
      providerCheckoutId: "bill_renew",
      subscriptionId: "subscription-current",
      processingStatus: WebhookProcessingStatus.quarantined,
      errorCode: "ENTITLEMENT_CONTRACT_UNPROVEN",
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerCheckoutId: "bill_golden",
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRisk("checkout.refunded", "bill_renew"),
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: "subscription-current",
      familyRevoked: true,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerCheckoutId: "bill_golden",
      providerStatus: "ACTIVE",
      lastProviderEvent: "checkout.refunded",
      cancelledAt: NOW,
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: NOW,
      purgeAfter: new Date("2025-02-28T12:30:00.000Z"),
    });
    expect(fixture.prisma.state.events).toHaveLength(2);
  });

  it("quarantines conflicting authenticated checkout history", async () => {
    const fixture = makeFixture();
    fixture.prisma.seedSubscription({
      id: "subscription-other",
      familyId: "family-2",
      providerSubscriptionId: "subs_other",
      providerCheckoutId: "bill_other",
    });
    for (const [eventId, subscriptionId, familyId] of [
      ["log_history_one", "subscription-current", "family-1"],
      ["log_history_two", "subscription-other", "family-2"],
    ] as const) {
      fixture.prisma.state.events.set(eventKey("abacatepay", eventId), {
        id: eventId,
        provider: "abacatepay",
        providerEventId: eventId,
        payloadHash: HASH_A,
        signatureValid: true,
        eventType: "subscription.renewed",
        providerCheckoutId: "bill_shared",
        subscriptionId,
        familyId,
        processingStatus: WebhookProcessingStatus.quarantined,
        errorCode: "ENTITLEMENT_CONTRACT_UNPROVEN",
      });
    }

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRisk("checkout.disputed", "bill_shared"),
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
      subscriptionId: null,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ providerStatus: "ACTIVE", cancelledAt: null });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("quarantines an externalId bind when the persisted checkout ID differs", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: null,
        providerCheckoutId: "bill_persisted",
      },
    );

    const input = {
      event: normalizedProvisioningRace(),
      payloadHash: HASH_A,
    };
    await expect(
      fixture.service.processAuthenticatedEvent(input),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
      subscriptionId: null,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: null,
      providerCheckoutId: "bill_persisted",
      cancelledAt: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
    await expect(
      fixture.service.processAuthenticatedEvent(input),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      originalStatus: WebhookProcessingStatus.quarantined,
    });
    expect(singleEvent(fixture.prisma)).toMatchObject({ attempts: 1 });
  });

  it("never revokes by externalId when the checkout ID differs", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_golden",
        providerCheckoutId: "bill_persisted",
      },
    );

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRisk(
          "checkout.refunded",
          "bill_other",
          "local_golden",
        ),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
      subscriptionId: null,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ providerStatus: "ACTIVE", cancelledAt: null });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: null,
      purgeAfter: null,
    });
    expect(fixture.prisma.calls.paymentUpdates).toBe(0);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("uses the safely bound provider subscription ID for a later minimal cancellation", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: null,
        providerCheckoutId: "bill_race",
      },
    );
    await fixture.service.processAuthenticatedEvent({
      event: normalizedProvisioningRace(),
      payloadHash: HASH_A,
    });

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedCancellation("subs_race", "log_cancelled_after_bind"),
      payloadHash: HASH_B,
    });

    expect(result).toMatchObject({
      disposition: "processed",
      subscriptionId: "subscription-current",
      familyRevoked: true,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: "subs_race",
      providerStatus: "CANCELLED",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
  });

  it("reprocesses a cancellation quarantined before the provider subscription ID is bound", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerSubscriptionId = null;
    const cancellation = normalizedCancellation();

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_NOT_FOUND",
      subscriptionId: null,
    });
    expect(
      fixture.prisma.state.events.get(eventKey("abacatepay", "log_cancelled")),
    ).toMatchObject({
      processingStatus: WebhookProcessingStatus.quarantined,
      errorCode: "CORRELATION_NOT_FOUND",
      attempts: 1,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedSuccess(
          "subscription.completed",
          "log_bind_after_cancel",
        ),
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: "subscription-current",
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ providerSubscriptionId: "subs_golden" });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: "subscription-current",
      familyRevoked: true,
    });
    expect(
      fixture.prisma.state.events.get(eventKey("abacatepay", "log_cancelled")),
    ).toMatchObject({
      processingStatus: WebhookProcessingStatus.processed,
      errorCode: null,
      attempts: 2,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
    expect(fixture.prisma.calls.eventCreates).toBe(2);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(2);
    expect(fixture.prisma.calls.familyUpdates).toBe(1);
  });

  it("binds providerSubscriptionId once under concurrent successful deliveries", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: null,
        providerCheckoutId: "bill_race",
      },
    );

    const results = await Promise.all([
      fixture.service.processAuthenticatedEvent({
        event: normalizedProvisioningRace("local_race", "log_race_one"),
        payloadHash: HASH_A,
      }),
      fixture.service.processAuthenticatedEvent({
        event: normalizedProvisioningRace("local_race", "log_race_two"),
        payloadHash: HASH_B,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ disposition: "quarantined" }),
      expect.objectContaining({ disposition: "quarantined" }),
    ]);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: "subs_race",
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
    expect(fixture.prisma.state.events).toHaveLength(2);
  });

  it("rolls back a providerSubscriptionId bind if event quarantine finalization fails", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: null,
        providerCheckoutId: "bill_race",
      },
    );
    fixture.prisma.failNextEventFinalization = true;
    const input = {
      event: normalizedProvisioningRace(),
      payloadHash: HASH_A,
    };

    await expect(
      fixture.service.processAuthenticatedEvent(input),
    ).rejects.toThrow("simulated finalization failure");
    expect(fixture.prisma.state.events).toHaveLength(0);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: null,
      providerStatus: "ACTIVE",
    });

    await expect(
      fixture.service.processAuthenticatedEvent(input),
    ).resolves.toMatchObject({ disposition: "quarantined" });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: "subs_race",
      providerStatus: "ACTIVE",
    });
  });

  it("quarantines instead of replacing an existing providerSubscriptionId", async () => {
    const fixture = makeFixture();
    Object.assign(
      fixture.prisma.state.subscriptions.get("subscription-current")!,
      {
        externalId: "local_race",
        providerSubscriptionId: "subs_existing",
        providerCheckoutId: "bill_race",
      },
    );

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedProvisioningRace(),
      payloadHash: HASH_A,
    });

    expect(result).toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerSubscriptionId: "subs_existing",
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
  });

  it("does not use customer as a fallback and quarantines an externalId mismatch", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerSubscriptionId = null;
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerCheckoutId = null;

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedProvisioningRace("local_other"),
      payloadHash: HASH_A,
    });

    expect(result).toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_NOT_FOUND",
      subscriptionId: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
  });

  it("quarantines cancelledAt earlier than local subscription creation", async () => {
    const fixture = makeFixture();
    const subscription = fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!;
    subscription.createdAt = new Date("2024-03-01T00:00:00.000Z");

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
      subscriptionId: "subscription-current",
    });
    expect(subscription).toMatchObject({
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: null,
      purgeAfter: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("uses receipt time when checkout dates predate local creation", async () => {
    const fixture = makeFixture();
    const subscription = fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!;
    subscription.providerCheckoutId = "bill_risk";
    subscription.createdAt = new Date("2024-02-29T00:00:00.000Z");

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRisk("checkout.refunded"),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      familyRevoked: true,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ cancelledAt: NOW });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: NOW,
      purgeAfter: new Date("2025-02-28T12:30:00.000Z"),
    });
  });

  it.each([
    [
      "cancelledAt",
      () => {
        const future = new Date(NOW.getTime() + 5 * 60_000 + 1);
        return {
          ...normalizedCancellation(),
          providerUpdatedAt: future,
          cancelledAt: future,
          occurredAt: future,
        };
      },
    ],
    [
      "checkout.updatedAt",
      () => ({
        ...normalizedRisk("checkout.refunded"),
        providerUpdatedAt: new Date(NOW.getTime() + 5 * 60_000 + 1),
      }),
    ],
  ] as const)(
    "rejects %s beyond clock skew tolerance",
    async (_kind, eventFactory) => {
      const fixture = makeFixture();

      await expectApplicationError(
        fixture.service.processAuthenticatedEvent({
          event: eventFactory(),
          payloadHash: HASH_A,
        }),
        "INVALID_NORMALIZED_EVENT",
        false,
      );
      expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
      expect(fixture.prisma.state.events).toHaveLength(0);
    },
  );

  it("uses the authoritative cancellation timestamp when delivery is delayed", async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: "subscription-current",
      familyRevoked: true,
    });

    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: CANCELLATION_OCCURRED_AT,
      cancelledDueTo: "max_payment_retries_exceeded",
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      currentSubscriptionId: "subscription-current",
      pendingPaymentExpiresAt: null,
      cancelledAt: CANCELLATION_OCCURRED_AT,
      purgeAfter: new Date("2025-02-28T18:00:00.000Z"),
    });
    expect(singleEvent(fixture.prisma)).toMatchObject({
      signatureValid: true,
      processingStatus: WebhookProcessingStatus.processed,
      subscriptionId: "subscription-current",
      familyId: "family-1",
      processedAt: NOW,
    });
  });

  it.each(["checkout.refunded", "checkout.disputed"] as const)(
    "revokes a subscription checkout whose %s payload still reports PAID",
    async (eventType) => {
      const fixture = makeFixture();
      fixture.prisma.state.subscriptions.get(
        "subscription-current",
      )!.providerCheckoutId = "bill_risk";
      fixture.prisma.seedPayment({
        providerPaymentId: null,
        providerCheckoutId: "bill_risk",
      });

      const result = await fixture.service.processAuthenticatedEvent({
        event: normalizedRisk(eventType),
        payloadHash: HASH_A,
      });

      expect(result).toMatchObject({
        disposition: "processed",
        familyRevoked: true,
      });
      expect(
        fixture.prisma.state.subscriptions.get("subscription-current"),
      ).toMatchObject({
        providerStatus: "ACTIVE",
        lastProviderEvent: eventType,
        cancelledAt: NOW,
        cancelledDueTo:
          eventType === "checkout.refunded"
            ? "provider_checkout_refunded"
            : "provider_checkout_disputed",
      });
      expect(fixture.prisma.state.payments.get("payment-1")).toMatchObject({
        providerStatus:
          eventType === "checkout.refunded" ? "REFUNDED" : "DISPUTED",
        providerUpdatedAt: new Date(UPDATED_AT),
      });
      expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
        cancelledAt: NOW,
        purgeAfter: new Date("2025-02-28T12:30:00.000Z"),
      });
      expect(fixture.prisma.calls.paymentUpdates).toBe(1);
    },
  );

  it.each([
    [
      "new dispute then stale refund",
      "checkout.disputed",
      "2024-02-28T12:00:00.000Z",
      "checkout.refunded",
      "2024-02-27T12:00:00.000Z",
      1,
    ],
    [
      "refund then newer dispute",
      "checkout.refunded",
      "2024-02-27T12:00:00.000Z",
      "checkout.disputed",
      "2024-02-28T12:00:00.000Z",
      2,
    ],
    [
      "refund then equal-time dispute",
      "checkout.refunded",
      "2024-02-28T12:00:00.000Z",
      "checkout.disputed",
      "2024-02-28T12:00:00.000Z",
      2,
    ],
    [
      "dispute then equal-time refund",
      "checkout.disputed",
      "2024-02-28T12:00:00.000Z",
      "checkout.refunded",
      "2024-02-28T12:00:00.000Z",
      1,
    ],
  ] as const)(
    "keeps payment risk monotonic: %s",
    async (
      _label,
      firstType,
      firstUpdatedAt,
      secondType,
      secondUpdatedAt,
      expectedUpdates,
    ) => {
      const fixture = makeFixture();
      fixture.prisma.state.subscriptions.get(
        "subscription-current",
      )!.providerCheckoutId = "bill_risk";
      fixture.prisma.seedPayment({
        providerPaymentId: null,
        providerCheckoutId: "bill_risk",
      });

      await expect(
        fixture.service.processAuthenticatedEvent({
          event: normalizedRisk(
            firstType,
            "bill_risk",
            undefined,
            firstUpdatedAt,
          ),
          payloadHash: HASH_A,
        }),
      ).resolves.toMatchObject({ disposition: "processed" });
      await expect(
        fixture.service.processAuthenticatedEvent({
          event: normalizedRisk(
            secondType,
            "bill_risk",
            undefined,
            secondUpdatedAt,
          ),
          payloadHash: HASH_B,
        }),
      ).resolves.toMatchObject({ disposition: "processed" });

      expect(fixture.prisma.state.payments.get("payment-1")).toMatchObject({
        providerStatus: "DISPUTED",
        providerUpdatedAt: new Date("2024-02-28T12:00:00.000Z"),
      });
      expect(
        fixture.prisma.state.subscriptions.get("subscription-current"),
      ).toMatchObject({ cancelledAt: NOW });
      expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
        cancelledAt: NOW,
        purgeAfter: new Date("2025-02-28T12:30:00.000Z"),
      });
      expect(fixture.prisma.calls.paymentUpdates).toBe(expectedUpdates);
      expect([...fixture.prisma.state.events.values()]).toEqual([
        expect.objectContaining({
          processingStatus: WebhookProcessingStatus.processed,
        }),
        expect.objectContaining({
          processingStatus: WebhookProcessingStatus.processed,
        }),
      ]);
    },
  );

  it("rolls back instead of treating a lost payment CAS as stale", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerCheckoutId = "bill_risk";
    fixture.prisma.seedPayment({
      providerPaymentId: null,
      providerCheckoutId: "bill_risk",
    });
    fixture.prisma.failNextPaymentUpdate = true;

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedRisk("checkout.disputed"),
        payloadHash: HASH_A,
      }),
    ).rejects.toThrow(
      "Subscription payment changed during webhook revocation.",
    );
    expect(fixture.prisma.state.events).toHaveLength(0);
    expect(fixture.prisma.state.payments.get("payment-1")).toMatchObject({
      providerStatus: "PAID",
      providerUpdatedAt: new Date(CREATED_AT),
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({ providerStatus: "ACTIVE", cancelledAt: null });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: null,
      purgeAfter: null,
    });
  });

  it("só confirma provider cancelado após subscription.cancelled posterior ao risco", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerCheckoutId = "bill_risk";
    await fixture.service.processAuthenticatedEvent({
      event: normalizedRisk("checkout.refunded"),
      payloadHash: HASH_A,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation("subs_golden", "log_cancel_after_refund"),
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      familyRevoked: false,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: NOW,
      cancelledDueTo: "max_payment_retries_exceeded",
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: NOW,
      purgeAfter: new Date("2025-02-28T12:30:00.000Z"),
    });
    expect(fixture.prisma.calls.familyUpdates).toBe(1);
  });

  it("never changes Family when the correlated event belongs to an old subscription", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get("subscription-current")!.id =
      "subscription-old";
    const old = fixture.prisma.state.subscriptions.get("subscription-current")!;
    fixture.prisma.state.subscriptions.delete("subscription-current");
    fixture.prisma.state.subscriptions.set(old.id, old);
    fixture.prisma.seedSubscription({
      id: "subscription-new",
      providerSubscriptionId: "subs_new",
      providerCheckoutId: "bill_new",
    });
    fixture.prisma.state.families.get("family-1")!.currentSubscriptionId =
      "subscription-new";
    const familyBefore = structuredClone(
      fixture.prisma.state.families.get("family-1"),
    );

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: "subscription-old",
      familyRevoked: false,
    });

    expect(
      fixture.prisma.state.subscriptions.get("subscription-old"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-new"),
    ).toMatchObject({
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });
    expect(fixture.prisma.state.families.get("family-1")).toEqual(familyBefore);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("returns duplicate for concurrent logical deliveries and applies effects once", async () => {
    const fixture = makeFixture();
    const input = {
      event: normalizedCancellation(),
      payloadHash: HASH_A,
    };

    const results = await Promise.all([
      fixture.service.processAuthenticatedEvent(input),
      fixture.service.processAuthenticatedEvent(input),
    ]);

    expect(results.map((result) => result.disposition).sort()).toEqual([
      "duplicate",
      "processed",
    ]);
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(fixture.prisma.calls.eventCreates).toBe(1);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
    expect(fixture.prisma.calls.familyUpdates).toBe(1);
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  it.each([WebhookProcessingStatus.received, WebhookProcessingStatus.failed])(
    "retoma evento legado %s em vez de reconhecê-lo sem efeitos",
    async (status) => {
      const fixture = makeFixture();
      fixture.prisma.state.events.set(eventKey("abacatepay", "log_cancelled"), {
        id: `legacy-${status}`,
        provider: "abacatepay",
        providerEventId: "log_cancelled",
        payloadHash: HASH_A,
        processingStatus: status,
        errorCode: null,
        attempts: 1,
      });

      await expect(
        fixture.service.processAuthenticatedEvent({
          event: normalizedCancellation(),
          payloadHash: HASH_A,
        }),
      ).resolves.toMatchObject({
        disposition: "processed",
        eventRecordId: `legacy-${status}`,
      });
      expect(singleEvent(fixture.prisma)).toMatchObject({
        processingStatus: WebhookProcessingStatus.processed,
        attempts: 2,
      });
      expect(fixture.prisma.calls.eventCreates).toBe(0);
      expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
    },
  );

  it("treats a legacy ignored event as a terminal duplicate", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.events.set(eventKey("abacatepay", "log_cancelled"), {
      id: "legacy-ignored",
      provider: "abacatepay",
      providerEventId: "log_cancelled",
      payloadHash: HASH_A,
      processingStatus: WebhookProcessingStatus.ignored,
      errorCode: "LEGACY_EVENT_IGNORED",
      attempts: 1,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toEqual({
      disposition: "duplicate",
      eventRecordId: "legacy-ignored",
      originalStatus: WebhookProcessingStatus.ignored,
    });
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(singleEvent(fixture.prisma)).toMatchObject({
      processingStatus: WebhookProcessingStatus.ignored,
      errorCode: "LEGACY_EVENT_IGNORED",
      attempts: 1,
    });
    expect(fixture.prisma.calls.eventCreates).toBe(0);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("does not resurrect a terminal subscription when a later positive delivery arrives", async () => {
    const fixture = makeFixture();
    await fixture.service.processAuthenticatedEvent({
      event: normalizedCancellation(),
      payloadHash: HASH_A,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedSuccess("subscription.renewed", "log_after_terminal"),
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({ disposition: "quarantined" });

    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
  });

  it("does not move an existing cancellation boundary backwards", async () => {
    const fixture = makeFixture();
    fixture.prisma.state.subscriptions.get(
      "subscription-current",
    )!.providerCheckoutId = "bill_risk";
    await fixture.service.processAuthenticatedEvent({
      event: normalizedCancellation(),
      payloadHash: HASH_A,
    });

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedRisk("checkout.refunded"),
      payloadHash: HASH_B,
    });

    expect(result).toMatchObject({
      disposition: "processed",
      familyRevoked: false,
    });
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: CANCELLATION_OCCURRED_AT,
      cancelledDueTo: "max_payment_retries_exceeded",
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: CANCELLATION_OCCURRED_AT,
      purgeAfter: new Date("2025-02-28T18:00:00.000Z"),
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
    expect(fixture.prisma.calls.familyUpdates).toBe(1);
  });

  it("retries serialization conflicts and commits exactly one final state", async () => {
    const fixture = makeFixture();
    fixture.prisma.serializationFailures = 2;

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({ disposition: "processed" });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
  });

  it("retries SQLSTATE 40001 surfaced by a raw query as P2010", async () => {
    const fixture = makeFixture();
    fixture.prisma.$transaction
      .mockRejectedValueOnce(rawQueryError("40001"))
      .mockRejectedValueOnce(rawQueryError("40001"));

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({ disposition: "processed" });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
  });

  it("does not retry a non-serialization P2010 raw query error", async () => {
    const fixture = makeFixture();
    const error = rawQueryError("23505");
    fixture.prisma.$transaction.mockRejectedValueOnce(error);

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).rejects.toBe(error);
    expect(fixture.prisma.$transaction).toHaveBeenCalledOnce();
    expect(fixture.prisma.state.events).toHaveLength(0);
  });

  it("raises an incident conflict for the same provider event ID with another hash", async () => {
    const fixture = makeFixture();
    const event = normalizedCancellation();
    await fixture.service.processAuthenticatedEvent({
      event,
      payloadHash: HASH_A,
    });

    await expectApplicationError(
      fixture.service.processAuthenticatedEvent({ event, payloadHash: HASH_B }),
      "IDEMPOTENCY_CONFLICT",
      true,
    );
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
  });

  it("handles a database P2002 race only when the canonical event row exists", async () => {
    const p2002 = prismaError("P2002");
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(p2002),
      paymentWebhookEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "event-winner",
          payloadHash: HASH_A,
          processingStatus: WebhookProcessingStatus.processed,
        }),
      },
    };
    const service = new AbacatePayWebhookApplicationService(
      prisma as unknown as PrismaService,
      new ConfigService({ RETENTION_CANCELLED_MONTHS: 12 }),
      () => NOW,
    );

    await expect(
      service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toEqual({
      disposition: "duplicate",
      eventRecordId: "event-winner",
      originalStatus: WebhookProcessingStatus.processed,
    });
  });

  it("rethrows P2002 from another unique key when no matching event row exists", async () => {
    const p2002 = prismaError("P2002");
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(p2002),
      paymentWebhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const service = new AbacatePayWebhookApplicationService(
      prisma as unknown as PrismaService,
      new ConfigService({ RETENTION_CANCELLED_MONTHS: 12 }),
      () => NOW,
    );

    await expect(
      service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).rejects.toBe(p2002);
  });

  it("quarantines cross-subscription identifier disagreement without revocation", async () => {
    const fixture = makeFixture();
    fixture.prisma.seedSubscription({
      id: "subscription-other",
      familyId: "family-2",
      providerSubscriptionId: "subs_other",
      providerCheckoutId: "bill_other",
    });
    fixture.prisma.seedPayment({
      id: "payment-other",
      subscriptionId: "subscription-other",
      familyId: "family-2",
      providerPaymentId: "char_golden",
      providerCheckoutId: "bill_other",
    });

    const result = await fixture.service.processAuthenticatedEvent({
      event: normalizedFullCancellation(),
      payloadHash: HASH_A,
    });

    expect(result).toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_MISMATCH",
      subscriptionId: null,
    });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(0);
    expect(fixture.prisma.calls.familyUpdates).toBe(0);
  });

  it("rolls back event, subscription and Family when finalization fails, then retries cleanly", async () => {
    const fixture = makeFixture();
    fixture.prisma.failNextEventFinalization = true;

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).rejects.toThrow("simulated finalization failure");

    expect(fixture.prisma.state.events).toHaveLength(0);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "ACTIVE",
      cancelledAt: null,
    });
    expect(fixture.prisma.state.families.get("family-1")).toMatchObject({
      cancelledAt: null,
      purgeAfter: null,
    });

    await expect(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({ disposition: "processed" });
    expect(fixture.prisma.state.events).toHaveLength(1);
    expect(
      fixture.prisma.state.subscriptions.get("subscription-current"),
    ).toMatchObject({
      providerStatus: "CANCELLED",
      cancelledAt: CANCELLATION_OCCURRED_AT,
    });
  });

  it("persists only a minimal allowlist and no raw, customer or provider reason", async () => {
    const fixture = makeFixture();

    await fixture.service.processAuthenticatedEvent({
      event: normalizedCancellation(),
      payloadHash: HASH_A,
    });

    const record = singleEvent(fixture.prisma);
    expect(record.sanitizedPayload).toEqual({
      contract: "abacatepay-v2-normalized",
      kind: "subscription_cancelled",
      subscriptionStatus: "CANCELLED",
      paymentStatus: null,
      checkoutStatus: null,
    });
    expect(JSON.stringify(record.sanitizedPayload)).not.toMatch(
      /cust_|raw|signature|max_payment_retries_exceeded/i,
    );
    expect(record.providerFailureReason).toBeNull();
  });

  it("rejects an invalid hash before touching the database", async () => {
    const fixture = makeFixture();

    await expectApplicationError(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: "not-a-sha256",
      }),
      "INVALID_PAYLOAD_HASH",
      false,
    );
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.prisma.state.events).toHaveLength(0);
  });

  it("rejects a checkout revocation without an authoritative timestamp", async () => {
    const fixture = makeFixture();
    const event = {
      ...normalizedRisk("checkout.refunded"),
      occurredAt: null,
      providerUpdatedAt: null,
    };

    await expectApplicationError(
      fixture.service.processAuthenticatedEvent({ event, payloadHash: HASH_A }),
      "INVALID_NORMALIZED_EVENT",
      false,
    );
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.prisma.state.events).toHaveLength(0);
  });

  it("rejects invalid retention configuration before persisting a revocation", async () => {
    const fixture = makeFixture({ RETENTION_CANCELLED_MONTHS: 0 });

    await expectApplicationError(
      fixture.service.processAuthenticatedEvent({
        event: normalizedCancellation(),
        payloadHash: HASH_A,
      }),
      "RETENTION_CONFIGURATION_INVALID",
      false,
    );
    expect(fixture.prisma.$transaction).toHaveBeenCalledOnce();
    expect(fixture.prisma.state.events).toHaveLength(0);
  });

  it("still acknowledges a duplicate if retention config becomes invalid later", async () => {
    const fixture = makeFixture();
    const input = {
      event: normalizedCancellation(),
      payloadHash: HASH_A,
    };
    await fixture.service.processAuthenticatedEvent(input);
    const misconfiguredService = new AbacatePayWebhookApplicationService(
      fixture.prisma.asPrisma(),
      new ConfigService({ RETENTION_CANCELLED_MONTHS: 0 }),
      () => NOW,
    );

    await expect(
      misconfiguredService.processAuthenticatedEvent(input),
    ).resolves.toMatchObject({ disposition: "duplicate" });
    expect(fixture.prisma.calls.subscriptionUpdates).toBe(1);
  });
});

function makeFixture(config: Record<string, unknown> = {}) {
  const prisma = new MemoryWebhookPrisma();
  prisma.seedFamily();
  prisma.seedSubscription();
  const service = new AbacatePayWebhookApplicationService(
    prisma.asPrisma(),
    new ConfigService({ RETENTION_CANCELLED_MONTHS: 12, ...config }),
    () => NOW,
  );
  return { prisma, service };
}

function normalizedSuccess(
  event: "subscription.completed" | "subscription.renewed",
  id = "log_success",
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(id, event, {
      subscription: subscriptionPayload(),
      customer: { id: "cust_golden", email: "never-persist@example.test" },
      payment: paidPaymentPayload(),
      checkout: paidCheckoutPayload(),
    }),
    true,
  );
}

function normalizedPaymentFailed() {
  return parseAndNormalizeAbacatePayWebhook(
    envelope("log_failed", "subscription.payment_failed", {
      subscription: subscriptionPayload({
        retryPolicy: { maxRetry: 3, retryEvery: 2 },
      }),
      installmentId: "intl_golden",
      installmentNumber: 1,
      retryNumber: 0,
    }),
    true,
  );
}

function normalizedPaymentFailedWithReason() {
  return parseAndNormalizeAbacatePayWebhook(
    envelope("log_failed_reason", "subscription.payment_failed", {
      subscription: subscriptionPayload(),
      payment: {
        id: "char_failed",
        status: "FAILED",
        amount: 2_990,
        paidAmount: 0,
        methods: ["CARD"],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      reason: "card_declined",
    }),
    true,
  );
}

function normalizedProvisioningRace(
  externalId = "local_race",
  eventId = "log_provisioning_race",
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(eventId, "subscription.completed", {
      subscription: subscriptionPayload({ id: "subs_race" }),
      customer: { id: "cust_golden" },
      payment: paidPaymentPayload({ id: "char_race" }),
      checkout: paidCheckoutPayload({
        id: "bill_race",
        externalId,
        url: "https://app.abacatepay.com/pay/bill_race",
      }),
    }),
    true,
  );
}

function normalizedRenewalWithNewCheckout() {
  return parseAndNormalizeAbacatePayWebhook(
    envelope("log_renew_new_checkout", "subscription.renewed", {
      subscription: subscriptionPayload(),
      customer: { id: "cust_golden" },
      payment: paidPaymentPayload({ id: "char_renew" }),
      checkout: paidCheckoutPayload({
        id: "bill_renew",
        externalId: null,
        url: "https://app.abacatepay.com/pay/bill_renew",
      }),
    }),
    true,
  );
}

function normalizedCancellation(
  providerSubscriptionId = "subs_golden",
  eventId = "log_cancelled",
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(eventId, "subscription.cancelled", {
      subscription: subscriptionPayload({
        id: providerSubscriptionId,
        status: "CANCELLED",
        updatedAt: "2024-02-28T18:00:00.000Z",
        canceledAt: "2024-02-28T18:00:00.000Z",
        cancelPolicy: "NOW",
        cancelledDueTo: "max_payment_retries_exceeded",
      }),
      customer: { id: "cust_golden", email: "never-persist@example.test" },
    }),
    true,
  );
}

function normalizedFullCancellation() {
  return parseAndNormalizeAbacatePayWebhook(
    envelope("log_cancelled_full", "subscription.cancelled", {
      subscription: subscriptionPayload({
        status: "CANCELLED",
        updatedAt: "2024-02-28T18:00:00.000Z",
        canceledAt: "2024-02-28T18:00:00.000Z",
        cancelPolicy: "NOW",
        cancelledDueTo: null,
      }),
      customer: { id: "cust_golden" },
      payment: paidPaymentPayload(),
      checkout: paidCheckoutPayload(),
    }),
    true,
  );
}

function normalizedRisk(
  event: "checkout.refunded" | "checkout.disputed",
  checkoutId = "bill_risk",
  externalId?: string,
  providerUpdatedAt = UPDATED_AT,
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(`log_${event.replace(".", "_")}`, event, {
      checkout: {
        id: checkoutId,
        ...(externalId === undefined ? {} : { externalId }),
        amount: 2_990,
        paidAmount: 2_990,
        frequency: "SUBSCRIPTION",
        status: "PAID",
        methods: ["CARD"],
        customerId: "cust_golden",
        items: [{ id: "prod_monthly", quantity: 1 }],
        createdAt: CREATED_AT,
        updatedAt: providerUpdatedAt,
      },
      customer: { id: "cust_golden", taxId: "never-persist" },
      reason: "requested_by_customer",
    }),
    true,
  );
}

function envelope(id: string, event: string, data: Record<string, unknown>) {
  return { id, event, apiVersion: 2, devMode: true, data };
}

function subscriptionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "subs_golden",
    amount: 2_990,
    currency: "BRL",
    method: "CARD",
    status: "ACTIVE",
    frequency: "MONTHLY",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    canceledAt: null,
    cancelPolicy: null,
    cancelledDueTo: null,
    ...overrides,
  };
}

function paidPaymentPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "char_golden",
    amount: 2_990,
    paidAmount: 2_990,
    status: "PAID",
    methods: ["CARD"],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function paidCheckoutPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill_golden",
    externalId: null,
    url: "https://app.abacatepay.com/pay/bill_golden",
    amount: 2_990,
    paidAmount: 2_990,
    frequency: "SUBSCRIPTION",
    items: [{ id: "prod_monthly", quantity: 1 }],
    status: "PAID",
    methods: ["CARD"],
    customerId: "cust_golden",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function findEvent(state: MemoryState, args: unknown) {
  const where = (
    args as {
      where: {
        provider_providerEventId: {
          provider: string;
          providerEventId: string;
        };
      };
    }
  ).where.provider_providerEventId;
  return (
    state.events.get(eventKey(where.provider, where.providerEventId)) ?? null
  );
}

function findSubscription(state: MemoryState, args: unknown) {
  const where = (
    args as {
      where: {
        provider_providerSubscriptionId?: {
          provider: string;
          providerSubscriptionId: string;
        };
        provider_providerCheckoutId?: {
          provider: string;
          providerCheckoutId: string;
        };
        externalId?: string;
      };
    }
  ).where;
  return (
    [...state.subscriptions.values()].find((subscription) => {
      if (where.provider_providerSubscriptionId) {
        return (
          subscription.provider ===
            where.provider_providerSubscriptionId.provider &&
          subscription.providerSubscriptionId ===
            where.provider_providerSubscriptionId.providerSubscriptionId
        );
      }
      if (where.provider_providerCheckoutId) {
        return (
          subscription.provider ===
            where.provider_providerCheckoutId.provider &&
          subscription.providerCheckoutId ===
            where.provider_providerCheckoutId.providerCheckoutId
        );
      }
      if (where.externalId !== undefined) {
        return subscription.externalId === where.externalId;
      }
      return false;
    }) ?? null
  );
}

function findPayment(state: MemoryState, args: unknown) {
  const where = (
    args as {
      where: { providerPaymentId?: string; providerCheckoutId?: string };
    }
  ).where;
  const payment = [...state.payments.values()].find(
    (candidate) =>
      (where.providerPaymentId !== undefined &&
        candidate.providerPaymentId === where.providerPaymentId) ||
      (where.providerCheckoutId !== undefined &&
        candidate.providerCheckoutId === where.providerCheckoutId),
  );
  if (!payment) return null;
  const subscription = state.subscriptions.get(payment.subscriptionId);
  if (!subscription) throw new Error("broken payment fixture");
  return { ...payment, subscription };
}

function matches(value: object, where: Record<string, unknown>): boolean {
  const record = value as Record<string, unknown>;
  return Object.entries(where).every(
    ([key, expected]) => record[key] === expected,
  );
}

function eventKey(provider: string, eventId: string): string {
  return `${provider}:${eventId}`;
}

function singleEvent(prisma: MemoryWebhookPrisma): MemoryEvent {
  const events = [...prisma.state.events.values()];
  expect(events).toHaveLength(1);
  return events[0]!;
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("simulated prisma error", {
    code,
    clientVersion: "6.1.0",
  });
}

function rawQueryError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("simulated raw query error", {
    code: "P2010",
    clientVersion: "6.1.0",
    meta: { code: sqlState },
  });
}

async function expectApplicationError(
  operation: Promise<unknown>,
  code: string,
  incident: boolean,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected application error");
  } catch (error) {
    expect(error).toBeInstanceOf(AbacatePayWebhookApplicationError);
    expect(error).toMatchObject({ code, incident });
  }
}
