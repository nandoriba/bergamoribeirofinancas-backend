import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../shared/public.decorator';
import { TelegramService } from './telegram.service';
import type { TelegramUpdatePayload } from './telegram.types';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('webhook')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @HttpCode(200)
  receiveWebhook(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() payload: TelegramUpdatePayload,
  ) {
    return this.telegramService.receiveWebhook(payload, secretToken);
  }
}
