import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../shared/configuration';
import type { TelegramInlineKeyboardMarkup } from './telegram.types';

@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);

  constructor(private readonly config: ConfigService<AppConfig>) {}

  async sendMessage(chatId: string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramInlineKeyboardMarkup) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  private async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T | null> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(`TELEGRAM_BOT_TOKEN não configurado; chamada ${method} ignorada`);
      return null;
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (!response.ok || !json?.ok) {
      const description = json?.description ?? `HTTP ${response.status}`;
      throw new Error(`Telegram ${method} falhou: ${description}`);
    }

    return json.result ?? null;
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}
