import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

const DIGEST_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ENVELOPE_VERSION = 'at1';
const PASSWORD_RESET_REQUEST_ENVELOPE_VERSION = 'pr1';
const TOKEN_DOMAIN = 'financeiro:user-action-token';
const OUTBOX_DOMAIN = 'financeiro:email-outbox';
const PASSWORD_RESET_REQUEST_DOMAIN = 'financeiro:password-reset-request';

export const INVITE_EMAIL_CONTINUATION_PATH = '/convite/verificacao' as const;

export type ActionTokenPurpose = 'email_verification' | 'password_reset';

export interface ActionTokenContext {
  purpose: ActionTokenPurpose;
  tokenId: string;
  userId: string;
  deliveryEmail: string;
}

export type EmailOutboxPayload =
  | {
      kind: 'email_verification';
      code: string;
      continuationPath?: typeof INVITE_EMAIL_CONTINUATION_PATH;
    }
  | { kind: 'password_reset'; resetToken: string };

export interface EncryptedOutboxPayload {
  payloadCiphertext: string;
  payloadKeyVersion: string;
}

export interface EncryptedPasswordResetRequest {
  emailCiphertext: string;
  payloadKeyVersion: string;
}

@Injectable()
export class ActionTokenCryptoService {
  private readonly tokenSecret: Buffer;
  private readonly outboxKeyVersion: string;
  private readonly outboxEncryptionKey: Buffer;
  private readonly passwordResetRequestEncryptionKey: Buffer;

  constructor(config: ConfigService) {
    const secretsRequired =
      (config.get<string>('EMAIL_PROVIDER') ?? 'disabled') !== 'disabled' ||
      (config.get<boolean>('OWNER_SIGNUP_ENABLED') ?? false);
    const tokenSecret =
      config.get<string>('ACTION_TOKEN_SECRET') ??
      (secretsRequired ? '' : 'action-token-disabled-placeholder-secret-v1');
    const outboxSecret =
      config.get<string>('EMAIL_OUTBOX_SECRET') ??
      (secretsRequired ? '' : 'email-outbox-disabled-placeholder-secret-v1');
    const keyVersion = (config.get<string>('EMAIL_OUTBOX_KEY_VERSION') ?? 'v1').trim();

    this.tokenSecret = Buffer.from(tokenSecret, 'utf8');
    const outboxSecretBuffer = Buffer.from(outboxSecret, 'utf8');
    if (this.tokenSecret.byteLength < DIGEST_BYTES) {
      throw new Error('ACTION_TOKEN_SECRET must contain at least 32 bytes');
    }
    if (outboxSecretBuffer.byteLength < DIGEST_BYTES) {
      throw new Error('EMAIL_OUTBOX_SECRET must contain at least 32 bytes');
    }
    if (!keyVersion) throw new Error('EMAIL_OUTBOX_KEY_VERSION must not be blank');

    this.outboxKeyVersion = keyVersion;
    this.outboxEncryptionKey = createHmac('sha256', outboxSecretBuffer)
      .update(OUTBOX_DOMAIN, 'utf8')
      .update('\0encryption-key\0', 'utf8')
      .update(keyVersion, 'utf8')
      .digest();
    this.passwordResetRequestEncryptionKey = createHmac('sha256', outboxSecretBuffer)
      .update(PASSWORD_RESET_REQUEST_DOMAIN, 'utf8')
      .update('\0encryption-key\0', 'utf8')
      .update(keyVersion, 'utf8')
      .digest();
  }

  generateVerificationCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  generateResetSecret(): string {
    return randomBytes(DIGEST_BYTES).toString('base64url');
  }

  hashSecret(context: ActionTokenContext, secret: string): string {
    return this.secretDigest(context, secret).toString('base64url');
  }

  secretMatches(context: ActionTokenContext, secret: string, expectedHash: string): boolean {
    const actual = this.secretDigest(context, secret);
    const decoded = this.decodeBase64Url(expectedHash);
    const expected = decoded?.byteLength === DIGEST_BYTES ? decoded : Buffer.alloc(DIGEST_BYTES);
    const matches = timingSafeEqual(actual, expected);
    return matches && decoded?.byteLength === DIGEST_BYTES;
  }

  encryptOutboxPayload(
    outboxId: string,
    payload: EmailOutboxPayload,
  ): EncryptedOutboxPayload {
    if (!isEmailOutboxPayload(payload)) {
      throw new Error('Invalid email payload');
    }
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.outboxEncryptionKey, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(this.outboxAdditionalData(outboxId, this.outboxKeyVersion));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      payloadCiphertext: [
        ENVELOPE_VERSION,
        Buffer.from(this.outboxKeyVersion, 'utf8').toString('base64url'),
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        authTag.toString('base64url'),
      ].join('.'),
      payloadKeyVersion: this.outboxKeyVersion,
    };
  }

  decryptOutboxPayload(
    outboxId: string,
    encrypted: EncryptedOutboxPayload,
  ): EmailOutboxPayload {
    try {
      if (encrypted.payloadKeyVersion !== this.outboxKeyVersion) {
        throw new Error('Unsupported key version');
      }

      const parts = encrypted.payloadCiphertext.split('.');
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
      const iv = this.decodeBase64Url(encodedIv);
      const ciphertext = this.decodeBase64Url(encodedCiphertext);
      const authTag = this.decodeBase64Url(encodedAuthTag);
      if (
        envelopeKeyVersion !== encrypted.payloadKeyVersion ||
        !iv ||
        !ciphertext ||
        !authTag ||
        iv.byteLength !== AES_GCM_IV_BYTES ||
        ciphertext.byteLength === 0 ||
        authTag.byteLength !== AES_GCM_TAG_BYTES
      ) {
        throw new Error('Invalid envelope values');
      }

      const decipher = createDecipheriv('aes-256-gcm', this.outboxEncryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(this.outboxAdditionalData(outboxId, envelopeKeyVersion));
      decipher.setAuthTag(authTag);

      const value = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      ) as unknown;
      if (!isEmailOutboxPayload(value)) throw new Error('Invalid payload');
      return value;
    } catch {
      throw new Error('Invalid encrypted email payload');
    }
  }

  encryptPasswordResetRequest(
    requestId: string,
    email: string,
  ): EncryptedPasswordResetRequest {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.passwordResetRequestEncryptionKey,
      iv,
      { authTagLength: AES_GCM_TAG_BYTES },
    );
    cipher.setAAD(this.passwordResetRequestAdditionalData(requestId, this.outboxKeyVersion));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ email }), 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      emailCiphertext: [
        PASSWORD_RESET_REQUEST_ENVELOPE_VERSION,
        Buffer.from(this.outboxKeyVersion, 'utf8').toString('base64url'),
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        authTag.toString('base64url'),
      ].join('.'),
      payloadKeyVersion: this.outboxKeyVersion,
    };
  }

  decryptPasswordResetRequest(
    requestId: string,
    encrypted: EncryptedPasswordResetRequest,
  ): string {
    try {
      if (encrypted.payloadKeyVersion !== this.outboxKeyVersion) {
        throw new Error('Unsupported key version');
      }

      const parts = encrypted.emailCiphertext.split('.');
      if (parts.length !== 5 || parts[0] !== PASSWORD_RESET_REQUEST_ENVELOPE_VERSION) {
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
      const iv = this.decodeBase64Url(encodedIv);
      const ciphertext = this.decodeBase64Url(encodedCiphertext);
      const authTag = this.decodeBase64Url(encodedAuthTag);
      if (
        envelopeKeyVersion !== encrypted.payloadKeyVersion ||
        !iv ||
        !ciphertext ||
        !authTag ||
        iv.byteLength !== AES_GCM_IV_BYTES ||
        ciphertext.byteLength === 0 ||
        authTag.byteLength !== AES_GCM_TAG_BYTES
      ) {
        throw new Error('Invalid envelope values');
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.passwordResetRequestEncryptionKey,
        iv,
        { authTagLength: AES_GCM_TAG_BYTES },
      );
      decipher.setAAD(this.passwordResetRequestAdditionalData(requestId, envelopeKeyVersion));
      decipher.setAuthTag(authTag);

      const value = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      ) as unknown;
      if (!isPasswordResetRequestPayload(value)) throw new Error('Invalid payload');
      return value.email;
    } catch {
      throw new Error('Invalid encrypted password-reset request');
    }
  }

  private secretDigest(context: ActionTokenContext, secret: string): Buffer {
    return createHmac('sha256', this.tokenSecret)
      .update(TOKEN_DOMAIN, 'utf8')
      .update('\0', 'utf8')
      .update(context.purpose, 'utf8')
      .update('\0', 'utf8')
      .update(context.tokenId, 'utf8')
      .update('\0', 'utf8')
      .update(context.userId, 'utf8')
      .update('\0', 'utf8')
      .update(context.deliveryEmail, 'utf8')
      .update('\0', 'utf8')
      .update(secret, 'utf8')
      .digest();
  }

  private outboxAdditionalData(outboxId: string, keyVersion: string): Buffer {
    return Buffer.from(`${OUTBOX_DOMAIN}\0${ENVELOPE_VERSION}\0${keyVersion}\0${outboxId}`, 'utf8');
  }

  private passwordResetRequestAdditionalData(requestId: string, keyVersion: string): Buffer {
    return Buffer.from(
      `${PASSWORD_RESET_REQUEST_DOMAIN}\0${PASSWORD_RESET_REQUEST_ENVELOPE_VERSION}\0${keyVersion}\0${requestId}`,
      'utf8',
    );
  }

  private decodeBase64Url(value: string): Buffer | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  }
}

function isPasswordResetRequestPayload(value: unknown): value is { email: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.email === 'string' &&
    record.email.length <= 254 &&
    record.email === record.email.trim().toLowerCase() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)
  );
}

function isEmailOutboxPayload(value: unknown): value is EmailOutboxPayload {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  const record = value as Record<string, unknown>;

  if (record.kind === 'email_verification') {
    const keys = Object.keys(record).sort();
    const continuationPath = record.continuationPath;
    const allowedKeys = continuationPath === undefined
      ? ['code', 'kind']
      : ['code', 'continuationPath', 'kind'];
    return (
      keys.length === allowedKeys.length &&
      keys.every((key, index) => key === allowedKeys[index]) &&
      typeof record.code === 'string' &&
      /^\d{6}$/.test(record.code) &&
      (continuationPath === undefined ||
        continuationPath === INVITE_EMAIL_CONTINUATION_PATH)
    );
  }

  return (
    Object.keys(record).length === 2 &&
    record.kind === 'password_reset' &&
    typeof record.resetToken === 'string' &&
    /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(record.resetToken)
  );
}
