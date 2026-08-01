import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActionTokenCryptoService,
  type ActionTokenContext,
  type EncryptedOutboxPayload,
  type EncryptedPasswordResetRequest,
} from './action-token-crypto.service';

const cryptoMocks = vi.hoisted(() => ({
  randomInt: vi.fn((_minimum: number, _maximum: number) => 42),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: cryptoMocks.randomInt };
});

const TOKEN_SECRET = 'token-secret-with-more-than-thirty-two-bytes';
const OUTBOX_SECRET = 'outbox-secret-with-more-than-thirty-two-bytes';

function createService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    EMAIL_PROVIDER: 'resend',
    ACTION_TOKEN_SECRET: TOKEN_SECRET,
    EMAIL_OUTBOX_SECRET: OUTBOX_SECRET,
    EMAIL_OUTBOX_KEY_VERSION: 'v1',
    ...overrides,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new ActionTokenCryptoService(config);
}

const context: ActionTokenContext = {
  purpose: 'email_verification',
  tokenId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  deliveryEmail: 'owner@example.com',
};

function tamper(value: string): string {
  const character = value[0];
  if (!character) throw new Error('Expected non-empty envelope segment');
  return `${character === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  cryptoMocks.randomInt.mockReset().mockReturnValue(42);
});

describe('ActionTokenCryptoService', () => {
  it('produces exactly six digits and preserves leading zeroes', () => {
    const service = createService();
    cryptoMocks.randomInt.mockReturnValueOnce(0).mockReturnValueOnce(42);

    expect(service.generateVerificationCode()).toBe('000000');
    expect(service.generateVerificationCode()).toBe('000042');
    expect(cryptoMocks.randomInt).toHaveBeenNthCalledWith(1, 0, 1_000_000);
  });

  it('generates a 256-bit base64url reset secret', () => {
    const value = createService().generateResetSecret();

    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  });

  it('binds HMACs to purpose, challenge, user and normalized delivery address', () => {
    const service = createService();
    const hash = service.hashSecret(context, '123456');

    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.secretMatches(context, '123456', hash)).toBe(true);
    expect(service.secretMatches({ ...context, purpose: 'password_reset' }, '123456', hash)).toBe(false);
    expect(service.secretMatches({ ...context, tokenId: 'other' }, '123456', hash)).toBe(false);
    expect(service.secretMatches({ ...context, userId: 'other' }, '123456', hash)).toBe(false);
    expect(service.secretMatches({ ...context, deliveryEmail: 'other@example.com' }, '123456', hash)).toBe(false);
  });

  it('performs the invalid-secret comparison without throwing on malformed hashes', () => {
    const service = createService();

    expect(service.secretMatches(context, '123456', '')).toBe(false);
    expect(service.secretMatches(context, '123456', '***not-base64url***')).toBe(false);
    expect(service.secretMatches(context, '123456', 'AA')).toBe(false);
  });

  it('encrypts with fresh authenticated envelopes bound to the outbox id', () => {
    const service = createService();
    const payload = { kind: 'email_verification' as const, code: '007042' };
    const first = service.encryptOutboxPayload('outbox-1', payload);
    const second = service.encryptOutboxPayload('outbox-1', payload);

    expect(first.payloadCiphertext).not.toBe(second.payloadCiphertext);
    expect(first.payloadCiphertext).not.toContain(payload.code);
    expect(service.decryptOutboxPayload('outbox-1', first)).toEqual(payload);
    expect(() => service.decryptOutboxPayload('outbox-2', first)).toThrow(
      'Invalid encrypted email payload',
    );
  });

  it('rejects ciphertext, tag and key-version tampering with one generic error', () => {
    const service = createService();
    const encrypted = service.encryptOutboxPayload('outbox-1', {
      kind: 'password_reset',
      resetToken: '11111111-1111-4111-8111-111111111111.A'.padEnd(80, 'A'),
    });
    const parts = encrypted.payloadCiphertext.split('.');
    const ciphertext = parts[3];
    if (!ciphertext) throw new Error('Expected ciphertext segment');
    parts[3] = tamper(ciphertext);

    const tampered: EncryptedOutboxPayload = {
      ...encrypted,
      payloadCiphertext: parts.join('.'),
    };
    expect(() => service.decryptOutboxPayload('outbox-1', tampered)).toThrow(
      'Invalid encrypted email payload',
    );
    expect(() =>
      service.decryptOutboxPayload('outbox-1', { ...encrypted, payloadKeyVersion: 'v2' }),
    ).toThrow('Invalid encrypted email payload');
  });

  it('encrypts canonical reset-request emails with fresh envelopes bound to the request id', () => {
    const service = createService();
    const email = 'owner@example.com';
    const first = service.encryptPasswordResetRequest('request-1', email);
    const second = service.encryptPasswordResetRequest('request-1', email);

    expect(first.emailCiphertext).not.toBe(second.emailCiphertext);
    expect(first.emailCiphertext).not.toContain(email);
    expect(service.decryptPasswordResetRequest('request-1', first)).toBe(email);
    expect(() => service.decryptPasswordResetRequest('request-2', first)).toThrow(
      'Invalid encrypted password-reset request',
    );
  });

  it('rejects reset-request tampering and keeps request/outbox encryption domains separate', () => {
    const service = createService();
    const encrypted = service.encryptPasswordResetRequest(
      'request-1',
      'owner@example.com',
    );
    const parts = encrypted.emailCiphertext.split('.');
    const ciphertext = parts[3];
    if (!ciphertext) throw new Error('Expected ciphertext segment');
    parts[3] = tamper(ciphertext);
    const tampered: EncryptedPasswordResetRequest = {
      ...encrypted,
      emailCiphertext: parts.join('.'),
    };

    expect(() => service.decryptPasswordResetRequest('request-1', tampered)).toThrow(
      'Invalid encrypted password-reset request',
    );
    expect(() =>
      service.decryptPasswordResetRequest('request-1', {
        ...encrypted,
        payloadKeyVersion: 'v2',
      }),
    ).toThrow('Invalid encrypted password-reset request');

    const outbox = service.encryptOutboxPayload('request-1', {
      kind: 'email_verification',
      code: '123456',
    });
    expect(() =>
      service.decryptOutboxPayload('request-1', {
        payloadCiphertext: encrypted.emailCiphertext,
        payloadKeyVersion: encrypted.payloadKeyVersion,
      }),
    ).toThrow('Invalid encrypted email payload');
    expect(() =>
      service.decryptPasswordResetRequest('request-1', {
        emailCiphertext: outbox.payloadCiphertext,
        payloadKeyVersion: outbox.payloadKeyVersion,
      }),
    ).toThrow('Invalid encrypted password-reset request');
  });

  it('fails closed when enabled features do not have independent 32-byte secrets', () => {
    expect(() => createService({ ACTION_TOKEN_SECRET: 'short' })).toThrow(
      'ACTION_TOKEN_SECRET must contain at least 32 bytes',
    );
    expect(() => createService({ EMAIL_OUTBOX_SECRET: 'short' })).toThrow(
      'EMAIL_OUTBOX_SECRET must contain at least 32 bytes',
    );
  });
});
