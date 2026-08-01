import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EmailOutboxStatus, Prisma, UserActionTokenPurpose } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ActionTokenCryptoService } from './action-token-crypto.service';
import {
  EmailDeliveryError,
  TRANSACTIONAL_EMAIL_PROVIDER,
  type TransactionalEmailProvider,
} from './transactional-email.provider';
import { renderTransactionalEmail } from './transactional-email.templates';

const DISPATCH_INTERVAL_MS = 5_000;
const LOCK_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_BATCH_SIZE = 10;

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);
  private dispatchInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ActionTokenCryptoService,
    private readonly config: ConfigService,
    @Inject(TRANSACTIONAL_EMAIL_PROVIDER)
    private readonly provider: TransactionalEmailProvider,
  ) {}

  kick(outboxId: string): void {
    if (!this.emailDeliveryEnabled()) return;
    void this.processOne(outboxId).catch(() => undefined);
  }

  @Interval('transactional-email-outbox', DISPATCH_INTERVAL_MS)
  async dispatchPending(): Promise<void> {
    if (!this.emailDeliveryEnabled()) return;
    if (this.dispatchInProgress) return;
    this.dispatchInProgress = true;

    try {
      for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
        const processed = await this.processOne();
        if (!processed) return;
      }
    } finally {
      this.dispatchInProgress = false;
    }
  }

  private async processOne(requestedId?: string): Promise<boolean> {
    if (!this.emailDeliveryEnabled()) return false;
    const now = new Date();
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const claimable: Prisma.EmailOutboxWhereInput = {
      payloadCiphertext: { not: null },
      nextAttemptAt: { lte: now },
      OR: [
        { status: EmailOutboxStatus.pending },
        {
          status: EmailOutboxStatus.processing,
          lockedAt: { lte: staleBefore },
        },
      ],
    };

    const candidate = requestedId
      ? await this.prisma.emailOutbox.findFirst({
          where: { id: requestedId, ...claimable },
          select: { id: true },
        })
      : await this.prisma.emailOutbox.findFirst({
          where: claimable,
          select: { id: true },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        });
    if (!candidate) return false;

    const lockedAt = new Date();
    const claimed = await this.prisma.emailOutbox.updateMany({
      where: { id: candidate.id, ...claimable },
      data: {
        status: EmailOutboxStatus.processing,
        lockedAt,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return true;

    const outbox = await this.prisma.emailOutbox.findUnique({
      where: { id: candidate.id },
      include: { token: true },
    });
    if (!outbox || !outbox.payloadCiphertext) return true;

    const token = outbox.token;
    const tokenActive =
      !token.consumedAt &&
      !token.revokedAt &&
      token.expiresAt > new Date();
    if (!tokenActive) {
      await this.discard(outbox.id, lockedAt, 'TOKEN_INACTIVE');
      return true;
    }

    let delivered: { providerMessageId: string };
    try {
      const payload = this.crypto.decryptOutboxPayload(outbox.id, {
        payloadCiphertext: outbox.payloadCiphertext,
        payloadKeyVersion: outbox.payloadKeyVersion,
      });
      if (!payloadMatchesPurpose(payload.kind, token.purpose)) {
        await this.discard(outbox.id, lockedAt, 'PURPOSE_MISMATCH');
        return true;
      }

      const webOrigin = this.config.getOrThrow<string>('WEB_ORIGIN').split(',')[0]?.trim();
      if (!webOrigin) throw new EmailDeliveryError('WEB_ORIGIN_MISSING', false);
      const message = renderTransactionalEmail({
        outboxId: outbox.id,
        tokenId: token.id,
        recipient: token.deliveryEmail,
        payload,
        webOrigin,
        publicApiOrigin:
          this.config.get<string>('PUBLIC_API_ORIGIN') ?? 'http://127.0.0.1:8180',
        verificationTtlMinutes:
          this.config.get<number>('EMAIL_VERIFICATION_TTL_MINUTES') ?? 15,
        resetTtlMinutes: this.config.get<number>('PASSWORD_RESET_TTL_MINUTES') ?? 30,
        supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
      });
      delivered = await this.provider.send(message);
    } catch (error) {
      const deliveryError =
        error instanceof EmailDeliveryError
          ? error
          : new EmailDeliveryError('OUTBOX_PAYLOAD_INVALID', false);
      const canRetry =
        deliveryError.retryable &&
        outbox.attempts < MAX_ATTEMPTS &&
        token.expiresAt > new Date(Date.now() + retryDelayMs(outbox.attempts));

      if (canRetry) {
        await this.prisma.emailOutbox.updateMany({
          where: {
            id: outbox.id,
            status: EmailOutboxStatus.processing,
            lockedAt,
          },
          data: {
            status: EmailOutboxStatus.pending,
            nextAttemptAt: new Date(Date.now() + retryDelayMs(outbox.attempts)),
            lockedAt: null,
            lastErrorCode: deliveryError.code,
          },
        });
      } else {
        await this.discard(outbox.id, lockedAt, deliveryError.code);
      }

      this.logger.warn(`Transactional email delivery deferred (${deliveryError.code})`);
      return true;
    }

    // Do not classify a persistence failure as a delivery failure. Leaving the
    // row processing lets stale-lock recovery retry with the same provider
    // idempotency key after the database becomes available again.
    await this.prisma.emailOutbox.updateMany({
      where: {
        id: outbox.id,
        status: EmailOutboxStatus.processing,
        lockedAt,
      },
      data: {
        status: EmailOutboxStatus.sent,
        payloadCiphertext: null,
        nextAttemptAt: null,
        providerMessageId: delivered.providerMessageId,
        sentAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
      },
    });

    return true;
  }

  private emailDeliveryEnabled(): boolean {
    return (this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') === 'resend';
  }

  private async discard(outboxId: string, lockedAt: Date, errorCode: string) {
    await this.prisma.emailOutbox.updateMany({
      where: {
        id: outboxId,
        status: EmailOutboxStatus.processing,
        lockedAt,
      },
      data: {
        status: EmailOutboxStatus.discarded,
        payloadCiphertext: null,
        nextAttemptAt: null,
        discardedAt: new Date(),
        lockedAt: null,
        lastErrorCode: errorCode,
      },
    });
  }
}

function payloadMatchesPurpose(
  kind: 'email_verification' | 'password_reset',
  purpose: UserActionTokenPurpose,
): boolean {
  return kind === purpose;
}

function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}
