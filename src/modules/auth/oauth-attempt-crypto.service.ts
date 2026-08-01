import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const RANDOM_VALUE_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ENVELOPE_VERSION = 'oa1';
const SECURE_COOKIE_NAME_PREFIX = '__Host-financeiro-oauth-';
const DEVELOPMENT_COOKIE_NAME_PREFIX = 'financeiro-oauth-';
const DOMAIN_PREFIX = 'financeiro:oauth-attempt';

type HashDomain = 'state' | 'nonce' | 'browser-binding' | 'cookie-name';

export interface OAuthAttemptSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly browserBinding: string;
  readonly pkceVerifier: string;
  readonly pkceChallenge: string;
}

export interface EncryptedPkceVerifier {
  readonly pkceVerifierCiphertext: string;
  readonly pkceVerifierKeyVersion: string;
}

export interface PersistedOAuthAttemptSecrets extends EncryptedPkceVerifier {
  readonly stateHash: string;
  readonly nonceHash: string;
  readonly browserBindingHash: string;
}

@Injectable()
export class OAuthAttemptCryptoService {
  private readonly secret: Buffer;
  private readonly keyVersion: string;
  private readonly encryptionKey: Buffer;
  private readonly cookieNamePrefix: string;

  constructor(config: ConfigService) {
    const oauthEnabled = config.get<boolean>('GOOGLE_OAUTH_ENABLED') ?? false;
    const configuredSecret =
      config.get<string>('OAUTH_ATTEMPT_SECRET') ??
      (oauthEnabled ? '' : 'google-oauth-disabled-placeholder-secret');
    const configuredKeyVersion = (config.get<string>('OAUTH_ATTEMPT_KEY_VERSION') ?? 'v1').trim();

    this.secret = Buffer.from(configuredSecret, 'utf8');
    if (this.secret.byteLength < RANDOM_VALUE_BYTES) {
      throw new Error('OAUTH_ATTEMPT_SECRET must contain at least 32 bytes');
    }
    if (!configuredKeyVersion) {
      throw new Error('OAUTH_ATTEMPT_KEY_VERSION must not be blank');
    }

    this.keyVersion = configuredKeyVersion;
    this.encryptionKey = this.hmacDigest('pkce-encryption-key', this.keyVersion);
    this.cookieNamePrefix = config.get<boolean>('COOKIE_SECURE')
      ? SECURE_COOKIE_NAME_PREFIX
      : DEVELOPMENT_COOKIE_NAME_PREFIX;
  }

  generateAttemptSecrets(): OAuthAttemptSecrets {
    const pkceVerifier = this.randomValue();

    return {
      state: this.randomValue(),
      nonce: this.randomValue(),
      browserBinding: this.randomValue(),
      pkceVerifier,
      pkceChallenge: this.createPkceChallenge(pkceVerifier),
    };
  }

  prepareForPersistence(secrets: OAuthAttemptSecrets): PersistedOAuthAttemptSecrets {
    return {
      stateHash: this.hashState(secrets.state),
      nonceHash: this.hashNonce(secrets.nonce),
      browserBindingHash: this.hashBrowserBinding(secrets.browserBinding),
      ...this.encryptPkceVerifier(secrets.pkceVerifier),
    };
  }

  createPkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier, 'ascii').digest('base64url');
  }

  hashState(state: string): string {
    return this.hashValue('state', state);
  }

  hashNonce(nonce: string): string {
    return this.hashValue('nonce', nonce);
  }

  hashBrowserBinding(browserBinding: string): string {
    return this.hashValue('browser-binding', browserBinding);
  }

  nonceMatchesHash(nonce: string, expectedHash: string): boolean {
    const expectedDigest = this.decodeBase64Url(expectedHash);
    if (!expectedDigest || expectedDigest.byteLength !== 32) return false;

    const actualDigest = this.hmacDigest('nonce', nonce);
    return timingSafeEqual(actualDigest, expectedDigest);
  }

  encryptPkceVerifier(pkceVerifier: string): EncryptedPkceVerifier {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(this.envelopeAdditionalData(this.keyVersion));

    const ciphertext = Buffer.concat([cipher.update(pkceVerifier, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encodedKeyVersion = Buffer.from(this.keyVersion, 'utf8').toString('base64url');

    return {
      pkceVerifierCiphertext: [
        ENVELOPE_VERSION,
        encodedKeyVersion,
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        authTag.toString('base64url'),
      ].join('.'),
      pkceVerifierKeyVersion: this.keyVersion,
    };
  }

  decryptPkceVerifier(encrypted: EncryptedPkceVerifier): string {
    try {
      if (encrypted.pkceVerifierKeyVersion !== this.keyVersion) {
        throw new Error('Unsupported key version');
      }

      const parts = encrypted.pkceVerifierCiphertext.split('.');
      if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
        throw new Error('Invalid envelope');
      }

      const encodedKeyVersion = parts[1];
      const encodedIv = parts[2];
      const encodedCiphertext = parts[3];
      const encodedAuthTag = parts[4];
      if (!encodedKeyVersion || !encodedIv || !encodedCiphertext || !encodedAuthTag) {
        throw new Error('Incomplete envelope');
      }

      const envelopeKeyVersion = this.decodeBase64Url(encodedKeyVersion)?.toString('utf8');
      if (envelopeKeyVersion !== encrypted.pkceVerifierKeyVersion) {
        throw new Error('Envelope key version mismatch');
      }

      const iv = this.decodeBase64Url(encodedIv);
      const ciphertext = this.decodeBase64Url(encodedCiphertext);
      const authTag = this.decodeBase64Url(encodedAuthTag);
      if (
        !iv ||
        !ciphertext ||
        !authTag ||
        iv.byteLength !== AES_GCM_IV_BYTES ||
        ciphertext.byteLength === 0 ||
        authTag.byteLength !== AES_GCM_TAG_BYTES
      ) {
        throw new Error('Invalid envelope values');
      }

      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(this.envelopeAdditionalData(envelopeKeyVersion));
      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Invalid encrypted PKCE verifier');
    }
  }

  cookieNameForState(state: string): string {
    const suffix = this.hashValue('cookie-name', state).slice(0, 22);
    return `${this.cookieNamePrefix}${suffix}`;
  }

  private randomValue(): string {
    return randomBytes(RANDOM_VALUE_BYTES).toString('base64url');
  }

  private hashValue(domain: HashDomain, value: string): string {
    return this.hmacDigest(domain, value).toString('base64url');
  }

  private hmacDigest(domain: string, value: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(DOMAIN_PREFIX, 'utf8')
      .update('\0', 'utf8')
      .update(domain, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest();
  }

  private envelopeAdditionalData(keyVersion: string): Buffer {
    return Buffer.from(`${DOMAIN_PREFIX}\0${ENVELOPE_VERSION}\0${keyVersion}`, 'utf8');
  }

  private decodeBase64Url(value: string): Buffer | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  }
}
