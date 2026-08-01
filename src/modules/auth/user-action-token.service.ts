import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  EmailOutboxStatus,
  PasswordResetRequestStatus,
  Prisma,
  UserActionTokenPurpose,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ActionTokenCryptoService,
  type ActionTokenPurpose,
  type EmailOutboxPayload,
} from './action-token-crypto.service';
import { assertPasswordFitsBcrypt, maskEmail, normalizeEmail } from './auth-security.util';
import { EmailOutboxService } from './email-outbox.service';

const SERIALIZABLE_RETRIES = 3;
const PASSWORD_RESET_REQUEST_DISPATCH_INTERVAL_MS = 5_000;
const PASSWORD_RESET_REQUEST_LOCK_TIMEOUT_MS = 60_000;
const PASSWORD_RESET_REQUEST_MAX_BATCH_SIZE = 10;

export interface VerificationMetadata {
  challengeId: string;
  destinationMasked: string;
  resendAvailableAt: Date;
  expiresAt: Date;
}

export interface PreparedActionToken {
  token: {
    id: string;
    purpose: UserActionTokenPurpose;
    secretHash: string;
    deliveryEmail: string;
    userId: string;
    expiresAt: Date;
    createdAt: Date;
  };
  outbox: {
    id: string;
    payloadCiphertext: string;
    payloadKeyVersion: string;
    nextAttemptAt: Date;
  };
}

interface LockedTokenRow {
  id: string;
  purpose: UserActionTokenPurpose;
  secretHash: string;
  deliveryEmail: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

interface LockedPasswordResetRequestRow {
  id: string;
  status: PasswordResetRequestStatus;
  emailCiphertext: string | null;
  payloadKeyVersion: string;
  lockedAt: Date | null;
  expiresAt: Date;
}

@Injectable()
export class UserActionTokenService {
  private readonly logger = new Logger(UserActionTokenService.name);
  private passwordResetDispatchInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ActionTokenCryptoService,
    private readonly outbox: EmailOutboxService,
    private readonly config: ConfigService,
  ) {}

  prepareEmailVerification(userId: string, deliveryEmail: string, now = new Date()): PreparedActionToken {
    const code = this.crypto.generateVerificationCode();
    return this.prepare({
      purpose: UserActionTokenPurpose.email_verification,
      userId,
      deliveryEmail,
      secret: code,
      payload: { kind: 'email_verification', code },
      ttlMinutes: this.config.get<number>('EMAIL_VERIFICATION_TTL_MINUTES') ?? 15,
      now,
    });
  }

  preparePasswordReset(userId: string, deliveryEmail: string, now = new Date()): PreparedActionToken {
    const tokenId = randomUUID();
    const secret = this.crypto.generateResetSecret();
    return this.prepare({
      purpose: UserActionTokenPurpose.password_reset,
      userId,
      deliveryEmail,
      secret,
      tokenId,
      payload: { kind: 'password_reset', resetToken: `${tokenId}.${secret}` },
      ttlMinutes: this.config.get<number>('PASSWORD_RESET_TTL_MINUTES') ?? 30,
      now,
    });
  }

  async createPrepared(
    tx: Prisma.TransactionClient,
    prepared: PreparedActionToken,
  ): Promise<void> {
    await tx.userActionToken.create({
      data: {
        ...prepared.token,
        emailOutbox: {
          create: {
            id: prepared.outbox.id,
            payloadCiphertext: prepared.outbox.payloadCiphertext,
            payloadKeyVersion: prepared.outbox.payloadKeyVersion,
            nextAttemptAt: prepared.outbox.nextAttemptAt,
          },
        },
      },
    });
  }

  verificationMetadata(prepared: PreparedActionToken): VerificationMetadata {
    return {
      challengeId: prepared.token.id,
      destinationMasked: maskEmail(prepared.token.deliveryEmail),
      resendAvailableAt: new Date(
        prepared.token.createdAt.getTime() + this.resendCooldownMs(),
      ),
      expiresAt: prepared.token.expiresAt,
    };
  }

  dispatchPrepared(prepared: PreparedActionToken): void {
    this.outbox.kick(prepared.outbox.id);
  }

  async resendEmailVerification(challengeId: string): Promise<VerificationMetadata> {
    this.assertEmailDeliveryEnabled();
    const original = await this.prisma.userActionToken.findUnique({
      where: { id: challengeId },
      select: { userId: true, purpose: true },
    });
    if (!original || original.purpose !== UserActionTokenPurpose.email_verification) {
      this.crypto.secretMatches(dummyContext(UserActionTokenPurpose.email_verification), '000000', 'invalid');
      throw invalidVerificationError();
    }

    const result = await this.withSerializableRetry(async (tx) => {
      await this.lockUser(tx, original.userId);
      const user = await tx.user.findUnique({
        where: { id: original.userId },
        select: { id: true, email: true, emailVerifiedAt: true, isActive: true },
      });
      if (!user?.isActive || user.emailVerifiedAt) throw invalidVerificationError();

      const issuance = await this.checkIssuancePolicy(
        tx,
        user.id,
        UserActionTokenPurpose.email_verification,
        new Date(),
      );
      if (!issuance.allowed && issuance.latest) {
        return {
          metadata: this.metadataFromRow(issuance.latest),
          outboxId: undefined,
        };
      }
      if (!issuance.allowed) throw invalidVerificationError();

      const prepared = this.prepareEmailVerification(user.id, user.email);
      await this.revokeActiveTokens(tx, user.id, UserActionTokenPurpose.email_verification);
      await this.createPrepared(tx, prepared);
      return {
        metadata: this.verificationMetadata(prepared),
        outboxId: prepared.outbox.id,
      };
    });

    if (result.outboxId) this.outbox.kick(result.outboxId);
    return result.metadata;
  }

  async confirmEmailVerification(challengeId: string, code: string): Promise<string> {
    const original = await this.prisma.userActionToken.findUnique({
      where: { id: challengeId },
      select: { userId: true },
    });
    if (!original) {
      this.crypto.secretMatches(dummyContext(UserActionTokenPurpose.email_verification), code, 'invalid');
      throw invalidVerificationError();
    }

    const outcome = await this.withSerializableRetry(async (tx) => {
      await this.lockUser(tx, original.userId);
      const token = await this.lockToken(tx, challengeId);
      const context = token
        ? tokenContext(token)
        : dummyContext(UserActionTokenPurpose.email_verification);
      const secretMatches = this.crypto.secretMatches(
        context,
        code,
        token?.secretHash ?? 'invalid',
      );
      const now = new Date();
      const maxAttempts = this.config.get<number>('ACTION_TOKEN_MAX_ATTEMPTS') ?? 5;
      const active = Boolean(
        token &&
          token.purpose === UserActionTokenPurpose.email_verification &&
          !token.consumedAt &&
          !token.revokedAt &&
          token.expiresAt > now &&
          token.attempts < maxAttempts,
      );

      if (!token || !active || !secretMatches) {
        if (token && active) {
          const attempts = token.attempts + 1;
          await tx.userActionToken.update({
            where: { id: token.id },
            data: {
              attempts,
              lastAttemptAt: now,
              ...(attempts >= maxAttempts ? { revokedAt: now } : {}),
            },
          });
        }
        return undefined;
      }

      const user = await tx.user.findUnique({
        where: { id: token.userId },
        select: { id: true, isActive: true, emailVerifiedAt: true },
      });
      if (!user?.isActive || user.emailVerifiedAt) return undefined;

      await tx.userActionToken.update({
        where: { id: token.id },
        data: { consumedAt: now, lastAttemptAt: now },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: now },
      });
      await this.revokeActiveTokens(
        tx,
        user.id,
        UserActionTokenPurpose.email_verification,
        token.id,
      );
      return user.id;
    });

    if (!outcome) throw invalidVerificationError();
    return outcome;
  }

  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const requestId = randomUUID();
    const now = new Date();
    const encrypted = this.crypto.encryptPasswordResetRequest(requestId, email);
    const ttlMinutes = this.config.get<number>('PASSWORD_RESET_TTL_MINUTES') ?? 30;

    await this.prisma.passwordResetRequest.create({
      data: {
        id: requestId,
        ...encrypted,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
        createdAt: now,
      },
    });

    this.kickPasswordResetRequest(requestId);
  }

  @Interval(
    'password-reset-request-dispatch',
    PASSWORD_RESET_REQUEST_DISPATCH_INTERVAL_MS,
  )
  async dispatchPasswordResetRequests(): Promise<void> {
    if (this.passwordResetDispatchInProgress) return;
    this.passwordResetDispatchInProgress = true;

    try {
      for (let index = 0; index < PASSWORD_RESET_REQUEST_MAX_BATCH_SIZE; index += 1) {
        try {
          const processed = await this.processPasswordResetRequest();
          if (!processed) return;
        } catch {
          // Keep the processing lease intact. The next interval can recover it
          // after the stale-lock timeout without risking a duplicate issuance.
          this.logger.warn('Password-reset request processing could not be completed');
          return;
        }
      }
    } finally {
      this.passwordResetDispatchInProgress = false;
    }
  }

  private kickPasswordResetRequest(requestId: string): void {
    void this.processPasswordResetRequest(requestId).catch(() => {
      this.logger.warn('Password-reset request processing could not be completed');
    });
  }

  private async processPasswordResetRequest(requestedId?: string): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PASSWORD_RESET_REQUEST_LOCK_TIMEOUT_MS);
    const claimable: Prisma.PasswordResetRequestWhereInput = {
      emailCiphertext: { not: null },
      nextAttemptAt: { lte: now },
      ...(!this.emailDeliveryEnabled() ? { expiresAt: { lte: now } } : {}),
      OR: [
        { status: PasswordResetRequestStatus.pending },
        {
          status: PasswordResetRequestStatus.processing,
          lockedAt: { lte: staleBefore },
        },
      ],
    };

    const candidate = requestedId
      ? await this.prisma.passwordResetRequest.findFirst({
          where: { id: requestedId, ...claimable },
          select: { id: true },
        })
      : await this.prisma.passwordResetRequest.findFirst({
          where: claimable,
          select: { id: true },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        });
    if (!candidate) return false;

    const lockedAt = new Date();
    const claimed = await this.prisma.passwordResetRequest.updateMany({
      where: { id: candidate.id, ...claimable },
      data: {
        status: PasswordResetRequestStatus.processing,
        lockedAt,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return true;

    const request = await this.prisma.passwordResetRequest.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        emailCiphertext: true,
        payloadKeyVersion: true,
        expiresAt: true,
      },
    });
    if (!request?.emailCiphertext) return true;

    if (request.expiresAt <= new Date()) {
      await this.discardPasswordResetRequest(request.id, lockedAt, 'REQUEST_EXPIRED');
      return true;
    }

    // Configuration is static in normal operation, but this closes the race if
    // a test or dynamic configuration disables delivery after the claim.
    if (!this.emailDeliveryEnabled()) {
      await this.releasePasswordResetRequest(request.id, lockedAt, 'EMAIL_PROVIDER_DISABLED');
      return true;
    }

    let email: string;
    try {
      email = this.crypto.decryptPasswordResetRequest(request.id, {
        emailCiphertext: request.emailCiphertext,
        payloadKeyVersion: request.payloadKeyVersion,
      });
    } catch {
      await this.discardPasswordResetRequest(request.id, lockedAt, 'PAYLOAD_INVALID');
      return true;
    }

    const result = await this.withSerializableRetry(async (tx) => {
      const lockedRequest = await this.lockPasswordResetRequest(tx, request.id);
      if (!ownsPasswordResetLease(lockedRequest, lockedAt)) {
        return { outboxId: undefined };
      }

      const completedAt = new Date();
      if (lockedRequest.expiresAt <= completedAt) {
        await this.finalizePasswordResetRequest(
          tx,
          request.id,
          lockedAt,
          PasswordResetRequestStatus.discarded,
          completedAt,
          'REQUEST_EXPIRED',
        );
        return { outboxId: undefined };
      }

      const candidateUser = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      let outboxId: string | undefined;

      if (candidateUser) {
        await this.lockUser(tx, candidateUser.id);
        const user = await tx.user.findUnique({
          where: { id: candidateUser.id },
          select: {
            id: true,
            email: true,
            isActive: true,
            emailVerifiedAt: true,
            profile: { select: { status: true } },
          },
        });
        const eligible = Boolean(
          user?.isActive &&
            user.emailVerifiedAt &&
            user.email === email &&
            user.profile?.status === 'active',
        );

        if (eligible && user) {
          const issuance = await this.checkIssuancePolicy(
            tx,
            user.id,
            UserActionTokenPurpose.password_reset,
            completedAt,
          );
          if (issuance.allowed) {
            const prepared = this.preparePasswordReset(user.id, user.email, completedAt);
            await this.revokeActiveTokens(
              tx,
              user.id,
              UserActionTokenPurpose.password_reset,
            );
            await this.createPrepared(tx, prepared);
            outboxId = prepared.outbox.id;
          }
        }
      }

      await this.finalizePasswordResetRequest(
        tx,
        request.id,
        lockedAt,
        PasswordResetRequestStatus.completed,
        completedAt,
      );
      return { outboxId };
    });

    if (result.outboxId) this.outbox.kick(result.outboxId);
    return true;
  }

  async validatePasswordResetToken(rawToken: string): Promise<{ expiresAt: Date } | undefined> {
    const parsed = parseResetToken(rawToken);
    const token = parsed
      ? await this.prisma.userActionToken.findUnique({ where: { id: parsed.tokenId } })
      : null;
    const context = token ? tokenContext(token) : dummyContext(UserActionTokenPurpose.password_reset);
    const matches = this.crypto.secretMatches(
      context,
      parsed?.secret ?? '',
      token?.secretHash ?? 'invalid',
    );
    const now = new Date();
    if (
      !parsed ||
      !token ||
      token.purpose !== UserActionTokenPurpose.password_reset ||
      token.consumedAt ||
      token.revokedAt ||
      token.expiresAt <= now ||
      !matches
    ) {
      return undefined;
    }

    return { expiresAt: token.expiresAt };
  }

  setPasswordResetCookie(response: Response, rawToken: string, expiresAt: Date): void {
    response.cookie(this.passwordResetCookieName(), rawToken, {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      sameSite: 'lax',
      path: '/auth/password-reset',
      maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
    });
  }

  clearPasswordResetCookie(response: Response): void {
    response.clearCookie(this.passwordResetCookieName(), {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      sameSite: 'lax',
      path: '/auth/password-reset',
    });
  }

  passwordResetCookieName(): string {
    return this.config.get<boolean>('COOKIE_SECURE')
      ? '__Secure-financeiro-password-reset'
      : 'financeiro-password-reset';
  }

  async confirmPasswordReset(
    rawToken: string,
    password: string,
    passwordConfirmation: string,
  ): Promise<void> {
    if (password !== passwordConfirmation) {
      throw new BadRequestException('As senhas não coincidem.');
    }
    assertPasswordFitsBcrypt(password);
    const passwordHash = await bcrypt.hash(password, 12);
    const parsed = parseResetToken(rawToken);
    const original = parsed
      ? await this.prisma.userActionToken.findUnique({
          where: { id: parsed.tokenId },
          select: { userId: true },
        })
      : null;
    if (!parsed || !original) {
      this.crypto.secretMatches(dummyContext(UserActionTokenPurpose.password_reset), '', 'invalid');
      throw invalidResetError();
    }

    const reset = await this.withSerializableRetry(async (tx) => {
      await this.lockUser(tx, original.userId);
      const token = await this.lockToken(tx, parsed.tokenId);
      const context = token ? tokenContext(token) : dummyContext(UserActionTokenPurpose.password_reset);
      const matches = this.crypto.secretMatches(
        context,
        parsed.secret,
        token?.secretHash ?? 'invalid',
      );
      const now = new Date();
      if (
        !token ||
        token.purpose !== UserActionTokenPurpose.password_reset ||
        token.consumedAt ||
        token.revokedAt ||
        token.expiresAt <= now ||
        !matches
      ) {
        return false;
      }

      const user = await tx.user.findUnique({
        where: { id: token.userId },
        select: { id: true, isActive: true, emailVerifiedAt: true },
      });
      if (!user?.isActive || !user.emailVerifiedAt) return false;

      await tx.userActionToken.update({
        where: { id: token.id },
        data: { consumedAt: now },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, authVersion: { increment: 1 } },
      });
      await this.revokeActiveTokens(
        tx,
        user.id,
        UserActionTokenPurpose.password_reset,
        token.id,
      );
      return true;
    });

    if (!reset) throw invalidResetError();
  }

  private prepare(input: {
    purpose: UserActionTokenPurpose;
    userId: string;
    deliveryEmail: string;
    secret: string;
    payload: EmailOutboxPayload;
    ttlMinutes: number;
    tokenId?: string;
    now: Date;
  }): PreparedActionToken {
    const tokenId = input.tokenId ?? randomUUID();
    const outboxId = randomUUID();
    const deliveryEmail = normalizeEmail(input.deliveryEmail);
    const context = {
      purpose: input.purpose as ActionTokenPurpose,
      tokenId,
      userId: input.userId,
      deliveryEmail,
    };
    const encrypted = this.crypto.encryptOutboxPayload(outboxId, input.payload);

    return {
      token: {
        id: tokenId,
        purpose: input.purpose,
        secretHash: this.crypto.hashSecret(context, input.secret),
        deliveryEmail,
        userId: input.userId,
        expiresAt: new Date(input.now.getTime() + input.ttlMinutes * 60_000),
        createdAt: input.now,
      },
      outbox: {
        id: outboxId,
        ...encrypted,
        nextAttemptAt: input.now,
      },
    };
  }

  private async checkIssuancePolicy(
    tx: Prisma.TransactionClient,
    userId: string,
    purpose: UserActionTokenPurpose,
    now: Date,
  ) {
    const latest = await tx.userActionToken.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deliveryEmail: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    if (latest && now.getTime() - latest.createdAt.getTime() < this.resendCooldownMs()) {
      return { allowed: false as const, latest };
    }

    const [lastHour, lastDay] = await Promise.all([
      tx.userActionToken.count({
        where: { userId, purpose, createdAt: { gte: new Date(now.getTime() - 60 * 60_000) } },
      }),
      tx.userActionToken.count({
        where: { userId, purpose, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      }),
    ]);
    const hourlyLimit = this.config.get<number>('ACTION_TOKEN_HOURLY_LIMIT') ?? 5;
    const dailyLimit = this.config.get<number>('ACTION_TOKEN_DAILY_LIMIT') ?? 10;
    return {
      allowed: lastHour < hourlyLimit && lastDay < dailyLimit,
      latest,
    };
  }

  private async revokeActiveTokens(
    tx: Prisma.TransactionClient,
    userId: string,
    purpose: UserActionTokenPurpose,
    exceptId?: string,
  ) {
    const active = await tx.userActionToken.findMany({
      where: {
        userId,
        purpose,
        consumedAt: null,
        revokedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (active.length === 0) return;

    const tokenIds = active.map((token) => token.id);
    const revokedAt = new Date();
    await tx.userActionToken.updateMany({
      where: { id: { in: tokenIds }, consumedAt: null, revokedAt: null },
      data: { revokedAt },
    });
    await tx.emailOutbox.updateMany({
      where: {
        userActionTokenId: { in: tokenIds },
        status: { in: [EmailOutboxStatus.pending, EmailOutboxStatus.processing] },
      },
      data: {
        status: EmailOutboxStatus.discarded,
        payloadCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        discardedAt: revokedAt,
        lastErrorCode: 'TOKEN_REVOKED',
      },
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
    `;
  }

  private async lockPasswordResetRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<LockedPasswordResetRequestRow | undefined> {
    const rows = await tx.$queryRaw<LockedPasswordResetRequestRow[]>`
      SELECT
        "id", "status", "emailCiphertext", "payloadKeyVersion", "lockedAt", "expiresAt"
      FROM "PasswordResetRequest"
      WHERE "id" = ${requestId}
      FOR UPDATE
    `;
    return rows[0];
  }

  private async finalizePasswordResetRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
    lockedAt: Date,
    status: 'completed' | 'discarded',
    terminalAt: Date,
    lastErrorCode: string | null = null,
  ): Promise<void> {
    const finalized = await tx.passwordResetRequest.updateMany({
      where: {
        id: requestId,
        status: PasswordResetRequestStatus.processing,
        lockedAt,
      },
      data: {
        status,
        emailCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        completedAt:
          status === PasswordResetRequestStatus.completed ? terminalAt : null,
        discardedAt:
          status === PasswordResetRequestStatus.discarded ? terminalAt : null,
        lastErrorCode,
      },
    });
    if (finalized.count !== 1) {
      throw new Error('Password-reset request lease was lost before completion');
    }
  }

  private async discardPasswordResetRequest(
    requestId: string,
    lockedAt: Date,
    lastErrorCode: string,
  ): Promise<void> {
    await this.prisma.passwordResetRequest.updateMany({
      where: {
        id: requestId,
        status: PasswordResetRequestStatus.processing,
        lockedAt,
      },
      data: {
        status: PasswordResetRequestStatus.discarded,
        emailCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        discardedAt: new Date(),
        lastErrorCode,
      },
    });
  }

  private async releasePasswordResetRequest(
    requestId: string,
    lockedAt: Date,
    lastErrorCode: string,
  ): Promise<void> {
    await this.prisma.passwordResetRequest.updateMany({
      where: {
        id: requestId,
        status: PasswordResetRequestStatus.processing,
        lockedAt,
      },
      data: {
        status: PasswordResetRequestStatus.pending,
        lockedAt: null,
        lastErrorCode,
      },
    });
  }

  private async lockToken(
    tx: Prisma.TransactionClient,
    tokenId: string,
  ): Promise<LockedTokenRow | undefined> {
    const rows = await tx.$queryRaw<LockedTokenRow[]>`
      SELECT
        "id", "purpose", "secretHash", "deliveryEmail", "userId", "expiresAt",
        "consumedAt", "revokedAt", "attempts", "createdAt"
      FROM "UserActionToken"
      WHERE "id" = ${tokenId}
      FOR UPDATE
    `;
    return rows[0];
  }

  private metadataFromRow(row: {
    id: string;
    deliveryEmail: string;
    expiresAt: Date;
    createdAt: Date;
  }): VerificationMetadata {
    return {
      challengeId: row.id,
      destinationMasked: maskEmail(row.deliveryEmail),
      resendAvailableAt: new Date(row.createdAt.getTime() + this.resendCooldownMs()),
      expiresAt: row.expiresAt,
    };
  }

  private resendCooldownMs(): number {
    return (this.config.get<number>('EMAIL_RESEND_COOLDOWN_SECONDS') ?? 60) * 1_000;
  }

  private emailDeliveryEnabled(): boolean {
    return (this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') === 'resend';
  }

  private assertEmailDeliveryEnabled() {
    if (!this.emailDeliveryEnabled()) {
      throw new ServiceUnavailableException('Envio de e-mail indisponível.');
    }
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRIES - 1) throw error;
      }
    }
    throw new Error('Unreachable transaction retry state');
  }
}

function tokenContext(token: {
  purpose: UserActionTokenPurpose;
  id: string;
  userId: string;
  deliveryEmail: string;
}) {
  return {
    purpose: token.purpose as ActionTokenPurpose,
    tokenId: token.id,
    userId: token.userId,
    deliveryEmail: token.deliveryEmail,
  };
}

function dummyContext(purpose: UserActionTokenPurpose) {
  return {
    purpose: purpose as ActionTokenPurpose,
    tokenId: '00000000-0000-4000-8000-000000000000',
    userId: '00000000-0000-4000-8000-000000000000',
    deliveryEmail: 'invalid@example.invalid',
  };
}

function ownsPasswordResetLease(
  request: LockedPasswordResetRequestRow | undefined,
  lockedAt: Date,
): request is LockedPasswordResetRequestRow {
  return Boolean(
    request &&
      request.status === PasswordResetRequestStatus.processing &&
      request.emailCiphertext &&
      request.lockedAt?.getTime() === lockedAt.getTime(),
  );
}

function parseResetToken(value: string | undefined) {
  if (!value) return undefined;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
    value,
  );
  if (!match?.[1] || !match[2]) return undefined;
  return { tokenId: match[1], secret: match[2] };
}

function invalidVerificationError() {
  return new BadRequestException('Código inválido ou expirado.');
}

function invalidResetError() {
  return new BadRequestException('Link de redefinição inválido ou expirado.');
}

function isRetryableTransactionError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2034');
}
