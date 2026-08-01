import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  CheckoutProvisioningStatus,
  PrismaClient,
  SubscriptionCycle,
  WebhookProcessingStatus,
} from "@prisma/client";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AbacatePayWebhookApplicationError,
  AbacatePayWebhookApplicationService,
} from "../../src/modules/payments/webhooks/abacatepay-webhook-application.service";
import { AbacatePayWebhookController } from "../../src/modules/payments/webhooks/abacatepay-webhook.controller";
import { parseAndNormalizeAbacatePayWebhook } from "../../src/modules/payments/webhooks/abacatepay-webhook";
import type { PrismaService } from "../../src/prisma/prisma.service";
import { configureHttpBodyParsers } from "../../src/shared/http-body-parsers";
import { webhookSafeNestApplicationOptions } from "../../src/shared/nest-application-options";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const DELAYED_CANCELLATION_AT = new Date("2026-07-31T12:00:00.000Z");
const TENANT_CREATED_AT = new Date("2026-06-01T12:00:00.000Z");
const SUBSCRIPTION_CREATED_AT = new Date("2026-07-01T12:00:00.000Z");
const AMOUNT_CENTS = 2_990;
const PRODUCT_ID = "prod_webhook_integration";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HTTP_WEBHOOK_SECRET = "integration-webhook-secret-at-least-32-characters";

describe("webhook AbacatePay com PostgreSQL real", () => {
  let prisma: PrismaClient;
  let service: AbacatePayWebhookApplicationService;
  let httpApp: INestApplication;
  let httpEndpoint: string;

  beforeAll(async () => {
    if (process.env.RUN_TENANT_INTEGRATION !== "true") {
      throw new Error(
        "Execute este arquivo somente por npm run test:integration",
      );
    }
    prisma = new PrismaClient();
    const config = new ConfigService({
      NODE_ENV: "test",
      RETENTION_CANCELLED_MONTHS: 12,
      ABACATEPAY_WEBHOOK_ENABLED: true,
      ABACATEPAY_WEBHOOK_HMAC_MODE: "registered_secret",
      ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: true,
      ABACATEPAY_DEV_WEBHOOK_SECRET: HTTP_WEBHOOK_SECRET,
    });
    service = new AbacatePayWebhookApplicationService(
      prisma as unknown as PrismaService,
      config,
      () => NOW,
    );
    const testingModule = await Test.createTestingModule({
      controllers: [AbacatePayWebhookController],
      providers: [
        { provide: ConfigService, useValue: config },
        {
          provide: AbacatePayWebhookApplicationService,
          useValue: service,
        },
      ],
    }).compile();
    httpApp = testingModule.createNestApplication(
      webhookSafeNestApplicationOptions,
    );
    configureHttpBodyParsers(httpApp as NestExpressApplication);
    await httpApp.listen(0, "127.0.0.1");
    const address = httpApp.getHttpServer().address() as AddressInfo;
    httpEndpoint = `http://127.0.0.1:${address.port}/payments/webhooks/abacatepay`;
  });

  afterAll(async () => {
    await httpApp?.close();
    await prisma?.$disconnect();
  });

  it("processa HTTP raw autenticado e persiste o evento risk canônico", async () => {
    const providerCheckoutId = providerId("bill");
    const providerEventId = providerId("log");
    const tenant = await createTenant(prisma, "Webhook HTTP real", {
      providerSubscriptionId: providerId("subs"),
      providerCheckoutId,
      providerCheckoutUrl: `https://app.abacatepay.com/pay/${providerCheckoutId}`,
      providerCheckoutStatus: "PAID",
      providerStatus: "ACTIVE",
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: NOW,
    });
    const rawBody = JSON.stringify(
      riskEnvelope("checkout.disputed", providerCheckoutId, providerEventId),
    );

    const response = await postHttpWebhook(
      httpEndpoint,
      rawBody,
      httpSignature(rawBody),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      disposition: "processed",
    });
    await expect(
      prisma.paymentWebhookEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: "abacatepay",
            providerEventId,
          },
        },
      }),
    ).resolves.toMatchObject({
      eventType: "checkout.disputed",
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      signatureValid: true,
      processingStatus: WebhookProcessingStatus.processed,
      subscriptionId: tenant.subscriptionId,
      familyId: tenant.familyId,
      providerCheckoutId,
      errorCode: null,
    });
  });

  it("rejeita HMAC inválido no HTTP sem persistir PaymentWebhookEvent", async () => {
    const providerEventId = providerId("log");
    const rawBody = JSON.stringify(
      riskEnvelope("checkout.refunded", providerId("bill"), providerEventId),
    );

    const response = await postHttpWebhook(
      httpEndpoint,
      rawBody,
      httpSignature(`${rawBody} `),
    );

    expect(response.status).toBe(401);
    await expect(
      prisma.paymentWebhookEvent.count({ where: { providerEventId } }),
    ).resolves.toBe(0);
  });

  it("vincula identidade sem entitlement, deduplica e revoga uma única vez sob concorrência", async () => {
    const providerCheckoutId = providerId("bill");
    const tenant = await createTenant(prisma, "Webhook concorrente", {
      providerCheckoutId,
      providerCheckoutUrl: `https://app.abacatepay.com/pay/${providerCheckoutId}`,
      providerCheckoutStatus: "PENDING",
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: NOW,
    });
    const providerSubscriptionId = providerId("subs");
    const completed = normalizedCompleted(
      tenant.externalId,
      providerSubscriptionId,
      providerCheckoutId,
      providerId("char"),
      providerId("log"),
    );

    await expect(
      service.processAuthenticatedEvent({
        event: completed,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: tenant.subscriptionId,
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: tenant.subscriptionId },
      }),
    ).resolves.toMatchObject({
      providerSubscriptionId,
      providerStatus: null,
      lastProviderEvent: null,
      accessPaidThrough: null,
      lastSuccessfulPaymentAt: null,
      entitlementContractVersion: null,
    });

    await expect(
      service.processAuthenticatedEvent({
        event: completed,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({ disposition: "duplicate" });
    await expectApplicationCode(
      service.processAuthenticatedEvent({
        event: completed,
        payloadHash: HASH_B,
      }),
      "IDEMPOTENCY_CONFLICT",
    );

    const cancellation = normalizedCancellation(
      providerSubscriptionId,
      providerId("log"),
      DELAYED_CANCELLATION_AT,
    );
    const results = await Promise.all([
      service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
      service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
    ]);
    expect(results.map((result) => result.disposition).sort()).toEqual([
      "duplicate",
      "processed",
    ]);
    await expect(
      prisma.paymentWebhookEvent.count({
        where: { providerEventId: cancellation.providerEventId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: tenant.subscriptionId },
      }),
    ).resolves.toMatchObject({
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: DELAYED_CANCELLATION_AT,
      cancelledDueTo: "max_payment_retries_exceeded",
    });
    await expect(
      prisma.family.findUniqueOrThrow({ where: { id: tenant.familyId } }),
    ).resolves.toMatchObject({
      currentSubscriptionId: tenant.subscriptionId,
      pendingPaymentExpiresAt: null,
      cancelledAt: DELAYED_CANCELLATION_AT,
      purgeAfter: new Date("2027-07-31T12:00:00.000Z"),
    });
  });

  it.each([WebhookProcessingStatus.received, WebhookProcessingStatus.failed])(
    "retoma linha %s sem duplicar o histórico",
    async (status) => {
      const providerSubscriptionId = providerId("subs");
      const tenant = await createTenant(prisma, `Webhook recover ${status}`, {
        providerSubscriptionId,
        providerStatus: "ACTIVE",
      });
      const cancellation = normalizedCancellation(
        providerSubscriptionId,
        providerId("log"),
      );
      const eventId = randomUUID();
      await prisma.paymentWebhookEvent.create({
        data: {
          id: eventId,
          provider: "abacatepay",
          providerEventId: cancellation.providerEventId,
          eventType: cancellation.eventType,
          apiVersion: 2,
          devMode: true,
          payloadHash: HASH_A,
          signatureValid: true,
          processingStatus: status,
          attempts: 1,
          providerSubscriptionId,
          receivedAt: new Date(NOW.getTime() - 60_000),
        },
      });

      await expect(
        service.processAuthenticatedEvent({
          event: cancellation,
          payloadHash: HASH_A,
        }),
      ).resolves.toMatchObject({
        disposition: "processed",
        eventRecordId: eventId,
      });
      await expect(
        prisma.paymentWebhookEvent.findUniqueOrThrow({
          where: { id: eventId },
        }),
      ).resolves.toMatchObject({
        processingStatus: WebhookProcessingStatus.processed,
        attempts: 2,
        subscriptionId: tenant.subscriptionId,
      });
    },
  );

  it.each(["checkout.refunded", "checkout.disputed"] as const)(
    "%s revoga o tenant e atualiza o pagamento correlacionado na mesma transação",
    async (eventType) => {
      const providerSubscriptionId = providerId("subs");
      const providerCheckoutId = providerId("bill");
      const tenant = await createTenant(prisma, `Webhook ${eventType}`, {
        providerSubscriptionId,
        providerCheckoutId,
        providerCheckoutUrl: `https://app.abacatepay.com/pay/${providerCheckoutId}`,
        providerCheckoutStatus: "PAID",
        providerStatus: "ACTIVE",
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
        checkoutCreationAllowed: false,
        checkoutReadyAt: NOW,
      });
      const payment = await prisma.subscriptionPayment.create({
        data: {
          id: randomUUID(),
          subscriptionId: tenant.subscriptionId,
          familyId: tenant.familyId,
          providerPaymentId: providerId("char"),
          providerCheckoutId,
          providerStatus: "PAID",
          amountCents: AMOUNT_CENTS,
          currency: "BRL",
          paymentMethod: "CARD",
        },
      });
      const event = normalizedRisk(
        eventType,
        providerCheckoutId,
        providerId("log"),
      );

      await expect(
        service.processAuthenticatedEvent({ event, payloadHash: HASH_A }),
      ).resolves.toMatchObject({
        disposition: "processed",
        subscriptionId: tenant.subscriptionId,
        familyRevoked: true,
      });
      await expect(
        prisma.subscriptionPayment.findUniqueOrThrow({
          where: { id: payment.id },
        }),
      ).resolves.toMatchObject({
        providerStatus:
          eventType === "checkout.refunded" ? "REFUNDED" : "DISPUTED",
        providerUpdatedAt: NOW,
      });
      await expect(
        prisma.subscription.findUniqueOrThrow({
          where: { id: tenant.subscriptionId },
        }),
      ).resolves.toMatchObject({
        providerStatus: "ACTIVE",
        lastProviderEvent: eventType,
        cancelledAt: NOW,
      });
      await expect(
        prisma.paymentWebhookEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: "abacatepay",
              providerEventId: event.providerEventId,
            },
          },
        }),
      ).resolves.toMatchObject({
        subscriptionPaymentId: payment.id,
        processingStatus: WebhookProcessingStatus.processed,
      });
    },
  );

  it("reprocessa cancelamento fora de ordem depois do vínculo forte da assinatura", async () => {
    const providerCheckoutId = providerId("bill");
    const providerSubscriptionId = providerId("subs");
    const tenant = await createTenant(
      prisma,
      "Webhook cancelamento fora de ordem",
      {
        providerCheckoutId,
        providerCheckoutUrl: `https://app.abacatepay.com/pay/${providerCheckoutId}`,
        providerCheckoutStatus: "PENDING",
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
        checkoutCreationAllowed: false,
        checkoutReadyAt: NOW,
      },
    );
    const cancellation = normalizedCancellation(
      providerSubscriptionId,
      providerId("log"),
    );

    await expect(
      service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "CORRELATION_NOT_FOUND",
      subscriptionId: null,
    });

    const completed = normalizedCompleted(
      tenant.externalId,
      providerSubscriptionId,
      providerCheckoutId,
      providerId("char"),
      providerId("log"),
    );
    await expect(
      service.processAuthenticatedEvent({
        event: completed,
        payloadHash: HASH_B,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: tenant.subscriptionId,
    });

    await expect(
      service.processAuthenticatedEvent({
        event: cancellation,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: tenant.subscriptionId,
      familyRevoked: true,
    });
    await expect(
      prisma.paymentWebhookEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: "abacatepay",
            providerEventId: cancellation.providerEventId,
          },
        },
      }),
    ).resolves.toMatchObject({
      processingStatus: WebhookProcessingStatus.processed,
      attempts: 2,
      subscriptionId: tenant.subscriptionId,
    });
  });

  it("correlaciona risco do novo checkout pelo evento renewed autenticado", async () => {
    const providerSubscriptionId = providerId("subs");
    const initialCheckoutId = providerId("bill");
    const renewedCheckoutId = providerId("bill");
    const tenant = await createTenant(prisma, "Webhook renovação histórica", {
      providerSubscriptionId,
      providerCheckoutId: initialCheckoutId,
      providerCheckoutUrl: `https://app.abacatepay.com/pay/${initialCheckoutId}`,
      providerCheckoutStatus: "PAID",
      providerStatus: "ACTIVE",
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: NOW,
    });

    const renewed = normalizedRenewed(
      providerSubscriptionId,
      renewedCheckoutId,
      providerId("char"),
      providerId("log"),
    );
    await expect(
      service.processAuthenticatedEvent({
        event: renewed,
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "quarantined",
      code: "ENTITLEMENT_CONTRACT_UNPROVEN",
      subscriptionId: tenant.subscriptionId,
    });
    await expect(
      prisma.paymentWebhookEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: "abacatepay",
            providerEventId: renewed.providerEventId,
          },
        },
      }),
    ).resolves.toMatchObject({
      providerCheckoutId: renewedCheckoutId,
      subscriptionId: tenant.subscriptionId,
      processingStatus: WebhookProcessingStatus.quarantined,
      errorCode: "ENTITLEMENT_CONTRACT_UNPROVEN",
    });

    const risk = normalizedRisk(
      "checkout.refunded",
      renewedCheckoutId,
      providerId("log"),
    );
    await expect(
      service.processAuthenticatedEvent({ event: risk, payloadHash: HASH_B }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: tenant.subscriptionId,
      familyRevoked: true,
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: tenant.subscriptionId },
      }),
    ).resolves.toMatchObject({
      providerCheckoutId: initialCheckoutId,
      providerStatus: "ACTIVE",
      lastProviderEvent: "checkout.refunded",
      cancelledAt: NOW,
    });
    await expect(
      prisma.family.findUniqueOrThrow({ where: { id: tenant.familyId } }),
    ).resolves.toMatchObject({
      cancelledAt: NOW,
      purgeAfter: new Date("2027-08-01T12:00:00.000Z"),
    });
  });

  it("evento terminal de assinatura histórica nunca revoga a assinatura corrente", async () => {
    const oldCheckoutId = providerId("bill");
    const tenant = await createTenant(prisma, "Webhook histórico", {
      providerSubscriptionId: providerId("subs"),
      providerStatus: "ACTIVE",
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      providerCheckoutId: oldCheckoutId,
      providerCheckoutUrl: `https://app.abacatepay.com/pay/${oldCheckoutId}`,
      providerCheckoutStatus: "EXPIRED",
      checkoutReadyAt: new Date(NOW.getTime() - 2_000),
      checkoutClosedAt: new Date(NOW.getTime() - 1_000),
      checkoutCloseReason: "EXPIRED",
    });
    const current = await prisma.subscription.create({
      data: {
        id: randomUUID(),
        familyId: tenant.familyId,
        externalId: `local_${randomUUID()}`,
        providerProductId: PRODUCT_ID,
        amountCents: AMOUNT_CENTS,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
        createdAt: SUBSCRIPTION_CREATED_AT,
      },
    });
    await prisma.family.update({
      where: { id: tenant.familyId },
      data: { currentSubscriptionId: current.id },
    });

    await expect(
      service.processAuthenticatedEvent({
        event: normalizedCancellation(
          tenant.providerSubscriptionId!,
          providerId("log"),
        ),
        payloadHash: HASH_A,
      }),
    ).resolves.toMatchObject({
      disposition: "processed",
      subscriptionId: tenant.subscriptionId,
      familyRevoked: false,
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({ where: { id: current.id } }),
    ).resolves.toMatchObject({ providerStatus: null, cancelledAt: null });
    await expect(
      prisma.family.findUniqueOrThrow({ where: { id: tenant.familyId } }),
    ).resolves.toMatchObject({
      currentSubscriptionId: current.id,
      cancelledAt: null,
      purgeAfter: null,
    });
  });

  it("faz rollback do evento e de todos os efeitos quando o banco rejeita a transição", async () => {
    const providerSubscriptionId = providerId("subs");
    const tenant = await createTenant(prisma, "Webhook rollback", {
      providerSubscriptionId,
      providerStatus: "ACTIVE",
    });
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `block_webhook_${suffix}`;
    const triggerName = `Subscription_webhook_${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."id" = '${tenant.subscriptionId}' AND NEW."cancelledAt" IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'WEBHOOK_FIXTURE_BLOCKED';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE ON "Subscription"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    const event = normalizedCancellation(
      providerSubscriptionId,
      providerId("log"),
    );

    try {
      await expect(
        service.processAuthenticatedEvent({ event, payloadHash: HASH_A }),
      ).rejects.toBeDefined();
      await expect(
        prisma.paymentWebhookEvent.count({
          where: { providerEventId: event.providerEventId },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.subscription.findUniqueOrThrow({
          where: { id: tenant.subscriptionId },
        }),
      ).resolves.toMatchObject({ providerStatus: "ACTIVE", cancelledAt: null });
      await expect(
        prisma.family.findUniqueOrThrow({ where: { id: tenant.familyId } }),
      ).resolves.toMatchObject({ cancelledAt: null, purgeAfter: null });
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "Subscription"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }

    await expect(
      service.processAuthenticatedEvent({ event, payloadHash: HASH_A }),
    ).resolves.toMatchObject({ disposition: "processed" });
  });
});

interface TenantFixture {
  familyId: string;
  subscriptionId: string;
  externalId: string;
  providerSubscriptionId: string | null;
  providerCheckoutId: string | null;
}

async function createTenant(
  prisma: PrismaClient,
  label: string,
  subscriptionPatch: Record<string, unknown> = {},
): Promise<TenantFixture> {
  const suffix = randomUUID();
  const pendingPaymentExpiresAt =
    subscriptionPatch.providerStatus === "ACTIVE"
      ? null
      : new Date(NOW.getTime() + 86_400_000);
  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: {
        id: randomUUID(),
        name: `${label} ${suffix}`,
        createdAt: TENANT_CREATED_AT,
        pendingPaymentExpiresAt,
      },
    });
    const owner = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `webhook-${suffix}@example.test`,
        name: label,
        familyId: family.id,
        emailVerifiedAt: NOW,
      },
    });
    await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: label,
        familyId: family.id,
        userId: owner.id,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: { ownerUserId: owner.id },
    });
    const externalId = `local_${randomUUID()}`;
    const subscription = await tx.subscription.create({
      data: {
        id: randomUUID(),
        familyId: family.id,
        externalId,
        providerProductId: PRODUCT_ID,
        amountCents: AMOUNT_CENTS,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
        createdAt: SUBSCRIPTION_CREATED_AT,
        ...subscriptionPatch,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: { currentSubscriptionId: subscription.id },
    });
    return {
      familyId: family.id,
      subscriptionId: subscription.id,
      externalId,
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCheckoutId: subscription.providerCheckoutId,
    };
  });
}

function normalizedCompleted(
  externalId: string,
  subscriptionId: string,
  checkoutId: string,
  paymentId: string,
  eventId: string,
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(eventId, "subscription.completed", {
      subscription: subscriptionPayload(subscriptionId),
      customer: { id: providerId("cust") },
      payment: {
        id: paymentId,
        amount: AMOUNT_CENTS,
        paidAmount: AMOUNT_CENTS,
        status: "PAID",
        methods: ["CARD"],
        createdAt: "2026-08-01T11:59:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
      checkout: {
        id: checkoutId,
        externalId,
        url: `https://app.abacatepay.com/pay/${checkoutId}`,
        amount: AMOUNT_CENTS,
        paidAmount: AMOUNT_CENTS,
        frequency: "SUBSCRIPTION",
        items: [{ id: PRODUCT_ID, quantity: 1 }],
        status: "PAID",
        methods: ["CARD"],
        createdAt: "2026-08-01T11:59:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
    }),
    true,
  );
}

function normalizedRenewed(
  subscriptionId: string,
  checkoutId: string,
  paymentId: string,
  eventId: string,
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(eventId, "subscription.renewed", {
      subscription: subscriptionPayload(subscriptionId),
      customer: { id: providerId("cust") },
      payment: {
        id: paymentId,
        amount: AMOUNT_CENTS,
        paidAmount: AMOUNT_CENTS,
        status: "PAID",
        methods: ["CARD"],
        createdAt: "2026-08-01T11:59:00.000Z",
        updatedAt: NOW.toISOString(),
      },
      checkout: {
        id: checkoutId,
        externalId: null,
        url: `https://app.abacatepay.com/pay/${checkoutId}`,
        amount: AMOUNT_CENTS,
        paidAmount: AMOUNT_CENTS,
        frequency: "SUBSCRIPTION",
        items: [{ id: PRODUCT_ID, quantity: 1 }],
        status: "PAID",
        methods: ["CARD"],
        createdAt: "2026-08-01T11:59:00.000Z",
        updatedAt: NOW.toISOString(),
      },
    }),
    true,
  );
}

function normalizedCancellation(
  subscriptionId: string,
  eventId: string,
  cancelledAt = NOW,
) {
  return parseAndNormalizeAbacatePayWebhook(
    envelope(eventId, "subscription.cancelled", {
      subscription: subscriptionPayload(subscriptionId, {
        status: "CANCELLED",
        canceledAt: cancelledAt.toISOString(),
        cancelPolicy: "NOW",
        cancelledDueTo: "max_payment_retries_exceeded",
      }),
    }),
    true,
  );
}

function normalizedRisk(
  eventType: "checkout.refunded" | "checkout.disputed",
  checkoutId: string,
  eventId: string,
) {
  return parseAndNormalizeAbacatePayWebhook(
    riskEnvelope(eventType, checkoutId, eventId),
    true,
  );
}

function riskEnvelope(
  eventType: "checkout.refunded" | "checkout.disputed",
  checkoutId: string,
  eventId: string,
) {
  return envelope(eventId, eventType, {
    checkout: {
      id: checkoutId,
      amount: AMOUNT_CENTS,
      paidAmount: AMOUNT_CENTS,
      frequency: "SUBSCRIPTION",
      status: "PAID",
      methods: ["CARD"],
      items: [{ id: PRODUCT_ID, quantity: 1 }],
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: NOW.toISOString(),
    },
    reason: "requested_by_customer",
  });
}

function subscriptionPayload(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    amount: AMOUNT_CENTS,
    currency: "BRL",
    method: "CARD",
    frequency: "MONTHLY",
    status: "ACTIVE",
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: NOW.toISOString(),
    canceledAt: null,
    cancelPolicy: null,
    cancelledDueTo: null,
    ...patch,
  };
}

function envelope(id: string, event: string, data: Record<string, unknown>) {
  return { id, event, apiVersion: 2, devMode: true, data };
}

function providerId(prefix: "bill" | "char" | "cust" | "log" | "subs") {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function expectApplicationCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Esperava ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AbacatePayWebhookApplicationError);
    expect(error).toMatchObject({ code });
  }
}

function httpSignature(rawBody: string): string {
  return createHmac("sha256", HTTP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
}

function postHttpWebhook(
  endpoint: string,
  rawBody: string,
  signature: string,
): Promise<Response> {
  return fetch(
    `${endpoint}?webhookSecret=${encodeURIComponent(HTTP_WEBHOOK_SECRET)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      body: rawBody,
    },
  );
}
