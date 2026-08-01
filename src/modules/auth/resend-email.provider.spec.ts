import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResendEmailProvider } from './resend-email.provider';
import { EmailDeliveryError, type TransactionalEmailMessage } from './transactional-email.provider';

const message: TransactionalEmailMessage = {
  to: 'owner@example.com',
  subject: 'Sensitive subject',
  text: 'secret-token-123',
  html: '<p>secret-token-123</p>',
  idempotencyKey: 'financeiro-outbox-outbox-1',
};

function setup(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    EMAIL_PROVIDER: 'resend',
    EMAIL_DELIVERY_TIMEOUT_MS: 1_000,
    RESEND_API_KEY: 're_test_secret',
    EMAIL_FROM: 'Finanças <hello@example.com>',
    ...overrides,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
    getOrThrow: vi.fn((key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  return new ResendEmailProvider(config);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ResendEmailProvider', () => {
  it('sends the exact Resend authentication and idempotency headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(setup().send(message)).resolves.toEqual({ providerMessageId: 'email-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer re_test_secret',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'financeiro-outbox-outbox-1',
        },
        body: JSON.stringify({
          from: 'Finanças <hello@example.com>',
          to: ['owner@example.com'],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('never calls the network when the provider is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(setup({ EMAIL_PROVIDER: 'disabled' }).send(message)).rejects.toMatchObject({
      code: 'PROVIDER_DISABLED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'PROVIDER_AUTHENTICATION_ERROR', false],
    [403, 'PROVIDER_AUTHENTICATION_ERROR', false],
    [409, 'PROVIDER_CONFLICT', true],
    [422, 'PROVIDER_REQUEST_REJECTED', false],
    [429, 'PROVIDER_RATE_LIMITED', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ] as const)('classifies HTTP %s without exposing the provider payload', async (status, code, retryable) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'provider-secret-detail' }), { status }),
      ),
    );

    let caught: unknown;
    try {
      await setup().send(message);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmailDeliveryError);
    expect(caught).toMatchObject({ code, retryable });
    expect(String(caught)).not.toContain('provider-secret-detail');
    expect(String(caught)).not.toContain(message.text);
  });

  it('treats invalid successful responses as retryable and keeps their body private', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: 'provider-secret-detail' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(setup().send(message)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      retryable: true,
    });
  });

  it('aborts a slow request at the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      ),
    );

    const delivery = setup().send(message);
    const assertion = expect(delivery).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });

  it('maps network failures to a generic retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS leaked detail')));

    await expect(setup().send(message)).rejects.toMatchObject({
      code: 'PROVIDER_NETWORK_ERROR',
      retryable: true,
    });
  });
});
