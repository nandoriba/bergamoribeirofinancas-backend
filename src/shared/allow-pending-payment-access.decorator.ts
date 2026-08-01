import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PAYMENT_ACCESS_KEY = 'allowPendingPaymentAccess';

export const AllowPendingPaymentAccess = () =>
  SetMetadata(ALLOW_PENDING_PAYMENT_ACCESS_KEY, true);
