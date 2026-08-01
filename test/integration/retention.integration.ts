import { ConfigService } from "@nestjs/config";
import {
  AccountType,
  CategoryType,
  CheckoutProvisioningStatus,
  LegalAcceptanceSource,
  PrismaClient,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
  TelegramAuthCodeKind,
  TelegramFinancialOperationKind,
  TransactionType,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  PaymentCheckout,
  PaymentProvider,
} from "../../src/modules/payments/payment-provider";
import { PaymentsService } from "../../src/modules/payments/payments.service";
import { TenantRetentionService } from "../../src/modules/retention/tenant-retention.service";
import type { PrismaService } from "../../src/prisma/prisma.service";

interface TenantIds {
  familyId: string;
  userId: string;
  profileId: string;
}

describe("retenção de tenant com PostgreSQL real", () => {
  let prisma: PrismaClient;
  let payments: PaymentsService;
  let service: TenantRetentionService;
  const checkoutResponses = new Map<
    string,
    PaymentCheckout | Error | null
  >();

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== "true") {
      throw new Error(
        "Execute este arquivo somente por npm run test:integration",
      );
    }
    prisma = new PrismaClient();
    const configValues: Record<string, unknown> = {
      NODE_ENV: "test",
      WEB_ORIGIN: "https://financeiro.example.test",
      ABACATEPAY_ENABLED: true,
      ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: "prod_retention_monthly",
      ABACATEPAY_MONTHLY_AMOUNT_CENTS: 2_990,
      PENDING_PAYMENT_TTL_DAYS: 7,
      RETENTION_CANCELLED_MONTHS: 12,
      RETENTION_PURGE_BATCH_SIZE: 20,
      RETENTION_PURGE_LEASE_SECONDS: 900,
      RETENTION_PURGE_MAX_AGE_HOURS: 48,
    };
    const config = {
      get: <T>(key: string) => configValues[key] as T | undefined,
    } as ConfigService;
    const provider: PaymentProvider = {
      getProduct: vi.fn(async () => {
        throw new Error("Unexpected product lookup in retention test");
      }),
      createCustomer: vi.fn(async () => {
        throw new Error("Unexpected customer creation in retention test");
      }),
      findCheckoutByExternalId: vi.fn(async (externalId) => {
        const response = checkoutResponses.get(externalId) ?? null;
        if (response instanceof Error) throw response;
        return response;
      }),
      createMonthlyCheckout: vi.fn(async () => {
        throw new Error("Unexpected checkout creation in retention test");
      }),
      cancelSubscription: vi.fn(async () => {
        throw new Error("Unexpected cancellation in retention test");
      }),
    };
    payments = new PaymentsService(
      prisma as unknown as PrismaService,
      config,
      provider,
    );
    service = new TenantRetentionService(
      prisma as unknown as PrismaService,
      config,
      payments,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("apaga o agregado pending inteiro no limite e a segunda execução é idempotente", async () => {
    const now = new Date();
    const ids = await createTenant(prisma, "Retenção completa", now);
    const related = await seedAggregate(prisma, ids);

    await expect(
      prisma.legalAcceptance.delete({ where: { id: related.legalId } }),
    ).rejects.toThrow(/LEGAL_ACCEPTANCE_IS_APPEND_ONLY/);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT set_config(
            'app.tenant_retention_family_id',
            ${ids.familyId},
            TRUE
          )
        `;
        await tx.legalAcceptance.delete({ where: { id: related.legalId } });
      }),
    ).rejects.toThrow(/LEGAL_ACCEPTANCE_IS_APPEND_ONLY/);
    await expect(
      prisma.legalAcceptance.update({
        where: { id: related.legalId },
        data: { source: LegalAcceptanceSource.google },
      }),
    ).rejects.toThrow(/LEGAL_ACCEPTANCE_IS_APPEND_ONLY/);

    const first = await service.run(now);
    expect(first.pendingPaymentPurged).toBeGreaterThanOrEqual(1);
    await expectAggregateMissing(prisma, ids, related);

    const second = await service.run(new Date(now.getTime() + 1));
    expect(second).toMatchObject({
      pendingPaymentPurged: 0,
      cancelledPurged: 0,
    });
    await expect(service.health(new Date())).resolves.toMatchObject({
      healthy: true,
    });
  });

  it("purga cancelado, mas preserva active, checkout ambíguo e lease em processamento", async () => {
    const now = new Date();
    const cancelled = await createTenant(prisma, "Cancelado", null);
    const active = await createTenant(
      prisma,
      "Ativo",
      new Date(now.getTime() - 1),
    );
    const ambiguous = await createTenant(prisma, "Ambíguo", now);
    const processing = await createTenant(prisma, "Processando", now);

    await attachSubscription(prisma, cancelled, {
      providerStatus: "CANCELLED",
      lastProviderEvent: "subscription.cancelled",
      cancelledAt: new Date(now.getTime() - 86_400_000),
      cancelledDueTo: "owner_requested",
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: "CANCELLED_AFTER_AMBIGUOUS_CHECKOUT",
    });
    await prisma.family.update({
      where: { id: cancelled.familyId },
      data: {
        cancelledAt: new Date(now.getTime() - 86_400_000),
        purgeAfter: now,
      },
    });

    await attachSubscription(prisma, active, {
      providerStatus: "ACTIVE",
      lastProviderEvent: "subscription.renewed",
      providerUpdatedAt: new Date(now.getTime() - 2_000),
      lastSuccessfulPaymentAt: new Date(now.getTime() - 3_000),
      accessPaidThrough: new Date(now.getTime() + 86_400_000),
      lastInstallmentNumber: 2,
      entitlementContractVersion: "integration-contract-v1",
      paymentMethod: SubscriptionPaymentMethod.CARD,
    });
    await attachSubscription(prisma, ambiguous, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: "RETENTION_FIXTURE_AMBIGUOUS",
    });
    await attachSubscription(prisma, processing, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
      checkoutCreationAllowed: false,
      checkoutClaimToken: "fresh-claim",
      checkoutLockedAt: new Date(now.getTime() - 1_000),
    });

    const result = await service.run(now);
    expect(result.cancelledPurged).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.family.findUnique({ where: { id: cancelled.familyId } }),
    ).toBeNull();
    for (const retained of [active, ambiguous, processing]) {
      expect(
        await prisma.family.findUnique({ where: { id: retained.familyId } }),
      ).not.toBeNull();
    }
  });

  it("faz rollback integral quando o DELETE final falha e registra a execução", async () => {
    const now = new Date();
    const ids = await createTenant(prisma, "Rollback retention", now);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "block_retention_fixture_delete"()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."name" LIKE 'Rollback retention%' THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'RETENTION_FIXTURE_BLOCKED';
        END IF;
        RETURN OLD;
      END
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "Family_retention_fixture_block"
      BEFORE DELETE ON "Family"
      FOR EACH ROW EXECUTE FUNCTION "block_retention_fixture_delete"()
    `);

    await expect(service.run(now)).rejects.toThrow();
    const family = await prisma.family.findUnique({
      where: { id: ids.familyId },
    });
    expect(family?.ownerUserId).toBe(ids.userId);
    expect(
      await prisma.memberProfile.count({ where: { familyId: ids.familyId } }),
    ).toBe(1);
    await expect(
      prisma.tenantPurgeRun.findFirst({ orderBy: { startedAt: "desc" } }),
    ).resolves.toMatchObject({ status: "failed" });

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER "Family_retention_fixture_block" ON "Family"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION "block_retention_fixture_delete"()`,
    );
    await service.run(new Date(now.getTime() + 1));
    expect(
      await prisma.family.findUnique({ where: { id: ids.familyId } }),
    ).toBeNull();
  });

  it("reconcilia terminal pré-ativação antes do purge e retém respostas inseguras", async () => {
    const now = new Date();
    const expired = await createTenant(prisma, "Checkout expirado", now);
    const cancelled = await createTenant(prisma, "Checkout cancelado", now);
    const expiredSubscription = await attachSubscription(prisma, expired, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: "LOOKUP_PREVIOUSLY_AMBIGUOUS",
    });
    const cancelledSubscription = await attachSubscription(prisma, cancelled, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
      checkoutCreationAllowed: false,
      checkoutClaimToken: "provider-call-in-flight",
      checkoutLockedAt: new Date(now.getTime() - 1_000),
    });
    checkoutResponses.set(
      expiredSubscription.externalId,
      retentionCheckout(expiredSubscription.externalId, "EXPIRED"),
    );
    checkoutResponses.set(
      cancelledSubscription.externalId,
      retentionCheckout(cancelledSubscription.externalId, "CANCELLED"),
    );

    const purged = await service.run(now);
    expect(purged.pendingPaymentPurged).toBeGreaterThanOrEqual(2);
    for (const ids of [expired, cancelled]) {
      expect(
        await prisma.family.findUnique({ where: { id: ids.familyId } }),
      ).toBeNull();
    }

    const retained: TenantIds[] = [];
    for (const status of ["PENDING", "PAID", "REFUNDED"] as const) {
      const ids = await createTenant(prisma, `Retido ${status}`, now);
      const subscription = await attachSubscription(prisma, ids, {
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
        checkoutCreationAllowed: false,
        checkoutLastErrorCode: `LOCAL_AMBIGUOUS_${status}`,
      });
      checkoutResponses.set(
        subscription.externalId,
        retentionCheckout(subscription.externalId, status),
      );
      await expect(
        payments.reconcileCheckoutBeforeRetention(ids.familyId, now),
      ).resolves.toBe(false);
      retained.push(ids);
    }

    const notFound = await createTenant(prisma, "Retido sem resultado", now);
    const notFoundSubscription = await attachSubscription(prisma, notFound, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: "LOCAL_AMBIGUOUS_NOT_FOUND",
    });
    checkoutResponses.set(notFoundSubscription.externalId, null);
    await expect(
      payments.reconcileCheckoutBeforeRetention(notFound.familyId, now),
    ).resolves.toBe(false);
    retained.push(notFound);

    const mismatch = await createTenant(prisma, "Retido mismatch", now);
    const mismatchSubscription = await attachSubscription(prisma, mismatch, {
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: "LOCAL_AMBIGUOUS_MISMATCH",
    });
    checkoutResponses.set(mismatchSubscription.externalId, {
      ...retentionCheckout(mismatchSubscription.externalId, "EXPIRED"),
      productId: "prod_wrong",
    });
    await expect(
      payments.reconcileCheckoutBeforeRetention(mismatch.familyId, now),
    ).rejects.toThrow(/RETENTION_CHECKOUT_IDENTITY_MISMATCH/);
    retained.push(mismatch);

    const providerError = await createTenant(
      prisma,
      "Retido erro provider",
      now,
    );
    const providerErrorSubscription = await attachSubscription(
      prisma,
      providerError,
      {
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
        checkoutCreationAllowed: false,
        checkoutLastErrorCode: "LOCAL_AMBIGUOUS_PROVIDER_ERROR",
      },
    );
    checkoutResponses.set(
      providerErrorSubscription.externalId,
      new Error("provider unavailable"),
    );
    await expect(
      payments.reconcileCheckoutBeforeRetention(providerError.familyId, now),
    ).rejects.toThrow(/RETENTION_CHECKOUT_PROVIDER_UNAVAILABLE/);
    retained.push(providerError);

    for (const ids of retained) {
      expect(
        await prisma.family.findUnique({ where: { id: ids.familyId } }),
      ).not.toBeNull();
      expect(
        await prisma.subscription.findFirst({
          where: { familyId: ids.familyId },
          select: { checkoutClosedAt: true },
        }),
      ).toMatchObject({ checkoutClosedAt: null });
    }
  });
});

async function createTenant(
  prisma: PrismaClient,
  label: string,
  pendingPaymentExpiresAt: Date | null,
): Promise<TenantIds> {
  const suffix = randomUUID();
  return prisma.$transaction(async (tx) => {
    const familyId = randomUUID();
    const userId = randomUUID();
    const profileId = randomUUID();
    await tx.family.create({
      data: {
        id: familyId,
        name: `${label} ${suffix}`,
        pendingPaymentExpiresAt,
        ...(pendingPaymentExpiresAt
          ? {
              createdAt: new Date(pendingPaymentExpiresAt.getTime() - 1),
            }
          : {}),
      },
    });
    await tx.user.create({
      data: {
        id: userId,
        email: `retention-${suffix}@example.test`,
        name: label,
        familyId,
        emailVerifiedAt: new Date(),
      },
    });
    await tx.memberProfile.create({
      data: { id: profileId, displayName: label, userId, familyId },
    });
    await tx.family.update({
      where: { id: familyId },
      data: { ownerUserId: userId },
    });
    return { familyId, userId, profileId };
  });
}

async function attachSubscription(
  prisma: PrismaClient,
  ids: TenantIds,
  patch: Record<string, unknown>,
) {
  return prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.create({
      data: {
        familyId: ids.familyId,
        externalId: `local_${randomUUID()}`,
        providerProductId: "prod_retention_monthly",
        amountCents: 2_990,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
        ...patch,
      },
    });
    await tx.family.update({
      where: { id: ids.familyId },
      data: { currentSubscriptionId: subscription.id },
    });
    return subscription;
  });
}

async function seedAggregate(prisma: PrismaClient, ids: TenantIds) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.create({
      data: {
        name: `Categoria ${randomUUID()}`,
        type: CategoryType.expense,
        color: "#000000",
        familyId: ids.familyId,
      },
    });
    const account = await tx.account.create({
      data: {
        name: "Conta retenção",
        type: AccountType.checking,
        memberProfileId: ids.profileId,
      },
    });
    const transaction = await tx.transaction.create({
      data: {
        date: new Date(),
        applicationDate: new Date(),
        referenceMonth: new Date(),
        description: "PII a remover",
        amountCents: 100,
        type: TransactionType.expense,
        memberProfileId: ids.profileId,
        accountId: account.id,
        categoryId: category.id,
      },
    });
    const invite = await tx.memberInvite.create({
      data: {
        token: randomUUID(),
        email: `invite-${randomUUID()}@example.test`,
        expiresAt: new Date(Date.now() + 86_400_000),
        creatorUserId: ids.userId,
        familyId: ids.familyId,
      },
    });
    const approval = await tx.memberApproval.create({
      data: {
        requestedName: "Pessoa removida",
        requestedEmail: `approval-${randomUUID()}@example.test`,
        inviteId: invite.id,
        familyId: ids.familyId,
      },
    });
    const legal = await tx.legalAcceptance.create({
      data: {
        userId: ids.userId,
        familyId: ids.familyId,
        bundleVersion: `integration-${randomUUID()}`,
        source: LegalAcceptanceSource.local,
      },
    });
    const group = await tx.telegramAuthorizedGroup.create({
      data: {
        chatId: `chat-${randomUUID()}`,
        familyId: ids.familyId,
        authorizedByUserId: ids.userId,
      },
    });
    const link = await tx.telegramUserLink.create({
      data: {
        tgUserId: `tg-${randomUUID()}`,
        chatId: group.chatId,
        familyId: ids.familyId,
        memberProfileId: ids.profileId,
      },
    });
    const authCode = await tx.telegramAuthCode.create({
      data: {
        code: randomUUID(),
        kind: TelegramAuthCodeKind.MEMBER,
        userId: ids.userId,
        memberProfileId: ids.profileId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const messageLog = await tx.telegramMessageLog.create({
      data: {
        chatId: group.chatId,
        tgUserId: link.tgUserId,
        messageId: 1,
        memberProfileId: ids.profileId,
        textRaw: "mensagem pessoal",
      },
    });
    const update = await tx.telegramUpdate.create({
      data: {
        updateId: `update-${randomUUID()}`,
        payload: { private: "payload" },
      },
    });
    const orphanUpdate = await tx.telegramUpdate.create({
      data: {
        updateId: `orphan-update-${randomUUID()}`,
        payload: {
          update_id: randomUUID(),
          message: {
            message_id: 2,
            chat: { id: group.chatId },
            from: { id: link.tgUserId },
            text: "comando pessoal sem lançamento",
          },
        },
      },
    });
    const unrelatedUpdate = await tx.telegramUpdate.create({
      data: {
        updateId: `unrelated-update-${randomUUID()}`,
        payload: {
          message: {
            chat: { id: `other-chat-${randomUUID()}` },
            text: "outro tenant",
          },
        },
      },
    });
    const operation = await tx.telegramFinancialOperation.create({
      data: {
        idempotencyKey: randomUUID(),
        kind: TelegramFinancialOperationKind.TRANSACTION,
        memberProfileId: ids.profileId,
        tgUserId: link.tgUserId,
        chatId: group.chatId,
        sourceUpdateId: update.updateId,
        transactionId: transaction.id,
      },
    });
    return {
      categoryId: category.id,
      accountId: account.id,
      transactionId: transaction.id,
      inviteId: invite.id,
      approvalId: approval.id,
      legalId: legal.id,
      groupId: group.id,
      linkId: link.id,
      authCodeId: authCode.id,
      messageLogId: messageLog.id,
      updateId: update.updateId,
      orphanUpdateId: orphanUpdate.updateId,
      unrelatedUpdateId: unrelatedUpdate.updateId,
      operationId: operation.id,
    };
  });
}

async function expectAggregateMissing(
  prisma: PrismaClient,
  ids: TenantIds,
  related: Awaited<ReturnType<typeof seedAggregate>>,
) {
  const counts = await Promise.all([
    prisma.family.count({ where: { id: ids.familyId } }),
    prisma.user.count({ where: { id: ids.userId } }),
    prisma.memberProfile.count({ where: { id: ids.profileId } }),
    prisma.category.count({ where: { id: related.categoryId } }),
    prisma.account.count({ where: { id: related.accountId } }),
    prisma.transaction.count({ where: { id: related.transactionId } }),
    prisma.memberInvite.count({ where: { id: related.inviteId } }),
    prisma.memberApproval.count({ where: { id: related.approvalId } }),
    prisma.legalAcceptance.count({ where: { id: related.legalId } }),
    prisma.telegramAuthorizedGroup.count({ where: { id: related.groupId } }),
    prisma.telegramUserLink.count({ where: { id: related.linkId } }),
    prisma.telegramAuthCode.count({ where: { id: related.authCodeId } }),
    prisma.telegramMessageLog.count({ where: { id: related.messageLogId } }),
    prisma.telegramUpdate.count({ where: { updateId: related.updateId } }),
    prisma.telegramUpdate.count({ where: { updateId: related.orphanUpdateId } }),
    prisma.telegramFinancialOperation.count({
      where: { id: related.operationId },
    }),
  ]);
  expect(counts).toEqual(new Array(counts.length).fill(0));
  await expect(
    prisma.telegramUpdate.count({
      where: { updateId: related.unrelatedUpdateId },
    }),
  ).resolves.toBe(1);
}

function retentionCheckout(
  externalId: string,
  status: PaymentCheckout["status"],
): PaymentCheckout {
  const id = `bill_${randomUUID()}`;
  return {
    id,
    externalId,
    url: `https://app.abacatepay.com/pay/${id}`,
    amountCents: 2_990,
    currency: "BRL",
    status,
    customerId: null,
    productId: "prod_retention_monthly",
    quantity: 1,
    devMode: true,
  };
}
