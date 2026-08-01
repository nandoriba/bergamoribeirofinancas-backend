import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  EmailDeliveryError,
  type TransactionalEmailMessage,
  type TransactionalEmailProvider,
} from './transactional-email.provider';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';

@Injectable()
export class ResendEmailProvider implements TransactionalEmailProvider {
  constructor(private readonly config: ConfigService) {}

  async send(message: TransactionalEmailMessage): Promise<{ providerMessageId: string }> {
    if ((this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') !== 'resend') {
      throw new EmailDeliveryError('PROVIDER_DISABLED', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.get<number>('EMAIL_DELIVERY_TIMEOUT_MS') ?? 10_000,
    );

    try {
      const response = await fetch(RESEND_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.getOrThrow<string>('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.getOrThrow<string>('EMAIL_FROM'),
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        redirect: 'error',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new EmailDeliveryError(
          classifyProviderStatus(response.status),
          isRetryableStatus(response.status),
        );
      }

      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== 'object' || !('id' in payload)) {
        throw new EmailDeliveryError('INVALID_PROVIDER_RESPONSE', true);
      }
      const providerMessageId = (payload as { id?: unknown }).id;
      if (typeof providerMessageId !== 'string' || !providerMessageId.trim()) {
        throw new EmailDeliveryError('INVALID_PROVIDER_RESPONSE', true);
      }

      return { providerMessageId };
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EmailDeliveryError('PROVIDER_TIMEOUT', true);
      }
      throw new EmailDeliveryError('PROVIDER_NETWORK_ERROR', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function classifyProviderStatus(status: number): string {
  if (status === 401 || status === 403) return 'PROVIDER_AUTHENTICATION_ERROR';
  if (status === 408) return 'PROVIDER_TIMEOUT';
  if (status === 409) return 'PROVIDER_CONFLICT';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_REJECTED';
}
