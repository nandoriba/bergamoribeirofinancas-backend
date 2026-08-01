import { Module } from '@nestjs/common';

import {
  ABACATEPAY_HTTP_FETCH,
  AbacatePayClient,
} from './abacatepay/abacatepay.client';
import { PAYMENT_PROVIDER } from './payment-provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SubscriptionCancellationService } from './subscription-cancellation.service';
import { AbacatePayWebhookApplicationService } from './webhooks/abacatepay-webhook-application.service';
import { AbacatePayWebhookController } from './webhooks/abacatepay-webhook.controller';

@Module({
  controllers: [PaymentsController, AbacatePayWebhookController],
  providers: [
    PaymentsService,
    SubscriptionCancellationService,
    AbacatePayWebhookApplicationService,
    AbacatePayClient,
    {
      provide: ABACATEPAY_HTTP_FETCH,
      useValue: fetch.bind(globalThis),
    },
    {
      provide: PAYMENT_PROVIDER,
      useExisting: AbacatePayClient,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
