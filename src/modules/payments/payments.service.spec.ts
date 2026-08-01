import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CheckoutProvisioningStatus,
  PlatformRole,
  SubscriptionCycle,
  type Subscription,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  PaymentProviderError,
  type CreateMonthlyCheckoutInput,
  type PaymentCheckout,
  type PaymentProduct,
  type PaymentProvider,
} from './payment-provider';
import { PaymentsService } from './payments.service';

const PRODUCT_ID = 'prod_dev_monthly';
const AMOUNT_CENTS = 2_990;
const WEB_ORIGIN = 'https://financeiro.example.test';

interface TestSubscription {
  id: string;
  familyId: string;
  provider: string;
  externalId: string;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  providerCheckoutId: string | null;
  providerCheckoutUrl: string | null;
  providerCheckoutStatus: string | null;
  providerProductId: string;
  providerStatus: string | null;
  lastProviderEvent: string | null;
  providerUpdatedAt: Date | null;
  lastSuccessfulPaymentAt: Date | null;
  accessPaidThrough: Date | null;
  paymentFailedAt: Date | null;
  graceUntil: Date | null;
  cancelledAt: Date | null;
  cancelledDueTo: string | null;
  lastInstallmentNumber: number | null;
  amountCents: number;
  currency: string;
  paymentMethod: null;
  providerPaymentMethod: string | null;
  billingCycle: SubscriptionCycle;
  devMode: boolean;
  checkoutProvisioningStatus: CheckoutProvisioningStatus;
  checkoutCreationAllowed: boolean;
  checkoutAttempts: number;
  checkoutClaimToken: string | null;
  checkoutLockedAt: Date | null;
  checkoutReadyAt: Date | null;
  checkoutClosedAt: Date | null;
  checkoutCloseReason: string | null;
  checkoutLastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class MemoryPaymentsPrisma {
  readonly familyId = 'family-a';
  readonly ownerId = 'owner-a';
  pendingPaymentExpiresAt: Date | null = new Date(Date.now() + 60 * 60_000);
  subscriptionRecord: TestSubscription | undefined;

  readonly family = {
    findUnique: vi.fn(async () => ({
      id: this.familyId,
      ownerUserId: this.ownerId,
      pendingPaymentExpiresAt: this.pendingPaymentExpiresAt,
      subscriptions: this.subscriptionRecord
        ? [{ providerCheckoutStatus: this.subscriptionRecord.providerCheckoutStatus }]
        : [],
    })),
  };

  readonly user = {
    findUnique: vi.fn(async () => ({
      familyId: this.familyId,
      isActive: true,
      emailVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    })),
  };

  readonly subscription = {
    findFirst: vi.fn(async () => this.cloneSubscription()),
    create: vi.fn(async (args: unknown) => {
      const data = (args as { data: Partial<TestSubscription> }).data;
      this.subscriptionRecord = makeSubscription(data);
      return this.cloneSubscription() as Subscription;
    }),
    updateMany: vi.fn(async (args: unknown) => {
      const input = args as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      const record = this.subscriptionRecord;
      if (!record || !matchesWhere(record, input.where)) return { count: 0 };

      for (const [key, value] of Object.entries(input.data)) {
        if (key === 'checkoutAttempts' && isRecord(value)) {
          record.checkoutAttempts += Number(value.increment ?? 0);
        } else {
          (record as unknown as Record<string, unknown>)[key] = value;
        }
      }
      record.updatedAt = new Date();
      return { count: 1 };
    }),
  };

  readonly $queryRaw = vi.fn(async () => [{ id: this.familyId }]);

  readonly $transaction = vi.fn(
    async (operation: (tx: MemoryPaymentsPrisma) => Promise<unknown>) => operation(this),
  );

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }

  seedSubscription(overrides: Partial<TestSubscription> = {}) {
    this.subscriptionRecord = makeSubscription(overrides);
  }

  private cloneSubscription(): Subscription | null {
    return this.subscriptionRecord
      ? ({ ...this.subscriptionRecord } as unknown as Subscription)
      : null;
  }
}

describe('PaymentsService', () => {
  it('falha antes de tocar no banco ou no provedor quando pagamentos estão desabilitados', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const provider = makeProvider();
    const service = makeService(prisma, provider, { ABACATEPAY_ENABLED: false });

    await expectServiceCode(service.createCheckout(ownerUser()), 'PAYMENTS_DISABLED');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.getProduct).not.toHaveBeenCalled();
    expect(provider.createMonthlyCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['id diferente', { id: 'prod_wrong' }],
    ['produto inativo', { status: 'INACTIVE' as const }],
    ['ciclo não mensal', { cycle: 'ANNUALLY' as const }],
    ['preço divergente', { priceCents: AMOUNT_CENTS + 1 }],
    ['ambiente divergente', { devMode: false }],
    ['produto com trial', { trialDays: 7 }],
    ['trialDays ausente', { trialDays: undefined }],
  ])('recusa %s sem adquirir claim nem criar checkout', async (_label, productPatch) => {
    const prisma = new MemoryPaymentsPrisma();
    const provider = makeProvider({
      getProduct: vi.fn(async () => validProduct(productPatch)),
    });
    const service = makeService(prisma, provider);

    await expectServiceCode(service.createCheckout(ownerUser()), 'PAYMENT_PRODUCT_INVALID');

    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(provider.createMonthlyCheckout).not.toHaveBeenCalled();
  });

  it('trata trialDays zero como ausência de trial, conforme o contrato do sandbox', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const provider = makeProvider({
      getProduct: vi.fn(async () => validProduct({ trialDays: 0 })),
    });
    const service = makeService(prisma, provider);

    await expect(service.createCheckout(ownerUser())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_test',
    });
    expect(provider.createMonthlyCheckout).toHaveBeenCalledOnce();
  });

  it('deriva produto, correlação, URLs e política de retry exclusivamente no servidor', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const provider = makeProvider();
    const service = makeService(prisma, provider);

    await expect(service.createCheckout(ownerUser())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_test',
    });

    expect(provider.createMonthlyCheckout).toHaveBeenCalledTimes(1);
    const input = vi.mocked(provider.createMonthlyCheckout).mock.calls[0]?.[0];
    expect(input).toStrictEqual({
      productId: PRODUCT_ID,
      externalId: expect.stringMatching(/^local_[0-9a-f-]{36}$/),
      metadata: {
        localReference: expect.stringMatching(/^local_[0-9a-f-]{36}$/),
        billingCycle: 'MONTHLY',
      },
      returnUrl: `${WEB_ORIGIN}/pagamento/pendente`,
      completionUrl: `${WEB_ORIGIN}/pagamento/sucesso`,
      retryPolicy: { maxRetries: 3, intervalDays: 2 },
    });
    expect(input?.metadata?.localReference).toBe(input?.externalId);
    expect(input).not.toHaveProperty('amountCents');
    expect(prisma.subscriptionRecord).toMatchObject({
      providerProductId: PRODUCT_ID,
      amountCents: AMOUNT_CENTS,
      currency: 'BRL',
      billingCycle: SubscriptionCycle.MONTHLY,
      devMode: true,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      providerCheckoutId: 'bill_test',
      providerCheckoutStatus: 'PENDING',
    });
  });

  it('usa compare-and-swap no claim e permite no máximo um POST concorrente', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription();
    let releaseCheckout: ((checkout: PaymentCheckout) => void) | undefined;
    const checkoutBarrier = new Promise<PaymentCheckout>((resolve) => {
      releaseCheckout = resolve;
    });
    const provider = makeProvider({
      createMonthlyCheckout: vi.fn(async () => checkoutBarrier),
    });
    const service = makeService(prisma, provider);

    const first = service.createCheckout(ownerUser());
    const second = service.createCheckout(ownerUser());
    await waitUntil(() => vi.mocked(provider.createMonthlyCheckout).mock.calls.length === 1);
    releaseCheckout?.(checkoutFor(prisma.subscriptionRecord!.externalId));
    const results = await Promise.allSettled([first, second]);

    expect(provider.createMonthlyCheckout).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status !== 'rejected') throw new Error('Esperava uma chamada rejeitada');
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(prisma.subscriptionRecord?.checkoutAttempts).toBe(1);
  });

  it('fecha resultado de timeout como ambíguo e reconcilia por externalId sem segundo POST', async () => {
    const prisma = new MemoryPaymentsPrisma();
    let remoteCheckout: PaymentCheckout | null = null;
    const createMonthlyCheckout = vi.fn(
      async (input: CreateMonthlyCheckoutInput): Promise<PaymentCheckout> => {
        remoteCheckout = checkoutFor(input.externalId);
        throw new PaymentProviderError(
          'ambiguous',
          'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
          'create_checkout',
        );
      },
    );
    const provider = makeProvider({
      findCheckoutByExternalId: vi.fn(async () => remoteCheckout),
      createMonthlyCheckout,
    });
    const service = makeService(prisma, provider);

    await expectServiceCode(
      service.createCheckout(ownerUser()),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(prisma.subscriptionRecord).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutClaimToken: null,
      checkoutLockedAt: null,
      checkoutLastErrorCode: 'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
    });

    await expect(service.createCheckout(ownerUser())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_test',
    });
    expect(createMonthlyCheckout).toHaveBeenCalledTimes(1);
    expect(provider.findCheckoutByExternalId).toHaveBeenCalledTimes(2);
    expect(prisma.subscriptionRecord).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      providerCheckoutId: 'bill_test',
      providerCheckoutStatus: 'PENDING',
      checkoutLastErrorCode: null,
    });
  });

  it.each([
    ['409 duplicado', 'DUPLICATE_EXTERNAL_ID' as const, 409],
    ['425 cedo demais', 'PROVIDER_HTTP_OUTCOME_UNKNOWN' as const, 425],
    ['429 limitado', 'PROVIDER_RATE_LIMITED' as const, 429],
    ['5xx indisponível', 'PROVIDER_UNAVAILABLE' as const, 503],
  ])('mantém criação desarmada após POST %s e lookup posterior vazio', async (_label, code, status) => {
    const prisma = new MemoryPaymentsPrisma();
    const createMonthlyCheckout = vi.fn(async (): Promise<PaymentCheckout> => {
      throw new PaymentProviderError('ambiguous', code, 'create_checkout', status);
    });
    const provider = makeProvider({ createMonthlyCheckout });
    const service = makeService(prisma, provider);

    await expectServiceCode(
      service.createCheckout(ownerUser()),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(prisma.subscriptionRecord).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: code,
    });

    await expectServiceCode(
      service.createCheckout(ownerUser()),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );
    expect(createMonthlyCheckout).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptionRecord?.checkoutCreationAllowed).toBe(false);
  });

  it('recupera claim stale somente por reconciliação e nunca rearma um POST incerto', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
      checkoutCreationAllowed: false,
      checkoutClaimToken: 'stale-claim',
      checkoutLockedAt: new Date(Date.now() - 120_000),
      checkoutAttempts: 1,
    });
    const provider = makeProvider();
    const service = makeService(prisma, provider, {
      ABACATEPAY_CHECKOUT_LOCK_SECONDS: 30,
    });

    await expectServiceCode(
      service.createCheckout(ownerUser()),
      'CHECKOUT_RECONCILIATION_REQUIRED',
    );

    expect(provider.createMonthlyCheckout).not.toHaveBeenCalled();
    expect(prisma.subscriptionRecord).toMatchObject({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutClaimToken: null,
      checkoutLockedAt: null,
      checkoutAttempts: 2,
    });
  });

  it('expõe somente o plano público e habilita checkout apenas para o owner pendente', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription({ providerCheckoutStatus: 'PENDING' });
    const service = makeService(prisma, makeProvider());

    await expect(service.getSubscriptionSummary(ownerUser())).resolves.toEqual({
      effectiveStatus: 'pending_payment',
      plan: {
        name: 'Plano familiar de teste',
        amountCents: AMOUNT_CENTS,
        currency: 'BRL',
        billingCycle: 'MONTHLY',
        methods: ['CARD'],
      },
      pendingPaymentExpiresAt: prisma.pendingPaymentExpiresAt!.toISOString(),
      checkoutStatus: 'PENDING',
      actions: { canCreateCheckout: true, canCancel: false },
    });
    expect(JSON.stringify(await service.getSubscriptionSummary(ownerUser()))).not.toContain(
      'bill_test',
    );
    await expect(
      service.getSubscriptionSummary({ ...ownerUser(), id: 'member-a', tenantRole: 'member' }),
    ).resolves.toMatchObject({
      effectiveStatus: 'pending_payment',
      checkoutStatus: 'PENDING',
      actions: { canCreateCheckout: false, canCancel: false },
    });
  });

  it('não publica plano R$ 0 quando a integração está desabilitada', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const service = makeService(prisma, makeProvider(), { ABACATEPAY_ENABLED: false });

    await expectServiceCode(
      service.getSubscriptionSummary(ownerUser()),
      'PAYMENTS_DISABLED',
    );
    expect(prisma.family.findUnique).not.toHaveBeenCalled();
  });

  it('não declara acesso ativo antes da SubscriptionAccessPolicy da fatia seguinte', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = null;
    const service = makeService(prisma, makeProvider());

    await expectServiceCode(
      service.getSubscriptionSummary(ownerUser()),
      'SUBSCRIPTION_POLICY_NOT_AVAILABLE',
    );
  });
});

function makeService(
  prisma: MemoryPaymentsPrisma,
  provider: PaymentProvider,
  overrides: Record<string, unknown> = {},
) {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    WEB_ORIGIN,
    ABACATEPAY_ENABLED: true,
    ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: PRODUCT_ID,
    ABACATEPAY_MONTHLY_AMOUNT_CENTS: AMOUNT_CENTS,
    ABACATEPAY_PLAN_NAME: 'Plano familiar de teste',
    ABACATEPAY_RETRY_MAX: 3,
    ABACATEPAY_RETRY_EVERY_DAYS: 2,
    ABACATEPAY_CHECKOUT_LOCK_SECONDS: 90,
    ...overrides,
  };
  const config = {
    get: <T>(key: string) => values[key] as T | undefined,
  } as ConfigService;
  return new PaymentsService(prisma.asService(), config, provider);
}

function makeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  const provider: PaymentProvider = {
    getProduct: vi.fn(async () => validProduct()),
    createCustomer: vi.fn(async () => ({
      id: 'cust_test',
      email: 'owner@example.test',
      name: 'Owner',
      devMode: true,
    })),
    findCheckoutByExternalId: vi.fn(async () => null),
    createMonthlyCheckout: vi.fn(async (input) => checkoutFor(input.externalId)),
    cancelSubscription: vi.fn(async () => ({
      id: 'subs_test',
      customerId: 'cust_test',
      amountCents: AMOUNT_CENTS,
      currency: 'BRL' as const,
      method: 'CARD' as const,
      status: 'CANCELLED' as const,
      devMode: true,
    })),
  };
  return { ...provider, ...overrides };
}

function validProduct(overrides: Partial<PaymentProduct> = {}): PaymentProduct {
  return {
    id: PRODUCT_ID,
    name: 'Plano familiar de teste',
    priceCents: AMOUNT_CENTS,
    currency: 'BRL',
    status: 'ACTIVE',
    cycle: 'MONTHLY',
    trialDays: null,
    devMode: true,
    ...overrides,
  };
}

function checkoutFor(externalId: string): PaymentCheckout {
  return {
    id: 'bill_test',
    externalId,
    url: 'https://app.abacatepay.com/pay/bill_test',
    amountCents: AMOUNT_CENTS,
    currency: 'BRL',
    status: 'PENDING',
    customerId: 'cust_test',
    productId: PRODUCT_ID,
    quantity: 1,
    devMode: true,
  };
}

function ownerUser(): AuthenticatedUser {
  return {
    id: 'owner-a',
    email: 'owner@example.test',
    platformRole: PlatformRole.user,
    tenantRole: 'owner',
    familyId: 'family-a',
    profileId: 'profile-a',
    requiredAction: 'payment',
  };
}

function makeSubscription(overrides: Partial<TestSubscription> = {}): TestSubscription {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  return {
    id: 'subscription-a',
    familyId: 'family-a',
    provider: 'abacatepay',
    externalId: 'local_11111111-1111-4111-8111-111111111111',
    providerSubscriptionId: null,
    providerCustomerId: null,
    providerCheckoutId: null,
    providerCheckoutUrl: null,
    providerCheckoutStatus: null,
    providerProductId: PRODUCT_ID,
    providerStatus: null,
    lastProviderEvent: null,
    providerUpdatedAt: null,
    lastSuccessfulPaymentAt: null,
    accessPaidThrough: null,
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: null,
    amountCents: AMOUNT_CENTS,
    currency: 'BRL',
    paymentMethod: null,
    providerPaymentMethod: null,
    billingCycle: SubscriptionCycle.MONTHLY,
    devMode: true,
    checkoutProvisioningStatus: CheckoutProvisioningStatus.pending,
    checkoutCreationAllowed: true,
    checkoutAttempts: 0,
    checkoutClaimToken: null,
    checkoutLockedAt: null,
    checkoutReadyAt: null,
    checkoutClosedAt: null,
    checkoutCloseReason: null,
    checkoutLastErrorCode: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function matchesWhere(record: TestSubscription, where: Record<string, unknown>) {
  const comparableKeys = [
    'id',
    'checkoutProvisioningStatus',
    'checkoutCreationAllowed',
    'checkoutClaimToken',
    'providerCheckoutId',
  ] as const;
  for (const key of comparableKeys) {
    if (key in where && where[key] !== record[key]) return false;
  }
  if ('checkoutClosedAt' in where && where.checkoutClosedAt !== record.checkoutClosedAt) return false;
  if (isRecord(where.checkoutLockedAt) && where.checkoutLockedAt.lte instanceof Date) {
    if (!record.checkoutLockedAt || record.checkoutLockedAt > where.checkoutLockedAt.lte) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function expectServiceCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Esperava falha ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (!(error instanceof ServiceUnavailableException)) throw error;
    expect(error.getResponse()).toMatchObject({ code });
  }
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condição assíncrona não foi atingida');
}
