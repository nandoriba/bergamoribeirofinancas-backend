import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { TelegramService } from './telegram.service';
import type { TelegramUpdatePayload } from './telegram.types';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  receiveWebhook(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() payload: TelegramUpdatePayload,
  ) {
    return this.telegramService.receiveWebhook(payload, secretToken);
  }
}
