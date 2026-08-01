import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CheckoutProvisioningStatus,
  PlatformRole,
  Prisma,
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
  cancelRequestedAt: Date | null;
  cancelledDueTo: string | null;
  lastInstallmentNumber: number | null;
  entitlementContractVersion: string | null;
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
  cancelClaimToken: string | null;
  cancelLockedAt: Date | null;
  cancelAttempts: number;
  cancelLastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class MemoryPaymentsPrisma {
  readonly familyId = 'family-a';
  readonly ownerId = 'owner-a';
  pendingPaymentExpiresAt: Date | null = new Date(Date.now() + 60 * 60_000);
  cancelledAt: Date | null = null;
  purgeAfter: Date | null = null;
  currentSubscriptionId: string | null = null;
  subscriptionRecord: TestSubscription | undefined;

  readonly family = {
    findUnique: vi.fn(async () => ({
      id: this.familyId,
      ownerUserId: this.ownerId,
      pendingPaymentExpiresAt: this.pendingPaymentExpiresAt,
      cancelledAt: this.cancelledAt,
      purgeAfter: this.purgeAfter,
      currentSubscriptionId: this.currentSubscriptionId,
      currentSubscription: this.cloneSubscription(),
    })),
    updateMany: vi.fn(async (args: unknown) => {
      const input = args as { where: Record<string, unknown>; data: Record<string, unknown> };
      if (
        'currentSubscriptionId' in input.where &&
        input.where.currentSubscriptionId !== this.currentSubscriptionId
      ) {
        return { count: 0 };
      }
      if ('currentSubscriptionId' in input.data) {
        this.currentSubscriptionId = String(input.data.currentSubscriptionId);
      }
      if ('pendingPaymentExpiresAt' in input.data) {
        this.pendingPaymentExpiresAt = input.data.pendingPaymentExpiresAt as Date | null;
      }
      if ('cancelledAt' in input.data) {
        this.cancelledAt = input.data.cancelledAt as Date | null;
      }
      if ('purgeAfter' in input.data) {
        this.purgeAfter = input.data.purgeAfter as Date | null;
      }
      return { count: 1 };
    }),
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
    findUnique: vi.fn(async () => this.cloneSubscription()),
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

  readonly subscriptionPayment = {
    updateMany: vi.fn(async () => ({ count: 1 })),
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
    this.currentSubscriptionId = this.subscriptionRecord.id;
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

  it('repete transação serializável quando queryRaw expõe SQLSTATE 40001 como P2010', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.$transaction
      .mockRejectedValueOnce(rawQueryError('40001'))
      .mockRejectedValueOnce(rawQueryError('40001'));
    const provider = makeProvider();
    const service = makeService(prisma, provider);

    await expect(service.createCheckout(ownerUser())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_test',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(provider.createMonthlyCheckout).toHaveBeenCalledOnce();
  });

  it('não repete P2010 de queryRaw com SQLSTATE não serializável', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const error = rawQueryError('23505');
    prisma.$transaction.mockRejectedValueOnce(error);
    const service = makeService(prisma, makeProvider());

    await expect(service.createCheckout(ownerUser())).rejects.toBe(error);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
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

    await expect(service.getSubscriptionSummary(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'pending_payment',
      accessAllowed: false,
      reason: 'FIRST_PAYMENT_UNCONFIRMED',
      plan: {
        name: 'Plano familiar de teste',
        amountCents: AMOUNT_CENTS,
        currency: 'BRL',
        billingCycle: 'MONTHLY',
        methods: ['CARD'],
      },
      pendingPaymentExpiresAt: prisma.pendingPaymentExpiresAt!.toISOString(),
      checkoutStatus: 'PENDING',
      history: [],
      actions: { canCreateCheckout: true, canCancel: false, canReconcile: true },
    });
    expect(JSON.stringify(await service.getSubscriptionSummary(ownerUser()))).not.toContain(
      'bill_test',
    );
    await expect(
      service.getSubscriptionSummary({ ...ownerUser(), id: 'member-a', tenantRole: 'member' }),
    ).resolves.toMatchObject({
      effectiveStatus: 'pending_payment',
      checkoutStatus: 'PENDING',
      actions: { canCreateCheckout: false, canCancel: false, canReconcile: false },
    });
  });

  it('mantém a leitura disponível e desabilita ações quando a integração está desligada', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const service = makeService(prisma, makeProvider(), { ABACATEPAY_ENABLED: false });

    await expect(service.getSubscriptionSummary(ownerUser())).resolves.toMatchObject({
      plan: { amountCents: AMOUNT_CENTS },
      actions: { canCreateCheckout: false, canCancel: false, canReconcile: false },
    });
    expect(prisma.family.findUnique).toHaveBeenCalledOnce();
  });

  it('nunca publica plano com valor zero mesmo no modo desabilitado', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const service = makeService(prisma, makeProvider(), {
      ABACATEPAY_ENABLED: false,
      ABACATEPAY_MONTHLY_AMOUNT_CENTS: undefined,
    });

    await expectServiceCode(
      service.getSubscriptionSummary(ownerUser()),
      'PAYMENTS_CONFIGURATION_INVALID',
    );
    expect(prisma.family.findUnique).not.toHaveBeenCalled();
  });

  it('não declara acesso ativo sem assinatura autoritativa nem prazo de onboarding', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = null;
    const service = makeService(prisma, makeProvider());

    await expect(service.getSubscriptionSummary(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'pending_payment',
      accessAllowed: false,
      reason: 'SUBSCRIPTION_ABSENT',
      actions: { canCreateCheckout: false },
    });
  });

  it('retorno após cancelamento cria nova assinatura sem reabrir a anterior', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const cancelledAt = new Date('2026-07-01T12:00:00.000Z');
    prisma.pendingPaymentExpiresAt = null;
    prisma.cancelledAt = cancelledAt;
    prisma.purgeAfter = new Date(Date.now() + 86_400_000);
    prisma.seedSubscription({
      providerSubscriptionId: 'subs_cancelled',
      providerStatus: 'CANCELLED',
      lastProviderEvent: 'subscription.cancelled',
      cancelledAt,
      cancelledDueTo: 'owner_requested',
    });
    const oldId = prisma.currentSubscriptionId;
    const service = makeService(prisma, makeProvider());

    await expect(service.createCheckout(ownerUser())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_test',
    });
    expect(prisma.currentSubscriptionId).not.toBe(oldId);
    expect(prisma.subscriptionRecord).toMatchObject({
      providerSubscriptionId: null,
      providerStatus: null,
      cancelledAt: null,
      billingCycle: SubscriptionCycle.MONTHLY,
    });
    expect(prisma.pendingPaymentExpiresAt).toBeInstanceOf(Date);
    expect(prisma.cancelledAt).toBe(cancelledAt);
  });

  it('reconcilia checkout PAID sem conceder entitlement pelo retorno', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription({
      providerCheckoutId: 'bill_test',
      providerCheckoutUrl: 'https://app.abacatepay.com/pay/bill_test',
      providerCheckoutStatus: 'PENDING',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: new Date(),
    });
    const provider = makeProvider({
      findCheckoutByExternalId: vi.fn(async () => ({
        ...checkoutFor(prisma.subscriptionRecord!.externalId),
        status: 'PAID' as const,
      })),
    });
    const service = makeService(prisma, provider);

    await expect(service.reconcileSubscription(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'pending_payment',
      accessAllowed: false,
      checkoutStatus: 'PAID',
    });
    expect(prisma.subscriptionRecord).toMatchObject({
      accessPaidThrough: null,
      lastSuccessfulPaymentAt: null,
      entitlementContractVersion: null,
    });
  });

  it('revogação por refund bloqueia nova cobrança até cancelamento externo confirmado', async () => {
    const prisma = new MemoryPaymentsPrisma();
    const revokedAt = new Date('2026-07-01T12:00:00.000Z');
    prisma.pendingPaymentExpiresAt = null;
    prisma.cancelledAt = revokedAt;
    prisma.purgeAfter = new Date(Date.now() + 86_400_000);
    prisma.seedSubscription({
      providerSubscriptionId: 'subs_still_active',
      providerStatus: 'ACTIVE',
      lastProviderEvent: 'checkout.refunded',
      cancelledAt: revokedAt,
      cancelledDueTo: 'provider_checkout_refunded',
    });
    const service = makeService(prisma, makeProvider());

    await expect(service.getSubscriptionSummary(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'cancelled',
      accessAllowed: false,
      providerStatus: 'ACTIVE',
      actions: { canCreateCheckout: false, canCancel: true },
    });
    await expect(service.createCheckout(ownerUser())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lookup REFUNDED revoga, não fecha como rotacionável e nunca cria segunda assinatura', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription({
      providerSubscriptionId: 'subs_still_active',
      providerCheckoutId: 'bill_test',
      providerCheckoutUrl: 'https://app.abacatepay.com/pay/bill_test',
      providerCheckoutStatus: 'PAID',
      providerStatus: 'ACTIVE',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: new Date(),
    });
    const provider = makeProvider({
      findCheckoutByExternalId: vi.fn(async () => ({
        ...checkoutFor(prisma.subscriptionRecord!.externalId),
        status: 'REFUNDED' as const,
      })),
    });
    const service = makeService(prisma, provider);

    await expect(service.reconcileSubscription(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'cancelled',
      accessAllowed: false,
      providerStatus: 'ACTIVE',
      checkoutStatus: 'REFUNDED',
      actions: { canCreateCheckout: false, canCancel: true },
    });
    expect(prisma.subscriptionRecord).toMatchObject({
      lastProviderEvent: 'checkout.reconciled_refunded',
      checkoutClosedAt: null,
      checkoutCreationAllowed: false,
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
    });
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        subscriptionId: prisma.subscriptionRecord!.id,
        familyId: prisma.familyId,
        providerCheckoutId: 'bill_test',
      },
      data: {
        providerStatus: 'REFUNDED',
        providerUpdatedAt: expect.any(Date),
      },
    });
    expect(prisma.cancelledAt).toBeInstanceOf(Date);
    expect(prisma.purgeAfter).toBeInstanceOf(Date);

    await expect(service.createCheckout(ownerUser())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(provider.createMonthlyCheckout).not.toHaveBeenCalled();
  });

  it('reconcilia CANCELLED após resultado ambíguo sem repetir o POST de cancelamento', async () => {
    const prisma = new MemoryPaymentsPrisma();
    prisma.seedSubscription({
      providerSubscriptionId: 'subs_cancel_ambiguous',
      providerCheckoutId: 'bill_test',
      providerCheckoutUrl: 'https://app.abacatepay.com/pay/bill_test',
      providerCheckoutStatus: 'PAID',
      providerStatus: 'ACTIVE',
      cancelRequestedAt: new Date('2026-08-01T10:00:00.000Z'),
      cancelLastErrorCode: 'PROVIDER_RESPONSE_REJECTED',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: new Date(),
    });
    const provider = makeProvider({
      findCheckoutByExternalId: vi.fn(async () => ({
        ...checkoutFor(prisma.subscriptionRecord!.externalId),
        status: 'CANCELLED' as const,
      })),
    });
    const service = makeService(prisma, provider);

    await expect(service.reconcileSubscription(ownerUser())).resolves.toMatchObject({
      effectiveStatus: 'cancelled',
      accessAllowed: false,
      providerStatus: 'CANCELLED',
      actions: { canCreateCheckout: true, canCancel: false },
    });
    expect(prisma.subscriptionRecord).toMatchObject({
      lastProviderEvent: 'subscription.reconciled_cancelled',
      cancelledDueTo: 'owner_requested',
      cancelClaimToken: null,
      cancelLastErrorCode: null,
    });
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it.each(['EXPIRED', 'CANCELLED'] as const)(
    'fecha %s pré-ativação antes da retenção, inclusive partindo de ambiguous',
    async (status) => {
      const now = new Date('2026-08-02T12:00:00.000Z');
      const prisma = new MemoryPaymentsPrisma();
      prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
      prisma.seedSubscription({
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
        checkoutCreationAllowed: false,
        checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
      });
      const provider = makeProvider({
        findCheckoutByExternalId: vi.fn(async () => {
          expect(prisma.$transaction).not.toHaveBeenCalled();
          return {
            ...checkoutFor(prisma.subscriptionRecord!.externalId),
            status,
          };
        }),
      });
      const service = makeService(prisma, provider);

      await expect(
        service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
      ).resolves.toBe(true);
      expect(provider.findCheckoutByExternalId).toHaveBeenCalledWith(
        prisma.subscriptionRecord!.externalId,
      );
      expect(prisma.subscriptionRecord).toMatchObject({
        providerCheckoutId: 'bill_test',
        providerCheckoutStatus: status,
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
        checkoutCreationAllowed: false,
        checkoutClaimToken: null,
        checkoutLockedAt: null,
        checkoutClosedAt: expect.any(Date),
        checkoutCloseReason: status,
        checkoutLastErrorCode: null,
      });
    },
  );

  it('reconcilia checkout local PENDING para terminal seguro antes do purge', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      providerCheckoutId: 'bill_test',
      providerCheckoutUrl: 'https://app.abacatepay.com/pay/bill_test',
      providerCheckoutStatus: 'PENDING',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutCreationAllowed: false,
      checkoutReadyAt: new Date('2026-08-01T12:00:00.000Z'),
    });
    const service = makeService(
      prisma,
      makeProvider({
        findCheckoutByExternalId: vi.fn(async () => ({
          ...checkoutFor(prisma.subscriptionRecord!.externalId),
          status: 'EXPIRED' as const,
        })),
      }),
    );

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).resolves.toBe(true);
    expect(prisma.subscriptionRecord).toMatchObject({
      providerCheckoutStatus: 'EXPIRED',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
      checkoutClosedAt: expect.any(Date),
      checkoutCloseReason: 'EXPIRED',
    });
  });

  it.each(['PENDING', 'PAID', 'REFUNDED'] as const)(
    'retém checkout remoto %s antes do purge',
    async (status) => {
      const now = new Date('2026-08-02T12:00:00.000Z');
      const prisma = new MemoryPaymentsPrisma();
      prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
      prisma.seedSubscription({
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
        checkoutCreationAllowed: false,
        checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
      });
      const service = makeService(
        prisma,
        makeProvider({
          findCheckoutByExternalId: vi.fn(async () => ({
            ...checkoutFor(prisma.subscriptionRecord!.externalId),
            status,
          })),
        }),
      );

      await expect(
        service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
      ).resolves.toBe(false);
      expect(prisma.subscriptionRecord).toMatchObject({
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
        checkoutClosedAt: null,
      });
    },
  );

  it('retém lookup vazio antes do purge', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
      checkoutCreationAllowed: false,
      checkoutClaimToken: 'in-flight-claim',
      checkoutLockedAt: new Date(now.getTime() - 1_000),
    });
    const service = makeService(prisma, makeProvider());

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).resolves.toBe(false);
    expect(prisma.subscriptionRecord?.checkoutClosedAt).toBeNull();
  });

  it('falha fechado e alerta mismatch de identidade antes do purge', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
    });
    const service = makeService(
      prisma,
      makeProvider({
        findCheckoutByExternalId: vi.fn(async () => ({
          ...checkoutFor(prisma.subscriptionRecord!.externalId),
          status: 'EXPIRED' as const,
          productId: 'prod_wrong',
        })),
      }),
    );

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).rejects.toThrow('RETENTION_CHECKOUT_IDENTITY_MISMATCH');
    expect(prisma.subscriptionRecord?.checkoutClosedAt).toBeNull();
  });

  it('falha fechado e alerta indisponibilidade do provider antes do purge', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
    });
    const service = makeService(
      prisma,
      makeProvider({
        findCheckoutByExternalId: vi.fn(async () => {
          throw new PaymentProviderError(
            'unavailable',
            'PROVIDER_UNAVAILABLE',
            'find_checkout',
          );
        }),
      }),
    );

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).rejects.toThrow('RETENTION_CHECKOUT_PROVIDER_UNAVAILABLE');
    expect(prisma.subscriptionRecord?.checkoutClosedAt).toBeNull();
  });

  it('não fecha terminal quando existe providerSubscription ou fato de ativação', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      providerSubscriptionId: 'subs_activation_evidence',
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
    });
    const service = makeService(
      prisma,
      makeProvider({
        findCheckoutByExternalId: vi.fn(async () => ({
          ...checkoutFor(prisma.subscriptionRecord!.externalId),
          status: 'EXPIRED' as const,
        })),
      }),
    );

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).rejects.toThrow('RETENTION_CHECKOUT_ACTIVATION_FACTS_PRESENT');
    expect(prisma.subscriptionRecord?.checkoutClosedAt).toBeNull();
  });

  it('relê sob lock e bloqueia corrida de ativação ocorrida depois do lookup', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const prisma = new MemoryPaymentsPrisma();
    prisma.pendingPaymentExpiresAt = new Date(now.getTime() - 1);
    prisma.seedSubscription({
      checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
      checkoutCreationAllowed: false,
      checkoutLastErrorCode: 'PREVIOUS_LOOKUP_AMBIGUOUS',
    });
    const service = makeService(
      prisma,
      makeProvider({
        findCheckoutByExternalId: vi.fn(async () => {
          prisma.subscriptionRecord!.providerSubscriptionId =
            'subs_created_concurrently';
          prisma.subscriptionRecord!.providerStatus = 'ACTIVE';
          return {
            ...checkoutFor(prisma.subscriptionRecord!.externalId),
            status: 'EXPIRED' as const,
          };
        }),
      }),
    );

    await expect(
      service.reconcileCheckoutBeforeRetention(prisma.familyId, now),
    ).rejects.toThrow('RETENTION_CHECKOUT_STATE_CHANGED');
    expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
      where: { id: prisma.subscriptionRecord!.id },
    });
    expect(prisma.subscriptionRecord).toMatchObject({
      providerSubscriptionId: 'subs_created_concurrently',
      providerStatus: 'ACTIVE',
      checkoutClosedAt: null,
    });
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
    PENDING_PAYMENT_TTL_DAYS: 7,
    RETENTION_CANCELLED_MONTHS: 12,
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
    cancelRequestedAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: null,
    entitlementContractVersion: null,
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
    cancelClaimToken: null,
    cancelLockedAt: null,
    cancelAttempts: 0,
    cancelLastErrorCode: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function matchesWhere(record: TestSubscription, where: Record<string, unknown>) {
  const comparableKeys = [
    'id',
    'familyId',
    'externalId',
    'providerCustomerId',
    'providerCheckoutUrl',
    'providerCheckoutStatus',
    'checkoutProvisioningStatus',
    'checkoutCreationAllowed',
    'checkoutClaimToken',
    'checkoutReadyAt',
    'checkoutLastErrorCode',
    'providerCheckoutId',
    'providerSubscriptionId',
    'providerStatus',
    'lastProviderEvent',
    'providerUpdatedAt',
    'lastSuccessfulPaymentAt',
    'accessPaidThrough',
    'paymentFailedAt',
    'graceUntil',
    'cancelledAt',
    'cancelRequestedAt',
    'cancelledDueTo',
    'lastInstallmentNumber',
    'entitlementContractVersion',
    'paymentMethod',
    'providerPaymentMethod',
  ] as const;
  for (const key of comparableKeys) {
    if (key in where && where[key] !== record[key]) return false;
  }
  if ('checkoutClosedAt' in where && where.checkoutClosedAt !== record.checkoutClosedAt) return false;
  if (
    where.checkoutLockedAt instanceof Date &&
    where.checkoutLockedAt !== record.checkoutLockedAt
  ) {
    return false;
  }
  if (isRecord(where.checkoutLockedAt) && where.checkoutLockedAt.lte instanceof Date) {
    if (!record.checkoutLockedAt || record.checkoutLockedAt > where.checkoutLockedAt.lte) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rawQueryError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('simulated raw query error', {
    code: 'P2010',
    clientVersion: '6.1.0',
    meta: { code: sqlState },
  });
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
