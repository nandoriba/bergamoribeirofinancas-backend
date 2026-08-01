import { Prisma } from "@prisma/client";

import {
  evaluateSubscriptionAccess,
  type SubscriptionAccessClock,
  type SubscriptionAccessDecision,
} from "./subscription-access.policy";

export const SUBSCRIPTION_ACCESS_SELECT =
  Prisma.validator<Prisma.SubscriptionSelect>()({
    providerStatus: true,
    lastProviderEvent: true,
    providerUpdatedAt: true,
    lastSuccessfulPaymentAt: true,
    accessPaidThrough: true,
    paymentFailedAt: true,
    graceUntil: true,
    cancelledAt: true,
    cancelRequestedAt: true,
    cancelledDueTo: true,
    lastInstallmentNumber: true,
    entitlementContractVersion: true,
    billingCycle: true,
    paymentMethod: true,
  });

export type SubscriptionAccessProjection = Prisma.SubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_ACCESS_SELECT;
}>;

/** Maps the exact persisted authorization projection into the pure policy. */
export function evaluateSubscriptionProjection(
  subscription: SubscriptionAccessProjection | null | undefined,
  clock: SubscriptionAccessClock = () => new Date(),
): SubscriptionAccessDecision {
  if (!subscription) return evaluateSubscriptionAccess(null, clock);

  return evaluateSubscriptionAccess(
    {
      ...subscription,
      billingCycle: subscription.billingCycle,
      paymentMethod: subscription.paymentMethod,
    },
    clock,
  );
}
