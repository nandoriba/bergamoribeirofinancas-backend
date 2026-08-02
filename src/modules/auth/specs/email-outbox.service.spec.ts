import type { ConfigService } from '@nestjs/config';
import { EmailOutboxStatus, UserActionTokenPurpose } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { ActionTokenCryptoService } from '../action-token-crypto.service';
import { EmailOutboxService } from '../email-outbox.service';
import { EmailDeliveryError, type TransactionalEmailProvider } from '../transactional-email.provider';

function setup(overrides: {
  token?: Record<string, unknown>;
  attempts?: number;
  emailProvider?: string;
} = {}) {
  const token = {
    id: 'token-1',
    purpose: UserActionTokenPurpose.email_verification,
    deliveryEmail: 'owner@example.com',
    consumedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    ...overrides.token,
  };
  const row = {
    id: 'outbox-1',
    status: EmailOutboxStatus.processing,
    attempts: overrides.attempts ?? 1,
    payloadCiphertext: 'encrypted-payload',
    payloadKeyVersion: 'v1',
    token,
  };
  const emailOutbox = {
    findFirst: vi.fn().mockResolvedValueOnce({ id: row.id }).mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn().mockResolvedValue(row),
  };
  const prisma = { emailOutbox } as unknown as PrismaService;
  const crypto = {
    decryptOutboxPayload: vi.fn().mockReturnValue({
      kind: 'email_verification',
      code: '123456',
    }),
  } as unknown as ActionTokenCryptoService;
  const configValues: Record<string, unknown> = {
    EMAIL_PROVIDER: overrides.emailProvider ?? 'resend',
    WEB_ORIGIN: 'https://app.example.com',
    PUBLIC_API_ORIGIN: 'https://api.example.com',
    EMAIL_VERIFICATION_TTL_MINUTES: 15,
    PASSWORD_RESET_TTL_MINUTES: 30,
    SUPPORT_EMAIL: 'support@example.com',
  };
  const config = {
    get: vi.fn((key: string) => configValues[key]),
    getOrThrow: vi.fn((key: string) => {
      const value = configValues[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  const provider = {
    send: vi.fn().mockResolvedValue({ providerMessageId: 'resend-1' }),
  } as unknown as TransactionalEmailProvider;
  const service = new EmailOutboxService(prisma, crypto, config, provider);

  return { crypto, emailOutbox, provider, row, service };
}

function finalUpdate(calls: readonly (readonly unknown[])[]) {
  return calls.at(-1)?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

describe('EmailOutboxService', () => {
  it('does not claim or discard queued mail while the provider is disabled', async () => {
    const { crypto, emailOutbox, provider, service } = setup({ emailProvider: 'disabled' });

    service.kick('outbox-1');
    await service.dispatchPending();
    await Promise.resolve();

    expect(emailOutbox.findFirst).not.toHaveBeenCalled();
    expect(emailOutbox.updateMany).not.toHaveBeenCalled();
    expect(crypto.decryptOutboxPayload).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('revalidates the token immediately before sending and clears recoverable secrets on success', async () => {
    const { crypto, emailOutbox, provider, service } = setup();

    await service.dispatchPending();

    expect(crypto.decryptOutboxPayload).toHaveBeenCalledWith('outbox-1', {
      payloadCiphertext: 'encrypted-payload',
      payloadKeyVersion: 'v1',
    });
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.com',
        idempotencyKey: 'financeiro-outbox-outbox-1',
      }),
    );
    expect(finalUpdate(emailOutbox.updateMany.mock.calls)).toMatchObject({
      data: {
        status: EmailOutboxStatus.sent,
        payloadCiphertext: null,
        nextAttemptAt: null,
        providerMessageId: 'resend-1',
        lockedAt: null,
        lastErrorCode: null,
      },
    });
  });

  it.each([
    ['consumedAt', new Date()],
    ['revokedAt', new Date()],
    ['expiresAt', new Date(Date.now() - 1)],
  ] as const)('discards an outbox whose token has inactive %s before decrypting', async (field, value) => {
    const { crypto, emailOutbox, provider, service } = setup({ token: { [field]: value } });

    await service.dispatchPending();

    expect(crypto.decryptOutboxPayload).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
    expect(finalUpdate(emailOutbox.updateMany.mock.calls)).toMatchObject({
      data: {
        status: EmailOutboxStatus.discarded,
        payloadCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        lastErrorCode: 'TOKEN_INACTIVE',
      },
    });
  });

  it('defers a retryable failure while preserving the encrypted payload', async () => {
    const { emailOutbox, provider, service } = setup({ attempts: 1 });
    vi.mocked(provider.send).mockRejectedValue(new EmailDeliveryError('PROVIDER_UNAVAILABLE', true));

    await service.dispatchPending();

    const update = finalUpdate(emailOutbox.updateMany.mock.calls);
    expect(update).toMatchObject({
      data: {
        status: EmailOutboxStatus.pending,
        lockedAt: null,
        lastErrorCode: 'PROVIDER_UNAVAILABLE',
        nextAttemptAt: expect.any(Date),
      },
    });
    expect(update.data).not.toHaveProperty('payloadCiphertext');
  });

  it.each([
    [new EmailDeliveryError('PROVIDER_REQUEST_REJECTED', false), 1],
    [new EmailDeliveryError('PROVIDER_UNAVAILABLE', true), 8],
  ])('discards terminal failures and clears ciphertext and scheduling', async (error, attempts) => {
    const { emailOutbox, provider, service } = setup({ attempts });
    vi.mocked(provider.send).mockRejectedValue(error);

    await service.dispatchPending();

    expect(finalUpdate(emailOutbox.updateMany.mock.calls)).toMatchObject({
      data: {
        status: EmailOutboxStatus.discarded,
        payloadCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        lastErrorCode: error.code,
      },
    });
  });

  it('discards a decrypted payload that does not match the persisted purpose', async () => {
    const { crypto, emailOutbox, provider, service } = setup();
    vi.mocked(crypto.decryptOutboxPayload).mockReturnValue({
      kind: 'password_reset',
      resetToken: '11111111-1111-4111-8111-111111111111.A'.padEnd(80, 'A'),
    });

    await service.dispatchPending();

    expect(provider.send).not.toHaveBeenCalled();
    expect(finalUpdate(emailOutbox.updateMany.mock.calls).data).toMatchObject({
      status: EmailOutboxStatus.discarded,
      payloadCiphertext: null,
      nextAttemptAt: null,
      lastErrorCode: 'PURPOSE_MISMATCH',
    });
  });

  it('does not send the same claimed row again when no claimable candidate remains', async () => {
    const { provider, service } = setup();

    await service.dispatchPending();
    await service.dispatchPending();

    expect(provider.send).toHaveBeenCalledOnce();
  });

  it('leaves a delivered row processing when persisting the sent state fails', async () => {
    const { emailOutbox, provider, service } = setup();
    emailOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.dispatchPending()).rejects.toThrow('database unavailable');

    expect(provider.send).toHaveBeenCalledOnce();
    expect(emailOutbox.updateMany).toHaveBeenCalledTimes(2);
    expect(finalUpdate(emailOutbox.updateMany.mock.calls).data).toMatchObject({
      status: EmailOutboxStatus.sent,
      providerMessageId: 'resend-1',
    });
    expect(emailOutbox.updateMany.mock.calls).not.toContainEqual([
      expect.objectContaining({
        data: expect.objectContaining({ status: EmailOutboxStatus.discarded }),
      }),
    ]);
  });
});
