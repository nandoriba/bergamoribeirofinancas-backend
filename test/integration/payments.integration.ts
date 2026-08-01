import { ConfigService } from '@nestjs/config';
import {
  CheckoutProvisioningStatus,
  PlatformRole,
  PrismaClient,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../src/prisma/prisma.service';
import type { AuthenticatedUser } from '../../src/modules/auth/auth.types';
import {
  PaymentProviderError,
  type CancelledPaymentSubscription,
  type CreateMonthlyCheckoutInput,
  type CreatePaymentCustomerInput,
  type PaymentCheckout,
  type PaymentCustomer,
  type PaymentProduct,
  type PaymentProvider,
} from '../../src/modules/payments/payment-provider';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { SubscriptionCancellationService } from '../../src/modules/payments/subscription-cancellation.service';

const PRODUCT_ID = 'prod_integration_monthly';
const AMOUNT_CENTS = 2_990;
const WEB_ORIGIN = 'https://financeiro.integration.test';

interface TenantFixture {
  familyId: string;
  userId: string;
  profileId: string;
  user: AuthenticatedUser;
  memberUser: AuthenticatedUser;
}

describe('checkout AbacatePay com PostgreSQL real', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('isola dois tenants e limita owners concorrentes a um POST por tenant', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createTenant(prisma, 'Concorrência A'),
      createTenant(prisma, 'Concorrência B'),
    ]);
    const provider = new FakePaymentProvider({ holdFirstPost: true });
    const service = makeService(prisma, provider);

    const attemptsA = [
      service.createCheckout(tenantA.user),
      service.createCheckout(tenantA.user),
    ];
    await provider.waitForFirstPost();
    await new Promise<void>((resolve) => setImmediate(resolve));
    provider.releaseFirstPost();
    const resultsA = await Promise.allSettled(attemptsA);

    const fulfilledA = resultsA.filter((result) => result.status === 'fulfilled');
    const rejectedA = resultsA.filter((result) => result.status === 'rejected');
    expect(fulfilledA.length).toBeGreaterThanOrEqual(1);
    for (const rejected of rejectedA) {
      expect(rejected.reason).toMatchObject({ status: 409 });
    }
    const urlsA = resultsA.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.checkoutUrl] : [],
    );
    expect(new Set(urlsA).size).toBe(1);
    expect(provider.postCount).toBe(1);

    await expect(service.createCheckout(tenantB.user)).resolves.toMatchObject({
      checkoutUrl: expect.stringMatching(/^https:\/\/app\.abacatepay\.com\/pay\/bill_/),
    });
    expect(provider.postCount).toBe(2);

    const [subscriptionsA, subscriptionsB] = await Promise.all([
      prisma.subscription.findMany({ where: { familyId: tenantA.familyId } }),
      prisma.subscription.findMany({ where: { familyId: tenantB.familyId } }),
    ]);
    expect(subscriptionsA).toHaveLength(1);
    expect(subscriptionsB).toHaveLength(1);
    expect(subscriptionsA[0]).toMatchObject({
      familyId: tenantA.familyId,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutAttempts: 1,
    });
    expect(subscriptionsB[0]).toMatchObject({
      familyId: tenantB.familyId,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutAttempts: 1,
    });
    expect(subscriptionsA[0]?.externalId).not.toBe(subscriptionsB[0]?.externalId);
    expect(provider.postExternalIds).toEqual(
      expect.arrayContaining([
        subscriptionsA[0]!.externalId,
        subscriptionsB[0]!.externalId,
      ]),
    );

    await prisma.subscription.update({
      where: { id: subscriptionsB[0]!.id },
      data: { providerCheckoutStatus: 'PAID' },
    });
    const [summaryA, summaryB] = await Promise.all([
      service.getSubscriptionSummary(tenantA.memberUser),
      service.getSubscriptionSummary(tenantB.user),
    ]);
    expect(summaryA.checkoutStatus).toBe('PENDING');
    expect(summaryA.actions.canCreateCheckout).toBe(false);
    expect(summaryB.checkoutStatus).toBe('PAID');
    expect(summaryB.actions.canCreateCheckout).toBe(true);

    const forgedTenant = {
      ...tenantA.user,
      familyId: tenantB.familyId,
      profileId: tenantB.profileId,
    };
    await expect(service.createCheckout(forgedTenant)).rejects.toMatchObject({ status: 403 });
    expect(provider.postCount).toBe(2);
    await expect(
      prisma.subscription.count({ where: { familyId: tenantB.familyId } }),
    ).resolves.toBe(1);
  });

  it('recupera timeout de resultado desconhecido por externalId sem repetir o POST', async () => {
    const tenant = await createTenant(prisma, 'Reconciliação');
    const provider = new FakePaymentProvider({ ambiguousFirstPost: true });
    const service = makeService(prisma, provider);

    await expectServiceCode(
      service.createCheckout(tenant.user),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    const ambiguous = await prisma.subscription.findFirstOrThrow({
      where: { familyId: tenant.familyId },
    });
    expect(ambiguous).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutClaimToken: null,
      checkoutLockedAt: null,
      checkoutLastErrorCode: 'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
      providerCheckoutId: null,
      providerCheckoutUrl: null,
    });

    await expect(service.createCheckout(tenant.user)).resolves.toEqual({
      checkoutUrl: provider.checkoutFor(ambiguous.externalId)?.url,
    });
    expect(provider.postCount).toBe(1);
    const reconciled = await prisma.subscription.findUniqueOrThrow({
      where: { id: ambiguous.id },
    });
    expect(reconciled).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      providerCheckoutStatus: 'PENDING',
      checkoutLastErrorCode: null,
    });
    expect(reconciled.providerCheckoutId).toBe(provider.checkoutFor(ambiguous.externalId)?.id);
  });

  it('cancela somente a assinatura corrente do owner e preserva integralmente outro tenant', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createTenant(prisma, 'Cancelamento isolado A'),
      createTenant(prisma, 'Cancelamento isolado B'),
    ]);
    const [subscriptionA, subscriptionB] = await Promise.all([
      attachActiveSubscription(prisma, tenantA, 'A'),
      attachActiveSubscription(prisma, tenantB, 'B'),
    ]);
    const provider = new FakePaymentProvider();
    const cancellation = makeCancellationService(prisma, provider);

    const userBCrossTenant = {
      ...tenantB.user,
      familyId: tenantA.familyId,
      profileId: tenantA.profileId,
    };
    await expect(cancellation.cancel(userBCrossTenant)).rejects.toMatchObject({
      status: 403,
    });
    expect(provider.cancelledSubscriptionIds).toEqual([]);
    await expect(
      prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionA.id } }),
    ).resolves.toMatchObject({
      providerStatus: 'ACTIVE',
      cancelRequestedAt: null,
      cancelClaimToken: null,
      cancelAttempts: 0,
    });

    const result = await cancellation.cancel(tenantA.user);
    expect(provider.cancelledSubscriptionIds).toEqual([
      subscriptionA.providerSubscriptionId,
    ]);

    const [persistedA, persistedB, familyA, familyB] = await Promise.all([
      prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionA.id } }),
      prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionB.id } }),
      prisma.family.findUniqueOrThrow({ where: { id: tenantA.familyId } }),
      prisma.family.findUniqueOrThrow({ where: { id: tenantB.familyId } }),
    ]);
    expect(persistedA).toMatchObject({
      familyId: tenantA.familyId,
      providerSubscriptionId: subscriptionA.providerSubscriptionId,
      providerStatus: 'CANCELLED',
      lastProviderEvent: 'subscription.cancelled',
      cancelledAt: expect.any(Date),
      cancelledDueTo: 'owner_requested',
      cancelRequestedAt: expect.any(Date),
      cancelClaimToken: null,
      cancelLockedAt: null,
      cancelAttempts: 1,
      cancelLastErrorCode: null,
    });
    expect(familyA).toMatchObject({
      ownerUserId: tenantA.userId,
      currentSubscriptionId: subscriptionA.id,
      pendingPaymentExpiresAt: null,
      cancelledAt: persistedA.cancelledAt,
      purgeAfter: expect.any(Date),
    });
    expect(result).toEqual({
      effectiveStatus: 'cancelled',
      cancelledAt: persistedA.cancelledAt!.toISOString(),
      purgeAfter: familyA.purgeAfter!.toISOString(),
    });

    expect(persistedB).toMatchObject({
      familyId: tenantB.familyId,
      providerSubscriptionId: subscriptionB.providerSubscriptionId,
      providerStatus: 'ACTIVE',
      lastProviderEvent: 'subscription.renewed',
      cancelledAt: null,
      cancelRequestedAt: null,
      cancelClaimToken: null,
      cancelAttempts: 0,
    });
    expect(familyB).toMatchObject({
      ownerUserId: tenantB.userId,
      currentSubscriptionId: subscriptionB.id,
      pendingPaymentExpiresAt: null,
      cancelledAt: null,
      purgeAfter: null,
    });
    expect(familyA.currentSubscriptionId).not.toBe(familyB.currentSubscriptionId);
  });

  it('mantém um resultado ambíguo sem correspondência bloqueado e sem novo POST', async () => {
    const tenant = await createTenant(prisma, 'Ambíguo sem lookup');
    const provider = new FakePaymentProvider({ ambiguousFirstPost: true });
    const service = makeService(prisma, provider);

    await expectServiceCode(
      service.createCheckout(tenant.user),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { familyId: tenant.familyId },
    });
    provider.forgetCheckout(subscription.externalId);

    await expectServiceCode(
      service.createCheckout(tenant.user),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(provider.postCount).toBe(1);
    await expect(
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
    ).resolves.toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutClaimToken: null,
      checkoutLockedAt: null,
    });
  });

  it('aplica no banco unicidade, formato, máquina de estados e imutabilidade', async () => {
    const [uniqueTenant, urlTenant, claimTenant, closedTenant, malformedClosedTenant] = await Promise.all([
      createTenant(prisma, 'Constraint única'),
      createTenant(prisma, 'Constraint URL'),
      createTenant(prisma, 'Constraint claim'),
      createTenant(prisma, 'Constraint fechamento'),
      createTenant(prisma, 'Constraint fechamento incompleto'),
    ]);
    const createdAt = new Date(Date.now() - 5_000);
    const first = await prisma.subscription.create({
      data: baseSubscriptionData(uniqueTenant.familyId, 'constraint-open-a', createdAt),
    });

    await expect(
      prisma.subscription.create({
        data: baseSubscriptionData(uniqueTenant.familyId, 'constraint-open-b', createdAt),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      prisma.subscription.create({
        data: {
          ...baseSubscriptionData(urlTenant.familyId, 'constraint-url', createdAt),
          checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
          checkoutCreationAllowed: false,
          providerCheckoutId: `bill_${randomUUID()}`,
          providerCheckoutUrl: 'https://attacker.example/pay/bill_invalid',
          providerCheckoutStatus: 'PENDING',
          checkoutReadyAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.subscription.create({
        data: {
          ...baseSubscriptionData(claimTenant.familyId, 'constraint-claim', createdAt),
          checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
          checkoutClaimToken: null,
          checkoutLockedAt: null,
        },
      }),
    ).rejects.toBeDefined();

    const transitionBillId = `bill_${randomUUID()}`;
    await expect(
      prisma.subscription.update({
        where: { id: first.id },
        data: { amountCents: AMOUNT_CENTS + 1 },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.subscription.update({
        where: { id: first.id },
        data: { familyId: urlTenant.familyId },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.subscription.update({
        where: { id: first.id },
        data: { provider: 'outro-provedor' },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.subscription.update({
        where: { id: first.id },
        data: {
          checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
          checkoutCreationAllowed: false,
          providerCheckoutId: transitionBillId,
          providerCheckoutUrl: `https://app.abacatepay.com/pay/${transitionBillId}`,
          providerCheckoutStatus: 'PENDING',
          checkoutReadyAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
    const closedBillId = `bill_${randomUUID()}`;
    const closed = await prisma.subscription.create({
      data: {
        ...baseSubscriptionData(closedTenant.familyId, 'constraint-closed', createdAt),
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
        checkoutCreationAllowed: false,
        providerCheckoutId: closedBillId,
        providerCheckoutUrl: `https://app.abacatepay.com/pay/${closedBillId}`,
        providerCheckoutStatus: 'EXPIRED',
        checkoutReadyAt: new Date(Date.now() - 1_000),
        checkoutClosedAt: new Date(),
        checkoutCloseReason: 'EXPIRED',
      },
    });
    await expect(
      prisma.subscription.update({
        where: { id: closed.id },
        data: { checkoutClosedAt: null, checkoutCloseReason: null },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.subscription.update({
        where: { id: closed.id },
        data: { checkoutReadyAt: new Date() },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.subscription.create({
        data: {
          ...baseSubscriptionData(
            malformedClosedTenant.familyId,
            'constraint-closed-incomplete',
            createdAt,
          ),
          checkoutClosedAt: new Date(),
          checkoutCloseReason: 'EXPIRED',
          providerCheckoutStatus: null,
          checkoutReadyAt: null,
        },
      }),
    ).rejects.toBeDefined();

    await expect(prisma.subscription.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({
      amountCents: AMOUNT_CENTS,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.pending,
      providerCheckoutId: null,
    });
    await expect(prisma.subscription.findUniqueOrThrow({ where: { id: closed.id } })).resolves.toMatchObject({
      checkoutClosedAt: expect.any(Date),
      checkoutCloseReason: 'EXPIRED',
    });
  });
});

class FakePaymentProvider implements PaymentProvider {
  private readonly checkouts = new Map<string, PaymentCheckout>();
  private readonly holdFirstPost: boolean;
  private readonly ambiguousFirstPost: boolean;
  private firstPostStartedResolve!: () => void;
  private releaseFirstPostResolve!: () => void;
  private readonly firstPostStarted = new Promise<void>((resolve) => {
    this.firstPostStartedResolve = resolve;
  });
  private readonly firstPostReleased = new Promise<void>((resolve) => {
    this.releaseFirstPostResolve = resolve;
  });
  postCount = 0;
  readonly postExternalIds: string[] = [];
  readonly cancelledSubscriptionIds: string[] = [];

  constructor(options: { holdFirstPost?: boolean; ambiguousFirstPost?: boolean } = {}) {
    this.holdFirstPost = options.holdFirstPost ?? false;
    this.ambiguousFirstPost = options.ambiguousFirstPost ?? false;
  }

  async getProduct(id: string): Promise<PaymentProduct> {
    return {
      id,
      name: 'Plano familiar integração',
      priceCents: AMOUNT_CENTS,
      currency: 'BRL',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      trialDays: null,
      devMode: true,
    };
  }

  async createCustomer(input: CreatePaymentCustomerInput): Promise<PaymentCustomer> {
    return {
      id: `cust_${randomUUID()}`,
      email: input.email,
      name: input.name ?? null,
      devMode: true,
    };
  }

  async findCheckoutByExternalId(externalId: string): Promise<PaymentCheckout | null> {
    return this.checkouts.get(externalId) ?? null;
  }

  async createMonthlyCheckout(input: CreateMonthlyCheckoutInput): Promise<PaymentCheckout> {
    this.postCount += 1;
    this.postExternalIds.push(input.externalId);
    const sequence = this.postCount;
    const billId = `bill_${randomUUID()}`;
    const checkout: PaymentCheckout = {
      id: billId,
      externalId: input.externalId,
      url: `https://app.abacatepay.com/pay/${billId}`,
      amountCents: AMOUNT_CENTS,
      currency: 'BRL',
      status: 'PENDING',
      customerId: `cust_${randomUUID()}`,
      productId: input.productId,
      quantity: 1,
      devMode: true,
    };
    this.checkouts.set(input.externalId, checkout);
    if (sequence === 1) {
      this.firstPostStartedResolve();
      if (this.holdFirstPost) await this.firstPostReleased;
      if (this.ambiguousFirstPost) {
        throw new PaymentProviderError(
          'ambiguous',
          'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
          'create_checkout',
        );
      }
    }
    return checkout;
  }

  async cancelSubscription(
    id: string,
  ): Promise<CancelledPaymentSubscription> {
    this.cancelledSubscriptionIds.push(id);
    return {
      id,
      customerId: null,
      amountCents: AMOUNT_CENTS,
      currency: 'BRL',
      method: 'CARD',
      status: 'CANCELLED',
      devMode: true,
    };
  }

  waitForFirstPost() {
    return this.firstPostStarted;
  }

  releaseFirstPost() {
    this.releaseFirstPostResolve();
  }

  checkoutFor(externalId: string) {
    return this.checkouts.get(externalId);
  }

  forgetCheckout(externalId: string) {
    this.checkouts.delete(externalId);
  }
}

function makeService(prisma: PrismaClient, provider: PaymentProvider) {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    WEB_ORIGIN,
    ABACATEPAY_ENABLED: true,
    ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: PRODUCT_ID,
    ABACATEPAY_MONTHLY_AMOUNT_CENTS: AMOUNT_CENTS,
    ABACATEPAY_PLAN_NAME: 'Plano familiar integração',
    ABACATEPAY_TIMEOUT_MS: 10_000,
    ABACATEPAY_RETRY_MAX: 3,
    ABACATEPAY_RETRY_EVERY_DAYS: 2,
    ABACATEPAY_CHECKOUT_LOCK_SECONDS: 90,
  };
  const config = {
    get: <T>(key: string) => values[key] as T | undefined,
  } as ConfigService;
  return new PaymentsService(prisma as unknown as PrismaService, config, provider);
}

function makeCancellationService(
  prisma: PrismaClient,
  provider: PaymentProvider,
) {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    RETENTION_CANCELLED_MONTHS: 12,
  };
  const config = {
    get: <T>(key: string) => values[key] as T | undefined,
  } as ConfigService;
  return new SubscriptionCancellationService(
    prisma as unknown as PrismaService,
    config,
    provider,
  );
}

async function createTenant(prisma: PrismaClient, label: string): Promise<TenantFixture> {
  const suffix = randomUUID();
  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: {
        id: randomUUID(),
        name: `${label} ${suffix}`,
        pendingPaymentExpiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `payments-${suffix}@example.test`,
        name: label,
        familyId: family.id,
        emailVerifiedAt: new Date(),
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: label,
        familyId: family.id,
        userId: user.id,
      },
    });
    const member = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `payments-member-${suffix}@example.test`,
        name: `${label} Membro`,
        familyId: family.id,
        emailVerifiedAt: new Date(),
      },
    });
    const memberProfile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: `${label} Membro`,
        familyId: family.id,
        userId: member.id,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: { ownerUserId: user.id },
    });
    return {
      familyId: family.id,
      userId: user.id,
      profileId: profile.id,
      user: {
        id: user.id,
        email: user.email,
        platformRole: PlatformRole.user,
        tenantRole: 'owner',
        familyId: family.id,
        profileId: profile.id,
        requiredAction: 'payment',
      },
      memberUser: {
        id: member.id,
        email: member.email,
        platformRole: PlatformRole.user,
        tenantRole: 'member',
        familyId: family.id,
        profileId: memberProfile.id,
        requiredAction: 'payment',
      },
    };
  });
}

async function attachActiveSubscription(
  prisma: PrismaClient,
  tenant: TenantFixture,
  label: string,
) {
  const now = new Date();
  const billId = `bill_${randomUUID()}`;
  const subscription = await prisma.subscription.create({
    data: {
      familyId: tenant.familyId,
      externalId: `cancel-${label}-${randomUUID()}`,
      providerSubscriptionId: `subs_${randomUUID()}`,
      providerCustomerId: null,
      providerCheckoutId: billId,
      providerCheckoutUrl: `https://app.abacatepay.com/pay/${billId}`,
      providerCheckoutStatus: 'PAID',
      providerProductId: PRODUCT_ID,
      providerStatus: 'ACTIVE',
      lastProviderEvent: 'subscription.renewed',
      providerUpdatedAt: new Date(now.getTime() - 3_600_000),
      lastSuccessfulPaymentAt: new Date(now.getTime() - 3_600_001),
      accessPaidThrough: new Date(now.getTime() + 30 * 86_400_000),
      lastInstallmentNumber: 1,
      entitlementContractVersion: 'integration-cancellation-v1',
      amountCents: AMOUNT_CENTS,
      currency: 'BRL',
      paymentMethod: SubscriptionPaymentMethod.CARD,
      providerPaymentMethod: 'CARD',
      billingCycle: SubscriptionCycle.MONTHLY,
      devMode: true,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutAttempts: 1,
      checkoutReadyAt: new Date(now.getTime() - 7_200_000),
    },
  });
  await prisma.family.update({
    where: { id: tenant.familyId },
    data: {
      currentSubscriptionId: subscription.id,
      pendingPaymentExpiresAt: null,
    },
  });
  return subscription;
}

function baseSubscriptionData(familyId: string, externalId: string, createdAt: Date) {
  return {
    id: randomUUID(),
    familyId,
    externalId: `${externalId}-${randomUUID()}`,
    providerProductId: PRODUCT_ID,
    amountCents: AMOUNT_CENTS,
    currency: 'BRL',
    billingCycle: SubscriptionCycle.MONTHLY,
    devMode: true,
    createdAt,
  };
}

async function expectServiceCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Esperava falha ${code}`);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('getResponse' in error)) throw error;
    const response = (error as { getResponse(): unknown }).getResponse();
    expect(response).toMatchObject({ code });
  }
}
