import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TelegramService } from './telegram.service';

describe('autenticação do webhook no TelegramService', () => {
  function createSecretAssertion(expectedSecret?: string) {
    const service = new TelegramService(
      { get: vi.fn().mockReturnValue(expectedSecret) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return (service as unknown as { assertWebhookSecret(secretToken?: string): void }).assertWebhookSecret.bind(
      service,
    );
  }

  it('aceita somente o secret configurado', () => {
    const assertWebhookSecret = createSecretAssertion('telegram-webhook-secret');

    expect(() => assertWebhookSecret('telegram-webhook-secret')).not.toThrow();
  });

  it.each([
    ['configuração ausente', undefined, 'telegram-webhook-secret'],
    ['header ausente', 'telegram-webhook-secret', undefined],
    ['valor diferente', 'telegram-webhook-secret', 'telegram-webhook-secrex'],
    ['comprimento diferente', 'telegram-webhook-secret', 'short'],
  ])('rejeita %s', (_label, expectedSecret, receivedSecret) => {
    const assertWebhookSecret = createSecretAssertion(expectedSecret);

    expect(() => assertWebhookSecret(receivedSecret)).toThrow(UnauthorizedException);
  });
});
