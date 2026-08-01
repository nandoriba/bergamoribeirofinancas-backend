import { Module } from '@nestjs/common';

import { InstallmentsModule } from '../installments/installments.module';
import { PaymentsModule } from '../payments/payments.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { AI_PROVIDER } from './ai-provider';
import { AiUsageService } from './ai-usage.service';
import { OpenAiAdapter } from './openai.adapter';
import { TelegramAuthCodesController } from './telegram-auth-codes.controller';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramClient } from './telegram.client';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TransactionsModule, InstallmentsModule, PaymentsModule],
  controllers: [TelegramWebhookController, TelegramAuthCodesController],
  providers: [
    TelegramClient,
    TelegramService,
    AiUsageService,
    {
      provide: AI_PROVIDER,
      useClass: OpenAiAdapter,
    },
  ],
})
export class TelegramModule {}
