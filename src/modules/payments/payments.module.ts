import { Module } from '@nestjs/common';

import {
  ABACATEPAY_HTTP_FETCH,
  AbacatePayClient,
} from './abacatepay/abacatepay.client';
import { PAYMENT_PROVIDER } from './payment-provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
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
})
export class PaymentsModule {}
