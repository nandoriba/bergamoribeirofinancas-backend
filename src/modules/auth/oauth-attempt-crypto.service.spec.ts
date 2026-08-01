import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import {
  OAuthAttemptCryptoService,
  type EncryptedPkceVerifier,
} from './oauth-attempt-crypto.service';

const TEST_SECRET = 'oauth-attempt-test-secret-with-at-least-32-bytes';

function createService(keyVersion = 'v1', secret = TEST_SECRET, secureCookie = false) {
  const values: Record<string, string | boolean> = {
    OAUTH_ATTEMPT_SECRET: secret,
    OAUTH_ATTEMPT_KEY_VERSION: keyVersion,
    COOKIE_SECURE: secureCookie,
  };
  const config = {
    get: vi.fn((key: string) => values[key] ?? false),
  } as unknown as ConfigService;

  return new OAuthAttemptCryptoService(config);
}

function tamperBase64Url(value: string): string {
  const firstCharacter = value[0];
  if (!firstCharacter) throw new Error('Cannot tamper with an empty value');
  return `${firstCharacter === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

describe('OAuthAttemptCryptoService', () => {
  it('generates independent 256-bit base64url values and an RFC 7636 S256 challenge', () => {
    const service = createService();
    const first = service.generateAttemptSecrets();
    const second = service.generateAttemptSecrets();
    const randomValues = [
      first.state,
      first.nonce,
      first.browserBinding,
      first.pkceVerifier,
      second.state,
      second.nonce,
      second.browserBinding,
      second.pkceVerifier,
    ];

    expect(new Set(randomValues)).toHaveLength(randomValues.length);
    for (const value of randomValues) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(first.pkceChallenge).toBe(service.createPkceChallenge(first.pkceVerifier));
    expect(first.pkceChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('matches the RFC 7636 PKCE S256 example', () => {
    const service = createService();

    expect(service.createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('prepares only hashes and encrypted material for persistence', () => {
    const service = createService();
    const secrets = service.generateAttemptSecrets();
    const persisted = service.prepareForPersistence(secrets);
    const serialized = JSON.stringify(persisted);

    expect(Object.keys(persisted).sort()).toEqual(
      [
        'browserBindingHash',
        'nonceHash',
        'pkceVerifierCiphertext',
        'pkceVerifierKeyVersion',
        'stateHash',
      ].sort(),
    );
    expect(persisted.stateHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persisted.nonceHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persisted.browserBindingHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(serialized).not.toContain(secrets.state);
    expect(serialized).not.toContain(secrets.nonce);
    expect(serialized).not.toContain(secrets.browserBinding);
    expect(serialized).not.toContain(secrets.pkceVerifier);
  });

  it('separates HMAC domains and compares nonce hashes without throwing on malformed input', () => {
    const service = createService();
    const value = 'same-input-for-every-domain';
    const stateHash = service.hashState(value);
    const nonceHash = service.hashNonce(value);
    const browserHash = service.hashBrowserBinding(value);

    expect(new Set([stateHash, nonceHash, browserHash])).toHaveLength(3);
    expect(service.nonceMatchesHash(value, nonceHash)).toBe(true);
    expect(service.nonceMatchesHash('different-nonce', nonceHash)).toBe(false);
    expect(service.nonceMatchesHash(value, 'not-a-valid-hash')).toBe(false);
  });

  it('encrypts a verifier with a fresh IV and decrypts authenticated envelopes', () => {
    const service = createService();
    const verifier = service.generateAttemptSecrets().pkceVerifier;
    const first = service.encryptPkceVerifier(verifier);
    const second = service.encryptPkceVerifier(verifier);

    expect(first.pkceVerifierCiphertext).not.toBe(second.pkceVerifierCiphertext);
    expect(first.pkceVerifierCiphertext).not.toContain(verifier);
    expect(first.pkceVerifierKeyVersion).toBe('v1');
    expect(service.decryptPkceVerifier(first)).toBe(verifier);
    expect(service.decryptPkceVerifier(second)).toBe(verifier);
  });

  it('rejects tampered ciphertext and mismatched key versions', () => {
    const service = createService('v1');
    const encrypted = service.encryptPkceVerifier('a-valid-pkce-verifier');
    const parts = encrypted.pkceVerifierCiphertext.split('.');
    const ciphertext = parts[3];
    if (!ciphertext) throw new Error('Expected ciphertext envelope segment');
    parts[3] = tamperBase64Url(ciphertext);

    const tampered: EncryptedPkceVerifier = {
      ...encrypted,
      pkceVerifierCiphertext: parts.join('.'),
    };
    expect(() => service.decryptPkceVerifier(tampered)).toThrow('Invalid encrypted PKCE verifier');

    const versionTwoService = createService('v2');
    expect(() => versionTwoService.decryptPkceVerifier(encrypted)).toThrow(
      'Invalid encrypted PKCE verifier',
    );
    expect(() =>
      service.decryptPkceVerifier({ ...encrypted, pkceVerifierKeyVersion: 'v2' }),
    ).toThrow('Invalid encrypted PKCE verifier');
  });

  it('derives deterministic, state-specific cookie names without exposing state', () => {
    const service = createService();
    const firstState = service.generateAttemptSecrets().state;
    const secondState = service.generateAttemptSecrets().state;
    const firstCookieName = service.cookieNameForState(firstState);
    const secondCookieName = service.cookieNameForState(secondState);

    expect(firstCookieName).toBe(service.cookieNameForState(firstState));
    expect(firstCookieName).not.toBe(secondCookieName);
    expect(firstCookieName).toMatch(/^financeiro-oauth-[A-Za-z0-9_-]{22}$/);
    expect(firstCookieName).not.toContain(firstState);
  });

  it('uses the __Host prefix only when Secure cookies are enabled', () => {
    const service = createService('v1', TEST_SECRET, true);

    expect(service.cookieNameForState(service.generateAttemptSecrets().state)).toMatch(
      /^__Host-financeiro-oauth-[A-Za-z0-9_-]{22}$/,
    );
  });

  it('rejects undersized secrets at construction time', () => {
    expect(() => createService('v1', 'too-short')).toThrow(
      'OAUTH_ATTEMPT_SECRET must contain at least 32 bytes',
    );
  });
});
