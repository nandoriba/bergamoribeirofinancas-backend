import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CheckoutProvisioningStatus,
  Prisma,
  SubscriptionCycle,
  type Subscription,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  PAYMENT_PROVIDER,
  PaymentProviderError,
  type PaymentCheckout,
  type PaymentCheckoutStatus,
  type PaymentProduct,
  type PaymentProvider,
} from './payment-provider';

const SERIALIZABLE_RETRIES = 3;
const MAX_CHECKOUT_ROTATIONS = 2;
const TERMINAL_CHECKOUT_STATUSES = new Set<PaymentCheckoutStatus>([
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);

export type EffectiveSubscriptionStatus =
  | 'pending_payment'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled';

export interface SubscriptionSummary {
  effectiveStatus: EffectiveSubscriptionStatus;
  plan: {
    name: string;
    amountCents: number;
    currency: 'BRL';
    billingCycle: 'MONTHLY';
    methods: ['CARD'];
  };
  pendingPaymentExpiresAt?: string;
  checkoutStatus: PaymentCheckoutStatus | null;
  actions: {
    canCreateCheckout: boolean;
    canCancel: boolean;
  };
}

interface RuntimePaymentConfig {
  enabled: boolean;
  expectedDevMode: boolean;
  productId: string;
  amountCents: number;
  planName: string;
  returnUrl: string;
  completionUrl: string;
  retryMax: number;
  retryEveryDays: number;
  lockSeconds: number;
}

interface CheckoutClaim {
  subscription: Subscription;
  claimToken: string;
  creationAllowed: boolean;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async getSubscriptionSummary(user: AuthenticatedUser): Promise<SubscriptionSummary> {
    const runtime = this.runtimeConfig(true);
    const family = await this.prisma.family.findUnique({
      where: { id: user.familyId },
      select: {
        ownerUserId: true,
        pendingPaymentExpiresAt: true,
        subscriptions: {
          where: { cancelledAt: null, checkoutClosedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { providerCheckoutStatus: true },
        },
      },
    });
    if (!family) throw new ForbiddenException('Tenant indisponível.');
    if (!family.pendingPaymentExpiresAt) {
      throw this.paymentsUnavailable('SUBSCRIPTION_POLICY_NOT_AVAILABLE');
    }

    const pendingStillValid = Boolean(
      family.pendingPaymentExpiresAt && family.pendingPaymentExpiresAt > new Date(),
    );

    return {
      effectiveStatus: 'pending_payment',
      plan: this.publicPlan(runtime),
      ...(family.pendingPaymentExpiresAt
        ? { pendingPaymentExpiresAt: family.pendingPaymentExpiresAt.toISOString() }
        : {}),
      checkoutStatus: asCheckoutStatus(
        family.subscriptions[0]?.providerCheckoutStatus ?? null,
      ),
      actions: {
        canCreateCheckout:
          runtime.enabled &&
          pendingStillValid &&
          family.ownerUserId === user.id &&
          user.tenantRole === 'owner',
        canCancel: false,
      },
    };
  }

  async createCheckout(user: AuthenticatedUser): Promise<{ checkoutUrl: string }> {
    const runtime = this.runtimeConfig(true);
    if (user.tenantRole !== 'owner' || user.requiredAction !== 'payment') {
      throw new ForbiddenException('Somente o owner com pagamento pendente pode iniciar o checkout.');
    }
    const product = await this.loadAndValidateProduct(runtime);

    for (let rotation = 0; rotation < MAX_CHECKOUT_ROTATIONS; rotation += 1) {
      const subscription = await this.reserveOpenSubscription(user, runtime);

      if (subscription.checkoutProvisioningStatus === CheckoutProvisioningStatus.ready) {
        const ready = await this.reconcileReadyCheckout(subscription, runtime);
        if (ready) return { checkoutUrl: ready.url };
        continue;
      }

      const claim = await this.acquireCheckoutClaim(subscription, runtime);
      const checkout = await this.provisionClaimedCheckout(claim, runtime, product);
      if (TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) {
        await this.closeTerminalCheckout(claim.subscription.id, checkout);
        continue;
      }
      return { checkoutUrl: checkout.url };
    }

    throw this.paymentsUnavailable('CHECKOUT_ROTATION_LIMIT');
  }

  private async reserveOpenSubscription(
    user: AuthenticatedUser,
    runtime: RuntimePaymentConfig,
  ): Promise<Subscription> {
    return this.withSerializableRetry(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${user.familyId} FOR UPDATE
      `;
      const [family, account] = await Promise.all([
        tx.family.findUnique({
          where: { id: user.familyId },
          select: { ownerUserId: true, pendingPaymentExpiresAt: true },
        }),
        tx.user.findUnique({
          where: { id: user.id },
          select: { familyId: true, isActive: true, emailVerifiedAt: true },
        }),
      ]);
      const now = new Date();
      if (
        !family ||
        family.ownerUserId !== user.id ||
        !account?.isActive ||
        account.familyId !== user.familyId ||
        !account.emailVerifiedAt ||
        !family.pendingPaymentExpiresAt ||
        family.pendingPaymentExpiresAt <= now
      ) {
        throw new ForbiddenException('O cadastro não está elegível para checkout.');
      }

      const existing = await tx.subscription.findFirst({
        where: {
          familyId: user.familyId,
          cancelledAt: null,
          checkoutClosedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        this.assertLocalSubscriptionIdentity(existing, runtime);
        return existing;
      }

      return tx.subscription.create({
        data: {
          id: randomUUID(),
          familyId: user.familyId,
          externalId: `local_${randomUUID()}`,
          providerProductId: runtime.productId,
          amountCents: runtime.amountCents,
          currency: 'BRL',
          billingCycle: SubscriptionCycle.MONTHLY,
          devMode: runtime.expectedDevMode,
        },
      });
    });
  }

  private async reconcileReadyCheckout(
    subscription: Subscription,
    runtime: RuntimePaymentConfig,
  ): Promise<PaymentCheckout | null> {
    let checkout: PaymentCheckout | null;
    try {
      checkout = await this.provider.findCheckoutByExternalId(subscription.externalId);
    } catch (error) {
      const providerError = paymentProviderError(error);
      if (providerError?.kind !== 'unavailable') {
        throw this.paymentsUnavailable('CHECKOUT_LOOKUP_INVALID');
      }
      if (!subscription.providerCheckoutUrl) throw this.paymentsUnavailable('CHECKOUT_LOOKUP_FAILED');
      const local = localReadyCheckout(subscription);
      if (TERMINAL_CHECKOUT_STATUSES.has(local.status)) {
        await this.closeTerminalCheckout(subscription.id, local);
        return null;
      }
      return local;
    }

    if (!checkout) throw this.paymentsUnavailable('READY_CHECKOUT_NOT_FOUND');
    this.assertCheckoutIdentity(checkout, subscription, runtime);
    if (TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) {
      await this.closeTerminalCheckout(subscription.id, checkout);
      return null;
    }

    const refreshed = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        providerCheckoutId: checkout.id,
        checkoutClosedAt: null,
      },
      data: { providerCheckoutStatus: checkout.status },
    });
    if (refreshed.count !== 1) throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
    return checkout;
  }

  private async acquireCheckoutClaim(
    subscription: Subscription,
    runtime: RuntimePaymentConfig,
  ): Promise<CheckoutClaim> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - runtime.lockSeconds * 1_000);
    if (
      subscription.checkoutProvisioningStatus === CheckoutProvisioningStatus.processing &&
      (!subscription.checkoutLockedAt || subscription.checkoutLockedAt > staleBefore)
    ) {
      throw new ConflictException({
        code: 'CHECKOUT_IN_PROGRESS',
        message: 'O checkout já está sendo preparado.',
      });
    }

    const claimToken = randomUUID();
    const claimed = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        checkoutProvisioningStatus: subscription.checkoutProvisioningStatus,
        checkoutCreationAllowed: subscription.checkoutCreationAllowed,
        ...(subscription.checkoutProvisioningStatus === CheckoutProvisioningStatus.processing
          ? { checkoutLockedAt: { lte: staleBefore } }
          : {}),
      },
      data: {
        checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
        checkoutClaimToken: claimToken,
        checkoutLockedAt: now,
        checkoutLastErrorCode: null,
        checkoutAttempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: 'CHECKOUT_IN_PROGRESS',
        message: 'O checkout já está sendo preparado.',
      });
    }

    return {
      subscription: { ...subscription, checkoutClaimToken: claimToken, checkoutLockedAt: now },
      claimToken,
      creationAllowed: subscription.checkoutCreationAllowed,
    };
  }

  private async provisionClaimedCheckout(
    claim: CheckoutClaim,
    runtime: RuntimePaymentConfig,
    _product: PaymentProduct,
  ): Promise<PaymentCheckout> {
    let existing: PaymentCheckout | null;
    try {
      existing = await this.provider.findCheckoutByExternalId(claim.subscription.externalId);
    } catch (error) {
      const providerError = paymentProviderError(error);
      const mustReconcile =
        !claim.creationAllowed ||
        providerError?.kind === 'ambiguous' ||
        providerError?.code === 'DUPLICATE_EXTERNAL_ID' ||
        providerError?.code === 'CHECKOUT_LOOKUP_TRUNCATED';
      await this.finishClaimWithError(
        claim,
        mustReconcile ? CheckoutProvisioningStatus.ambiguous : CheckoutProvisioningStatus.failed,
        !mustReconcile,
        providerError?.code ?? 'CHECKOUT_LOOKUP_FAILED',
      );
      throw this.paymentsUnavailable(
        mustReconcile ? 'CHECKOUT_RECONCILIATION_REQUIRED' : 'CHECKOUT_LOOKUP_FAILED',
      );
    }

    if (existing) {
      try {
        this.assertCheckoutIdentity(existing, claim.subscription, runtime);
        await this.completeCheckoutClaim(claim, existing);
        return existing;
      } catch {
        await this.finishClaimWithError(
          claim,
          CheckoutProvisioningStatus.ambiguous,
          false,
          'CHECKOUT_RECONCILIATION_MISMATCH',
        );
        throw this.paymentsUnavailable('CHECKOUT_RECONCILIATION_REQUIRED');
      }
    }

    if (!claim.creationAllowed) {
      await this.finishClaimWithError(
        claim,
        CheckoutProvisioningStatus.ambiguous,
        false,
        'CHECKOUT_RECONCILIATION_REQUIRED',
      );
      throw this.paymentsUnavailable('CHECKOUT_RECONCILIATION_REQUIRED');
    }

    const marked = await this.prisma.subscription.updateMany({
      where: {
        id: claim.subscription.id,
        checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
        checkoutClaimToken: claim.claimToken,
      },
      data: { checkoutCreationAllowed: false },
    });
    if (marked.count !== 1) throw this.paymentsUnavailable('CHECKOUT_CLAIM_LOST');

    let created: PaymentCheckout;
    try {
      created = await this.provider.createMonthlyCheckout({
        productId: runtime.productId,
        externalId: claim.subscription.externalId,
        metadata: {
          localReference: claim.subscription.externalId,
          billingCycle: 'MONTHLY',
        },
        returnUrl: runtime.returnUrl,
        completionUrl: runtime.completionUrl,
        retryPolicy: {
          maxRetries: runtime.retryMax,
          intervalDays: runtime.retryEveryDays,
        },
      });
    } catch (error) {
      const providerError = paymentProviderError(error);
      const deterministicRejection = providerError?.kind === 'rejected';
      await this.finishClaimWithError(
        claim,
        deterministicRejection
          ? CheckoutProvisioningStatus.failed
          : CheckoutProvisioningStatus.ambiguous,
        deterministicRejection,
        providerError?.code ?? 'CHECKOUT_OUTCOME_UNKNOWN',
      );
      throw this.paymentsUnavailable(
        deterministicRejection ? 'CHECKOUT_REJECTED' : 'CHECKOUT_RECONCILIATION_REQUIRED',
      );
    }

    try {
      this.assertCheckoutIdentity(created, claim.subscription, runtime);
      if (created.status !== 'PENDING') {
        throw new Error('A newly created checkout must be pending.');
      }
      await this.completeCheckoutClaim(claim, created);
      return created;
    } catch {
      await this.finishClaimWithError(
        claim,
        CheckoutProvisioningStatus.ambiguous,
        false,
        'CHECKOUT_RESPONSE_MISMATCH',
      );
      throw this.paymentsUnavailable('CHECKOUT_RECONCILIATION_REQUIRED');
    }
  }

  private async completeCheckoutClaim(
    claim: CheckoutClaim,
    checkout: PaymentCheckout,
  ): Promise<void> {
    const readyAt = new Date();
    const completed = await this.prisma.subscription.updateMany({
      where: {
        id: claim.subscription.id,
        checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
        checkoutClaimToken: claim.claimToken,
      },
      data: {
        checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
        checkoutCreationAllowed: false,
        providerCheckoutId: checkout.id,
        providerCheckoutUrl: checkout.url,
        providerCheckoutStatus: checkout.status,
        ...(checkout.customerId ? { providerCustomerId: checkout.customerId } : {}),
        checkoutReadyAt: readyAt,
        checkoutClaimToken: null,
        checkoutLockedAt: null,
        checkoutLastErrorCode: null,
      },
    });
    if (completed.count !== 1) throw new Error('Checkout claim was lost.');
  }

  private async finishClaimWithError(
    claim: CheckoutClaim,
    status: 'failed' | 'ambiguous',
    creationAllowed: boolean,
    code: string,
  ): Promise<void> {
    const finished = await this.prisma.subscription.updateMany({
      where: {
        id: claim.subscription.id,
        checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
        checkoutClaimToken: claim.claimToken,
      },
      data: {
        checkoutProvisioningStatus: status,
        checkoutCreationAllowed: creationAllowed,
        checkoutClaimToken: null,
        checkoutLockedAt: null,
        checkoutLastErrorCode: code.slice(0, 120),
      },
    });
    if (finished.count !== 1) throw new Error('Checkout claim was lost.');
  }

  private async closeTerminalCheckout(
    subscriptionId: string,
    checkout: PaymentCheckout,
  ): Promise<void> {
    if (!TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) return;
    await this.prisma.subscription.updateMany({
      where: {
        id: subscriptionId,
        providerCheckoutId: checkout.id,
        checkoutClosedAt: null,
      },
      data: {
        providerCheckoutStatus: checkout.status,
        checkoutClosedAt: new Date(),
        checkoutCloseReason: checkout.status,
      },
    });
  }

  private async loadAndValidateProduct(runtime: RuntimePaymentConfig): Promise<PaymentProduct> {
    let product: PaymentProduct;
    try {
      product = await this.provider.getProduct(runtime.productId);
    } catch {
      throw this.paymentsUnavailable('PAYMENT_PRODUCT_UNAVAILABLE');
    }

    if (
      product.id !== runtime.productId ||
      product.status !== 'ACTIVE' ||
      product.cycle !== 'MONTHLY' ||
      product.currency !== 'BRL' ||
      product.priceCents !== runtime.amountCents ||
      product.devMode !== runtime.expectedDevMode ||
      (product.trialDays !== null && product.trialDays !== 0)
    ) {
      throw this.paymentsUnavailable('PAYMENT_PRODUCT_INVALID');
    }
    return product;
  }

  private assertLocalSubscriptionIdentity(
    subscription: Subscription,
    runtime: RuntimePaymentConfig,
  ): void {
    if (
      subscription.provider !== 'abacatepay' ||
      subscription.providerProductId !== runtime.productId ||
      subscription.amountCents !== runtime.amountCents ||
      subscription.currency !== 'BRL' ||
      subscription.billingCycle !== SubscriptionCycle.MONTHLY ||
      subscription.devMode !== runtime.expectedDevMode
    ) {
      throw this.paymentsUnavailable('LOCAL_SUBSCRIPTION_MISMATCH');
    }
  }

  private assertCheckoutIdentity(
    checkout: PaymentCheckout,
    subscription: Subscription,
    runtime: RuntimePaymentConfig,
  ): void {
    if (
      checkout.externalId !== subscription.externalId ||
      checkout.productId !== runtime.productId ||
      checkout.quantity !== 1 ||
      checkout.amountCents !== runtime.amountCents ||
      checkout.currency !== 'BRL' ||
      checkout.devMode !== runtime.expectedDevMode ||
      (subscription.providerCheckoutId && subscription.providerCheckoutId !== checkout.id)
    ) {
      throw this.paymentsUnavailable('PROVIDER_CHECKOUT_MISMATCH');
    }
  }

  private runtimeConfig(requireEnabled: boolean): RuntimePaymentConfig {
    const enabled = this.config.get<boolean>('ABACATEPAY_ENABLED') ?? false;
    if (requireEnabled && !enabled) throw this.paymentsUnavailable('PAYMENTS_DISABLED');
    const production = this.config.get<string>('NODE_ENV') === 'production';
    const productId =
      this.config.get<string>(
        production
          ? 'ABACATEPAY_PROD_MONTHLY_PRODUCT_ID'
          : 'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID',
      ) ?? '';
    const amountCents = this.config.get<number>('ABACATEPAY_MONTHLY_AMOUNT_CENTS') ?? 0;
    const firstWebOrigin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://127.0.0.1:8181')
      .split(',')[0]
      ?.trim();
    if ((enabled || requireEnabled) && (!productId || amountCents <= 0 || !firstWebOrigin)) {
      throw this.paymentsUnavailable('PAYMENTS_CONFIGURATION_INVALID');
    }

    return {
      enabled,
      expectedDevMode: !production,
      productId,
      amountCents,
      planName: this.config.get<string>('ABACATEPAY_PLAN_NAME') ?? 'Plano familiar',
      returnUrl: new URL('/pagamento/pendente', firstWebOrigin).toString(),
      completionUrl: new URL('/pagamento/sucesso', firstWebOrigin).toString(),
      retryMax: this.config.get<number>('ABACATEPAY_RETRY_MAX') ?? 3,
      retryEveryDays: this.config.get<number>('ABACATEPAY_RETRY_EVERY_DAYS') ?? 2,
      lockSeconds: this.config.get<number>('ABACATEPAY_CHECKOUT_LOCK_SECONDS') ?? 90,
    };
  }

  private publicPlan(runtime: RuntimePaymentConfig): SubscriptionSummary['plan'] {
    return {
      name: runtime.planName,
      amountCents: runtime.amountCents,
      currency: 'BRL',
      billingCycle: 'MONTHLY',
      methods: ['CARD'],
    };
  }

  private paymentsUnavailable(code: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code,
      message: 'A cobrança está temporariamente indisponível. Tente novamente mais tarde.',
    });
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < SERIALIZABLE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Serializable retry budget exhausted.');
  }
}

function paymentProviderError(error: unknown): PaymentProviderError | undefined {
  return error instanceof PaymentProviderError ? error : undefined;
}

function asCheckoutStatus(value: string | null): PaymentCheckoutStatus | null {
  return value && ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'].includes(value)
    ? (value as PaymentCheckoutStatus)
    : null;
}

function localReadyCheckout(subscription: Subscription): PaymentCheckout {
  const status = asCheckoutStatus(subscription.providerCheckoutStatus);
  if (!subscription.providerCheckoutId || !subscription.providerCheckoutUrl || !status) {
    throw new Error('Invalid ready checkout state.');
  }
  return {
    id: subscription.providerCheckoutId,
    externalId: subscription.externalId,
    url: subscription.providerCheckoutUrl,
    amountCents: subscription.amountCents,
    currency: 'BRL',
    status,
    customerId: subscription.providerCustomerId,
    productId: subscription.providerProductId,
    quantity: 1,
    devMode: subscription.devMode,
  };
}
