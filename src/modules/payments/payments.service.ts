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
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from './subscription-access.projection';
import { addUtcMonthsClamped } from './subscription-cancellation.service';

const SERIALIZABLE_RETRIES = 3;
const MAX_CHECKOUT_ROTATIONS = 2;
const TERMINAL_CHECKOUT_STATUSES = new Set<PaymentCheckoutStatus>([
  'EXPIRED',
  'CANCELLED',
]);
const PROVIDER_RISK_EVENTS = new Set([
  'checkout.refunded',
  'checkout.disputed',
  'checkout.reconciled_refunded',
]);

export type EffectiveSubscriptionStatus =
  | 'pending_payment'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled';

export interface SubscriptionSummary {
  effectiveStatus: EffectiveSubscriptionStatus;
  accessAllowed: boolean;
  reason: string;
  serverTime: string;
  plan: {
    name: string;
    amountCents: number;
    currency: 'BRL';
    billingCycle: 'MONTHLY';
    methods: ['CARD'];
  };
  pendingPaymentExpiresAt?: string;
  purgeAfter?: string;
  accessPaidThrough?: string;
  graceUntil?: string;
  cancelledAt?: string;
  providerStatus?: string;
  lastProviderEvent?: string;
  checkoutStatus: PaymentCheckoutStatus | null;
  history: Array<{
    id: string;
    eventType: 'payment';
    occurredAt: string;
    status: string;
    amountCents: number;
    currency: string;
  }>;
  actions: {
    canCreateCheckout: boolean;
    canCancel: boolean;
    canReconcile: boolean;
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
  pendingRetentionDays: number;
  retentionMonths: number;
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
    const runtime = this.runtimeConfig(false);
    const now = new Date();
    const family = await this.prisma.family.findUnique({
      where: { id: user.familyId },
      select: {
        ownerUserId: true,
        pendingPaymentExpiresAt: true,
        purgeAfter: true,
        currentSubscription: {
          select: {
            ...SUBSCRIPTION_ACCESS_SELECT,
            id: true,
            providerSubscriptionId: true,
            providerCheckoutStatus: true,
            externalId: true,
            checkoutProvisioningStatus: true,
            checkoutCreationAllowed: true,
            checkoutClosedAt: true,
            cancelLastErrorCode: true,
            payments: {
              orderBy: [{ providerUpdatedAt: 'desc' }, { createdAt: 'desc' }],
              take: 24,
              select: {
                id: true,
                providerStatus: true,
                amountCents: true,
                currency: true,
                paidAt: true,
                failedAt: true,
                providerUpdatedAt: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!family) throw new ForbiddenException('Tenant indisponível.');
    const subscription = family.currentSubscription;
    const decision = evaluateSubscriptionProjection(subscription, () => now);
    const pendingStillValid = Boolean(
      family.pendingPaymentExpiresAt && family.pendingPaymentExpiresAt > now,
    );
    const cancelledStillRetained = Boolean(family.purgeAfter && family.purgeAfter > now);
    const isOwner = family.ownerUserId === user.id && user.tenantRole === 'owner';
    const canStartAgain =
      (decision.effectiveStatus === 'pending_payment' && pendingStillValid) ||
      (decision.effectiveStatus === 'cancelled' &&
        cancelledStillRetained &&
        providerCancellationConfirmed(subscription));

    return {
      ...decision,
      serverTime: now.toISOString(),
      plan: this.publicPlan(runtime),
      ...(family.pendingPaymentExpiresAt
        ? { pendingPaymentExpiresAt: family.pendingPaymentExpiresAt.toISOString() }
        : {}),
      ...(family.purgeAfter ? { purgeAfter: family.purgeAfter.toISOString() } : {}),
      ...(subscription?.accessPaidThrough
        ? { accessPaidThrough: subscription.accessPaidThrough.toISOString() }
        : {}),
      ...(subscription?.graceUntil
        ? { graceUntil: subscription.graceUntil.toISOString() }
        : {}),
      ...(subscription?.cancelledAt
        ? { cancelledAt: subscription.cancelledAt.toISOString() }
        : {}),
      ...(subscription?.providerStatus
        ? { providerStatus: subscription.providerStatus }
        : {}),
      ...(subscription?.lastProviderEvent
        ? { lastProviderEvent: subscription.lastProviderEvent }
        : {}),
      checkoutStatus: asCheckoutStatus(
        subscription?.providerCheckoutStatus ?? null,
      ),
      history: (subscription?.payments ?? []).map((payment) => ({
        id: payment.id,
        eventType: 'payment' as const,
        occurredAt: paymentHistoryTimestamp(payment).toISOString(),
        status: payment.providerStatus,
        amountCents: payment.amountCents,
        currency: payment.currency,
      })),
      actions: {
        canCreateCheckout: runtime.enabled && isOwner && canStartAgain,
        canCancel:
          runtime.enabled &&
          isOwner &&
          (decision.accessAllowed || providerRiskRevocation(subscription)) &&
          Boolean(subscription?.providerSubscriptionId) &&
          !providerCancellationConfirmed(subscription) &&
          !subscription?.cancelRequestedAt,
        canReconcile:
          runtime.enabled &&
          isOwner &&
          Boolean(subscription) &&
          (Boolean(subscription?.cancelRequestedAt) ||
            subscription?.checkoutProvisioningStatus === CheckoutProvisioningStatus.ambiguous ||
            subscription?.checkoutProvisioningStatus === CheckoutProvisioningStatus.processing ||
            Boolean(subscription?.providerCheckoutStatus)),
      },
    };
  }

  async createCheckout(user: AuthenticatedUser): Promise<{ checkoutUrl: string }> {
    const runtime = this.runtimeConfig(true);
    if (user.tenantRole !== 'owner') {
      throw new ForbiddenException('Somente o owner pode iniciar o checkout.');
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
      if (checkout.status === 'REFUNDED') {
        await this.recordReconciledRefund(claim.subscription, checkout, runtime);
        throw this.paymentsUnavailable('SUBSCRIPTION_CANCELLATION_REQUIRED');
      }
      if (TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) {
        if (!isSafePreActivationTerminal(claim.subscription, checkout)) {
          throw this.paymentsUnavailable('CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION');
        }
        await this.closeTerminalCheckout(claim.subscription, checkout, runtime);
        continue;
      }
      return { checkoutUrl: checkout.url };
    }

    throw this.paymentsUnavailable('CHECKOUT_ROTATION_LIMIT');
  }

  async reconcileSubscription(user: AuthenticatedUser): Promise<SubscriptionSummary> {
    if (user.tenantRole !== 'owner') {
      throw new ForbiddenException('Somente o owner pode reconciliar a assinatura.');
    }
    const runtime = this.runtimeConfig(true);
    const family = await this.prisma.family.findUnique({
      where: { id: user.familyId },
      select: { ownerUserId: true, currentSubscription: true },
    });
    const subscription = family?.currentSubscription;
    if (!family || family.ownerUserId !== user.id || !subscription) {
      throw new ForbiddenException('A assinatura atual não está disponível para reconciliação.');
    }

    let checkout: PaymentCheckout | null;
    try {
      checkout = await this.provider.findCheckoutByExternalId(subscription.externalId);
    } catch {
      throw this.paymentsUnavailable('CHECKOUT_RECONCILIATION_FAILED');
    }

    if (checkout) {
      this.assertCheckoutIdentity(checkout, subscription, runtime);
      if (checkout.status === 'REFUNDED') {
        await this.recordReconciledRefund(subscription, checkout, runtime);
      } else if (checkout.status === 'CANCELLED' && subscription.providerSubscriptionId) {
        await this.confirmReconciledCancellation(user, subscription, checkout, runtime);
      } else if (TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) {
        if (!isSafePreActivationTerminal(subscription, checkout)) {
          throw this.paymentsUnavailable('CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION');
        }
        await this.closeTerminalCheckout(subscription, checkout, runtime);
      } else {
        const updated = await this.prisma.subscription.updateMany({
          where: {
            id: subscription.id,
            familyId: user.familyId,
            cancelledAt: null,
          },
          data: {
            providerCheckoutId: checkout.id,
            providerCheckoutUrl: checkout.url,
            providerCheckoutStatus: checkout.status,
            ...(checkout.customerId ? { providerCustomerId: checkout.customerId } : {}),
            checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
            checkoutCreationAllowed: false,
            checkoutReadyAt: new Date(),
            checkoutClaimToken: null,
            checkoutLockedAt: null,
            checkoutLastErrorCode: null,
          },
        });
        if (updated.count !== 1) throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
      }
    }

    return this.getSubscriptionSummary(user);
  }

  /**
   * Reconciles only provider states that can make an expired pending-payment
   * tenant safe to purge. The provider lookup deliberately happens before the
   * short database transaction used by closeTerminalCheckout.
   */
  async reconcileCheckoutBeforeRetention(
    familyId: string,
    now = new Date(),
  ): Promise<boolean> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError('A valid retention reconciliation clock is required.');
    }

    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: {
        pendingPaymentExpiresAt: true,
        cancelledAt: true,
        currentSubscription: true,
      },
    });
    const subscription = family?.currentSubscription;
    if (
      !family ||
      family.cancelledAt !== null ||
      !family.pendingPaymentExpiresAt ||
      family.pendingPaymentExpiresAt > now ||
      !subscription ||
      evaluateSubscriptionProjection(subscription, () => now).effectiveStatus !==
        'pending_payment' ||
      !requiresPrePurgeCheckoutLookup(subscription)
    ) {
      return false;
    }

    let runtime: RuntimePaymentConfig;
    try {
      runtime = this.runtimeConfig(true);
    } catch {
      throw new Error('RETENTION_CHECKOUT_PROVIDER_CONFIGURATION_INVALID');
    }

    let checkout: PaymentCheckout | null;
    try {
      checkout = await this.provider.findCheckoutByExternalId(
        subscription.externalId,
      );
    } catch {
      throw new Error('RETENTION_CHECKOUT_PROVIDER_UNAVAILABLE');
    }
    if (!checkout) return false;

    try {
      this.assertCheckoutIdentity(checkout, subscription, runtime);
    } catch {
      throw new Error('RETENTION_CHECKOUT_IDENTITY_MISMATCH');
    }
    if (!TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) return false;
    if (!isSafePreActivationTerminal(subscription, checkout)) {
      throw new Error('RETENTION_CHECKOUT_ACTIVATION_FACTS_PRESENT');
    }

    try {
      await this.closeTerminalCheckout(subscription, checkout, runtime);
    } catch {
      throw new Error('RETENTION_CHECKOUT_STATE_CHANGED');
    }
    return true;
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
          select: {
            ownerUserId: true,
            pendingPaymentExpiresAt: true,
            cancelledAt: true,
            purgeAfter: true,
            currentSubscriptionId: true,
            currentSubscription: true,
          },
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
        user.tenantRole !== 'owner'
      ) {
        throw new ForbiddenException('O cadastro não está elegível para checkout.');
      }

      const decision = evaluateSubscriptionProjection(family.currentSubscription, () => now);
      const pendingEligible =
        decision.effectiveStatus === 'pending_payment' &&
        family.pendingPaymentExpiresAt !== null &&
        family.pendingPaymentExpiresAt > now;
      const cancelledEligible =
        decision.effectiveStatus === 'cancelled' &&
        family.purgeAfter !== null &&
        family.purgeAfter > now &&
        providerCancellationConfirmed(family.currentSubscription);
      if (!pendingEligible && !cancelledEligible) {
        throw new ForbiddenException('O cadastro não está elegível para checkout.');
      }

      const existing = family.currentSubscription;
      if (existing && !existing.cancelledAt && !existing.checkoutClosedAt) {
        this.assertLocalSubscriptionIdentity(existing, runtime);
        return existing;
      }

      if (!family.currentSubscriptionId) {
        const orphanOpen = await tx.subscription.findFirst({
          where: {
            familyId: user.familyId,
            cancelledAt: null,
            checkoutClosedAt: null,
          },
          select: { id: true },
        });
        if (orphanOpen) throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_MISSING');
      }

      const created = await tx.subscription.create({
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
      const nextPendingExpiry = cancelledEligible
        ? new Date(now.getTime() + runtime.pendingRetentionDays * 86_400_000)
        : family.pendingPaymentExpiresAt;
      const pointed = await tx.family.updateMany({
        where: {
          id: user.familyId,
          ownerUserId: user.id,
          currentSubscriptionId: family.currentSubscriptionId,
        },
        data: {
          currentSubscriptionId: created.id,
          pendingPaymentExpiresAt: nextPendingExpiry,
        },
      });
      if (pointed.count !== 1) throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_CHANGED');
      return created;
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
      if (local.status === 'REFUNDED') {
        await this.recordReconciledRefund(subscription, local, runtime);
        throw this.paymentsUnavailable('SUBSCRIPTION_CANCELLATION_REQUIRED');
      }
      if (TERMINAL_CHECKOUT_STATUSES.has(local.status)) {
        if (!isSafePreActivationTerminal(subscription, local)) {
          throw this.paymentsUnavailable('CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION');
        }
        await this.closeTerminalCheckout(subscription, local, runtime);
        return null;
      }
      return local;
    }

    if (!checkout) throw this.paymentsUnavailable('READY_CHECKOUT_NOT_FOUND');
    this.assertCheckoutIdentity(checkout, subscription, runtime);
    if (checkout.status === 'REFUNDED') {
      await this.recordReconciledRefund(subscription, checkout, runtime);
      throw this.paymentsUnavailable('SUBSCRIPTION_CANCELLATION_REQUIRED');
    }
    if (TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) {
      if (!isSafePreActivationTerminal(subscription, checkout)) {
        throw this.paymentsUnavailable('CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION');
      }
      await this.closeTerminalCheckout(subscription, checkout, runtime);
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

  private async recordReconciledRefund(
    subscription: Subscription,
    checkout: PaymentCheckout,
    runtime: RuntimePaymentConfig,
  ): Promise<void> {
    const observedAt = new Date();
    await this.withSerializableRetry(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${subscription.familyId} FOR UPDATE
      `;
      const [current, family] = await Promise.all([
        tx.subscription.findUnique({ where: { id: subscription.id } }),
        tx.family.findUnique({
          where: { id: subscription.familyId },
          select: {
            currentSubscriptionId: true,
            cancelledAt: true,
            purgeAfter: true,
          },
        }),
      ]);
      if (!current || !family || family.currentSubscriptionId !== current.id) {
        throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_CHANGED');
      }
      if ((family.cancelledAt === null) !== (family.purgeAfter === null)) {
        throw this.paymentsUnavailable('RETENTION_STATE_INVALID');
      }

      await tx.subscriptionPayment.updateMany({
        where: {
          subscriptionId: current.id,
          familyId: current.familyId,
          providerCheckoutId: checkout.id,
        },
        data: {
          providerStatus: 'REFUNDED',
          providerUpdatedAt: observedAt,
        },
      });

      const cancellationConfirmed = providerCancellationConfirmed(current);
      const alreadyRiskRevoked = providerRiskRevocation(current);
      const cancelledAt = current.cancelledAt ?? observedAt;
      const purgeAfter =
        family.purgeAfter ?? addUtcMonthsClamped(cancelledAt, runtime.retentionMonths);
      const updated = await tx.subscription.updateMany({
        where: {
          id: current.id,
          familyId: current.familyId,
          providerCheckoutId: current.providerCheckoutId,
        },
        data: {
          providerCheckoutId: checkout.id,
          providerCheckoutUrl: checkout.url,
          providerCheckoutStatus: checkout.status,
          ...(checkout.customerId ? { providerCustomerId: checkout.customerId } : {}),
          ...(!cancellationConfirmed
            ? {
                lastProviderEvent: alreadyRiskRevoked
                  ? current.lastProviderEvent
                  : 'checkout.reconciled_refunded',
                cancelledAt,
                cancelledDueTo: current.cancelledDueTo ?? 'provider_checkout_refunded',
                checkoutProvisioningStatus: CheckoutProvisioningStatus.ambiguous,
                checkoutCreationAllowed: false,
                checkoutClosedAt: null,
                checkoutCloseReason: null,
                checkoutClaimToken: null,
                checkoutLockedAt: null,
                checkoutLastErrorCode: 'PROVIDER_REFUND_REQUIRES_CANCELLATION',
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
      }

      if (!cancellationConfirmed && family.cancelledAt === null) {
        const familyUpdated = await tx.family.updateMany({
          where: {
            id: subscription.familyId,
            currentSubscriptionId: current.id,
            cancelledAt: null,
            purgeAfter: null,
          },
          data: {
            pendingPaymentExpiresAt: null,
            cancelledAt,
            purgeAfter,
          },
        });
        if (familyUpdated.count !== 1) {
          throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_CHANGED');
        }
      }
    });
  }

  private async confirmReconciledCancellation(
    user: AuthenticatedUser,
    subscription: Subscription,
    checkout: PaymentCheckout,
    runtime: RuntimePaymentConfig,
  ): Promise<void> {
    const observedAt = new Date();
    await this.withSerializableRetry(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${user.familyId} FOR UPDATE
      `;
      const [current, family] = await Promise.all([
        tx.subscription.findUnique({ where: { id: subscription.id } }),
        tx.family.findUnique({
          where: { id: user.familyId },
          select: {
            ownerUserId: true,
            currentSubscriptionId: true,
            cancelledAt: true,
            purgeAfter: true,
          },
        }),
      ]);
      if (
        !current ||
        !family ||
        family.ownerUserId !== user.id ||
        family.currentSubscriptionId !== current.id ||
        current.providerSubscriptionId !== subscription.providerSubscriptionId
      ) {
        throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_CHANGED');
      }
      if ((family.cancelledAt === null) !== (family.purgeAfter === null)) {
        throw this.paymentsUnavailable('RETENTION_STATE_INVALID');
      }

      const cancelledAt = current.cancelledAt ?? observedAt;
      const purgeAfter =
        family.purgeAfter ?? addUtcMonthsClamped(cancelledAt, runtime.retentionMonths);
      const updated = await tx.subscription.updateMany({
        where: {
          id: current.id,
          familyId: current.familyId,
          providerSubscriptionId: current.providerSubscriptionId,
        },
        data: {
          providerStatus: 'CANCELLED',
          lastProviderEvent:
            current.lastProviderEvent === 'subscription.cancelled'
              ? current.lastProviderEvent
              : 'subscription.reconciled_cancelled',
          providerCheckoutStatus: checkout.status,
          cancelledAt,
          cancelledDueTo:
            current.cancelledDueTo ??
            (current.cancelRequestedAt ? 'owner_requested' : 'provider_reconciled_cancelled'),
          cancelClaimToken: null,
          cancelLockedAt: null,
          cancelLastErrorCode: null,
          checkoutCreationAllowed: false,
          checkoutClosedAt: current.checkoutClosedAt ?? observedAt,
          checkoutCloseReason: 'CANCELLED',
        },
      });
      if (updated.count !== 1) {
        throw this.paymentsUnavailable('CANCELLATION_RECONCILIATION_CHANGED');
      }

      if (family.cancelledAt === null) {
        const familyUpdated = await tx.family.updateMany({
          where: {
            id: user.familyId,
            ownerUserId: user.id,
            currentSubscriptionId: current.id,
            cancelledAt: null,
            purgeAfter: null,
          },
          data: {
            pendingPaymentExpiresAt: null,
            cancelledAt,
            purgeAfter,
          },
        });
        if (familyUpdated.count !== 1) {
          throw this.paymentsUnavailable('CURRENT_SUBSCRIPTION_CHANGED');
        }
      }
    });
  }

  private async closeTerminalCheckout(
    subscription: Subscription,
    checkout: PaymentCheckout,
    runtime: RuntimePaymentConfig,
  ): Promise<void> {
    if (!TERMINAL_CHECKOUT_STATUSES.has(checkout.status)) return;
    await this.withSerializableRetry(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Subscription" WHERE "id" = ${subscription.id} FOR UPDATE
      `;
      if (locked.length !== 1) {
        throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
      }

      const current = await tx.subscription.findUnique({
        where: { id: subscription.id },
      });
      if (
        !current ||
        current.familyId !== subscription.familyId ||
        current.externalId !== subscription.externalId
      ) {
        throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
      }
      this.assertCheckoutIdentity(checkout, current, runtime);
      if (!isSafePreActivationTerminal(current, checkout)) {
        throw this.paymentsUnavailable(
          'CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION',
        );
      }
      if (current.checkoutClosedAt) {
        if (
          current.providerCheckoutId === checkout.id &&
          current.providerCheckoutStatus === checkout.status &&
          current.checkoutCloseReason === checkout.status
        ) {
          return;
        }
        throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
      }

      const observedAt = new Date();
      let provisioningStatus = current.checkoutProvisioningStatus;
      let claimToken = current.checkoutClaimToken;
      let lockedAt = current.checkoutLockedAt;
      if (provisioningStatus !== CheckoutProvisioningStatus.ready) {
        claimToken = randomUUID();
        lockedAt = observedAt;
        const staged = await tx.subscription.updateMany({
          where: checkoutClosureCas(current),
          data: {
            checkoutProvisioningStatus: CheckoutProvisioningStatus.processing,
            checkoutCreationAllowed: false,
            checkoutClaimToken: claimToken,
            checkoutLockedAt: lockedAt,
            checkoutLastErrorCode: null,
          },
        });
        if (staged.count !== 1) {
          throw this.paymentsUnavailable('CHECKOUT_STATE_CHANGED');
        }
        provisioningStatus = CheckoutProvisioningStatus.processing;
      }

      const closed = await tx.subscription.updateMany({
        where: {
          ...checkoutClosureCas(current),
          checkoutProvisioningStatus: provisioningStatus,
          checkoutCreationAllowed: false,
          checkoutClaimToken: claimToken,
          checkoutLockedAt: lockedAt,
          checkoutLastErrorCode: null,
        },
        data: {
          providerCheckoutId: checkout.id,
          providerCheckoutUrl: checkout.url,
          providerCheckoutStatus: checkout.status,
          ...(checkout.customerId
            ? { providerCustomerId: checkout.customerId }
            : {}),
          checkoutProvisioningStatus: CheckoutProvisioningStatus.ready,
          checkoutCreationAllowed: false,
          checkoutClaimToken: null,
          checkoutLockedAt: null,
          checkoutReadyAt: current.checkoutReadyAt ?? observedAt,
          checkoutClosedAt: observedAt,
          checkoutCloseReason: checkout.status,
          checkoutLastErrorCode: null,
        },
      });
      if (closed.count !== 1) {
        throw this.paymentsUnavailable(
          'CHECKOUT_TERMINAL_STATE_REQUIRES_RECONCILIATION',
        );
      }
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
    this.assertLocalSubscriptionIdentity(subscription, runtime);
    if (
      checkout.externalId !== subscription.externalId ||
      checkout.productId !== runtime.productId ||
      checkout.quantity !== 1 ||
      checkout.amountCents !== runtime.amountCents ||
      checkout.currency !== 'BRL' ||
      checkout.devMode !== runtime.expectedDevMode ||
      (subscription.providerCheckoutId &&
        subscription.providerCheckoutId !== checkout.id) ||
      (subscription.providerCustomerId &&
        subscription.providerCustomerId !== checkout.customerId)
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
    const pendingRetentionDays =
      this.config.get<number>('PENDING_PAYMENT_TTL_DAYS') ?? 7;
    const retentionMonths = this.config.get<number>('RETENTION_CANCELLED_MONTHS') ?? 12;
    const firstWebOrigin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://127.0.0.1:8181')
      .split(',')[0]
      ?.trim();
    const publicPlanInvalid =
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      !Number.isSafeInteger(pendingRetentionDays) ||
      pendingRetentionDays < 1 ||
      pendingRetentionDays > 90 ||
      !Number.isSafeInteger(retentionMonths) ||
      retentionMonths < 1 ||
      retentionMonths > 120;
    if (publicPlanInvalid || ((enabled || requireEnabled) && (!productId || !firstWebOrigin))) {
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
      pendingRetentionDays,
      retentionMonths,
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
          isSerializableTransactionConflict(error) &&
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

function isSerializableTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;

  return error.code === 'P2010' && error.meta?.code === '40001';
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

function providerCancellationConfirmed(
  subscription:
    | Pick<Subscription, 'providerStatus' | 'lastProviderEvent'>
    | null
    | undefined,
): boolean {
  return Boolean(
    subscription?.providerStatus === 'CANCELLED' &&
      (subscription.lastProviderEvent === 'subscription.cancelled' ||
        subscription.lastProviderEvent === 'subscription.reconciled_cancelled'),
  );
}

function providerRiskRevocation(
  subscription:
    | Pick<Subscription, 'providerStatus' | 'lastProviderEvent' | 'cancelledAt'>
    | null
    | undefined,
): boolean {
  return Boolean(
    subscription?.cancelledAt &&
      subscription.providerStatus !== 'CANCELLED' &&
      subscription.lastProviderEvent &&
      PROVIDER_RISK_EVENTS.has(subscription.lastProviderEvent),
  );
}

function requiresPrePurgeCheckoutLookup(subscription: Subscription): boolean {
  return Boolean(
    subscription.providerCheckoutStatus === 'PENDING' ||
      subscription.checkoutProvisioningStatus ===
        CheckoutProvisioningStatus.processing ||
      subscription.checkoutProvisioningStatus ===
        CheckoutProvisioningStatus.ambiguous,
  );
}

function isSafePreActivationTerminal(
  subscription: Subscription,
  checkout: PaymentCheckout,
): boolean {
  return Boolean(
    TERMINAL_CHECKOUT_STATUSES.has(checkout.status) &&
      subscription.providerSubscriptionId === null &&
      subscription.providerStatus === null &&
      subscription.lastProviderEvent === null &&
      subscription.lastSuccessfulPaymentAt === null &&
      subscription.accessPaidThrough === null &&
      subscription.paymentFailedAt === null &&
      subscription.graceUntil === null &&
      subscription.cancelledAt === null &&
      subscription.cancelRequestedAt === null &&
      subscription.cancelledDueTo === null &&
      subscription.lastInstallmentNumber === null &&
      subscription.entitlementContractVersion === null &&
      subscription.paymentMethod === null &&
      subscription.providerPaymentMethod === null,
  );
}

function checkoutClosureCas(
  subscription: Subscription,
): Prisma.SubscriptionWhereInput {
  return {
    id: subscription.id,
    familyId: subscription.familyId,
    externalId: subscription.externalId,
    providerCustomerId: subscription.providerCustomerId,
    providerCheckoutId: subscription.providerCheckoutId,
    providerCheckoutUrl: subscription.providerCheckoutUrl,
    providerCheckoutStatus: subscription.providerCheckoutStatus,
    providerSubscriptionId: null,
    providerStatus: null,
    lastProviderEvent: null,
    providerUpdatedAt: subscription.providerUpdatedAt,
    lastSuccessfulPaymentAt: null,
    accessPaidThrough: null,
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: null,
    entitlementContractVersion: null,
    paymentMethod: null,
    providerPaymentMethod: null,
    checkoutProvisioningStatus: subscription.checkoutProvisioningStatus,
    checkoutCreationAllowed: subscription.checkoutCreationAllowed,
    checkoutClaimToken: subscription.checkoutClaimToken,
    checkoutLockedAt: subscription.checkoutLockedAt,
    checkoutReadyAt: subscription.checkoutReadyAt,
    checkoutClosedAt: null,
    checkoutLastErrorCode: subscription.checkoutLastErrorCode,
  };
}

function paymentHistoryTimestamp(payment: {
  providerStatus: string;
  paidAt: Date | null;
  failedAt: Date | null;
  providerUpdatedAt: Date | null;
  createdAt: Date;
}): Date {
  if (payment.providerStatus === 'PAID') {
    return payment.paidAt ?? payment.providerUpdatedAt ?? payment.createdAt;
  }
  if (payment.providerStatus === 'FAILED') {
    return payment.failedAt ?? payment.providerUpdatedAt ?? payment.createdAt;
  }
  return (
    payment.providerUpdatedAt ??
    payment.failedAt ??
    payment.paidAt ??
    payment.createdAt
  );
}
