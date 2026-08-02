import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  EmailOutboxStatus,
  PasswordResetRequestStatus,
  UserActionTokenPurpose,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { ActionTokenCryptoService } from '../action-token-crypto.service';
import { pendingInviteEmail, pendingOwnerEmail } from '../auth-security.util';
import type { EmailOutboxService } from '../email-outbox.service';
import { UserActionTokenService } from '../user-action-token.service';

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('new-bcrypt-hash') },
}));

const userId = '22222222-2222-4222-8222-222222222222';
const challengeId = '11111111-1111-4111-8111-111111111111';
const requestId = '33333333-3333-4333-8333-333333333333';
const resetSecret = 'A'.repeat(43);
const resetToken = `${challengeId}.${resetSecret}`;
const activeSubscription = {
  providerStatus: 'ACTIVE',
  lastProviderEvent: 'subscription.renewed',
  providerUpdatedAt: new Date(),
  lastSuccessfulPaymentAt: new Date(),
  accessPaidThrough: new Date(Date.now() + 86_400_000),
  paymentFailedAt: null,
  graceUntil: null,
  cancelledAt: null,
  cancelRequestedAt: null,
  cancelledDueTo: null,
  lastInstallmentNumber: 1,
  entitlementContractVersion: 'v1',
  billingCycle: 'MONTHLY',
  paymentMethod: 'CARD',
};

function pendingProfile(status = 'pending', currentSubscription: unknown = activeSubscription) {
  return {
    familyId: 'family-1',
    status,
    family: { currentSubscription },
  };
}

function pendingApproval(requestedEmail = 'owner@example.com') {
  return {
    id: 'approval-1',
    inviteId: 'invite-1',
    familyId: 'family-1',
    requestedEmail,
    invite: { id: 'invite-1', familyId: 'family-1', status: 'used' },
  };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: challengeId,
    purpose: UserActionTokenPurpose.email_verification,
    secretHash: 'valid-hmac',
    deliveryEmail: 'owner@example.com',
    userId,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    consumedAt: null,
    revokedAt: null,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function setup() {
  const tx = {
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    userActionToken: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    memberProfile: {
      findUnique: vi.fn().mockResolvedValue({
        familyId: 'family-1',
        status: 'active',
      }),
    },
    family: { findFirst: vi.fn().mockResolvedValue({ id: 'family-1' }) },
    memberApproval: { findMany: vi.fn().mockResolvedValue([]) },
    emailOutbox: { updateMany: vi.fn() },
    passwordResetRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    userActionToken: { findUnique: vi.fn() },
    passwordResetRequest: {
      create: vi.fn().mockResolvedValue({ id: requestId }),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaService;
  const crypto = {
    generateVerificationCode: vi.fn().mockReturnValue('000042'),
    generateResetSecret: vi.fn().mockReturnValue(resetSecret),
    hashSecret: vi.fn().mockReturnValue('valid-hmac'),
    encryptOutboxPayload: vi.fn().mockReturnValue({
      payloadCiphertext: 'encrypted-payload',
      payloadKeyVersion: 'v1',
    }),
    encryptPasswordResetRequest: vi.fn().mockReturnValue({
      emailCiphertext: 'encrypted-email',
      payloadKeyVersion: 'v1',
    }),
    decryptPasswordResetRequest: vi.fn().mockReturnValue('owner@example.com'),
    secretMatches: vi.fn().mockReturnValue(true),
  } as unknown as ActionTokenCryptoService;
  const outbox = { kick: vi.fn() } as unknown as EmailOutboxService;
  const values: Record<string, unknown> = {
    EMAIL_PROVIDER: 'resend',
    EMAIL_VERIFICATION_TTL_MINUTES: 15,
    PASSWORD_RESET_TTL_MINUTES: 30,
    ACTION_TOKEN_MAX_ATTEMPTS: 5,
    ACTION_TOKEN_HOURLY_LIMIT: 5,
    ACTION_TOKEN_DAILY_LIMIT: 10,
    ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT: 3,
    ACTION_TOKEN_RECIPIENT_DAILY_LIMIT: 10,
    EMAIL_RESEND_COOLDOWN_SECONDS: 60,
    COOKIE_SECURE: false,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const service = new UserActionTokenService(prisma, crypto, outbox, config);
  return { crypto, outbox, prisma, service, tx, values };
}

beforeEach(() => vi.clearAllMocks());

describe('UserActionTokenService email verification', () => {
  it('atomically consumes a valid challenge, verifies the user and revokes sibling challenges', async () => {
    const { crypto, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      familyId: 'family-1',
      email: 'owner@example.com',
      isActive: true,
      emailVerifiedAt: null,
    });
    tx.userActionToken.findMany.mockResolvedValue([{ id: 'sibling-token' }]);

    await expect(service.confirmEmailVerification(challengeId, '000042')).resolves.toBe(userId);

    expect(crypto.secretMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: UserActionTokenPurpose.email_verification,
        tokenId: challengeId,
        userId,
        deliveryEmail: 'owner@example.com',
      }),
      '000042',
      'valid-hmac',
    );
    expect(tx.userActionToken.update).toHaveBeenCalledWith({
      where: { id: challengeId },
      data: { consumedAt: expect.any(Date), lastAttemptAt: expect.any(Date) },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { emailVerifiedAt: expect.any(Date) },
    });
    expect(tx.userActionToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['sibling-token'] },
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EmailOutboxStatus.discarded,
          payloadCiphertext: null,
          nextAttemptAt: null,
          lastErrorCode: 'TOKEN_REVOKED',
        }),
      }),
    );
  });

  it('não usa a rota genérica para verificar usuário legado que não é owner', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      familyId: 'family-1',
      email: 'owner@example.com',
      isActive: true,
      emailVerifiedAt: null,
    });
    tx.family.findFirst.mockResolvedValue(null);

    await expect(
      service.confirmEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
  });

  it('promove atomicamente o placeholder do owner antes de consumir o desafio', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        familyId: 'family-1',
        email: pendingOwnerEmail(userId),
        isActive: true,
        emailVerifiedAt: null,
      })
      .mockResolvedValueOnce(null);

    await expect(service.confirmEmailVerification(challengeId, '000042')).resolves.toBe(
      userId,
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { email: 'owner@example.com', emailVerifiedAt: expect.any(Date) },
    });
    expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.userActionToken.update.mock.invocationCallOrder[0]!,
    );
  });

  it('traduz P2002 da promoção do owner sem consumir o desafio', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        familyId: 'family-1',
        email: pendingOwnerEmail(userId),
        isActive: true,
        emailVerifiedAt: null,
      })
      .mockResolvedValueOnce(null);
    tx.user.update.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      service.confirmEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
  });

  it('increments attempts and atomically locks the challenge at the configured maximum', async () => {
    const { crypto, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow({ attempts: 4 })]);
    vi.mocked(crypto.secretMatches).mockReturnValue(false);

    await expect(service.confirmEmailVerification(challengeId, '999999')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.userActionToken.update).toHaveBeenCalledWith({
      where: { id: challengeId },
      data: { attempts: 5, lastAttemptAt: expect.any(Date), revokedAt: expect.any(Date) },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    { consumedAt: new Date() },
    { revokedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1) },
    { attempts: 5 },
  ])('rejects replayed or inactive challenges without mutating them: %o', async (state) => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow(state)]);

    await expect(service.confirmEmailVerification(challengeId, '000042')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('performs a dummy constant-shape HMAC comparison for unknown challenges', async () => {
    const { crypto, prisma, service } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue(null);

    await expect(service.confirmEmailVerification('unknown', '123456')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(crypto.secretMatches).toHaveBeenCalledOnce();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the current metadata during resend cooldown without issuing or sending a token', async () => {
    const { outbox, prisma, service, tx } = setup();
    const createdAt = new Date();
    const latest = {
      id: challengeId,
      deliveryEmail: 'owner@example.com',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt,
    };
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      familyId: 'family-1',
      email: 'owner@example.com',
      emailVerifiedAt: null,
      isActive: true,
    });
    tx.userActionToken.findFirst.mockResolvedValue(latest);

    await expect(service.resendEmailVerification(challengeId)).resolves.toMatchObject({
      challengeId,
      expiresAt: latest.expiresAt,
      resendAvailableAt: new Date(createdAt.getTime() + 60_000),
    });
    expect(tx.userActionToken.create).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('revokes the old challenge/outbox, creates a fresh pair and kicks only after commit', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      familyId: 'family-1',
      email: 'owner@example.com',
      emailVerifiedAt: null,
      isActive: true,
    });
    tx.userActionToken.findFirst.mockResolvedValue(null);
    tx.userActionToken.findMany.mockResolvedValue([{ id: challengeId }]);

    const metadata = await service.resendEmailVerification(challengeId);

    expect(tx.userActionToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastErrorCode: 'TOKEN_REVOKED' }),
      }),
    );
    expect(tx.userActionToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: UserActionTokenPurpose.email_verification,
        emailOutbox: { create: expect.objectContaining({ payloadCiphertext: 'encrypted-payload' }) },
      }),
    });
    expect(metadata.challengeId).not.toBe(challengeId);
    expect(outbox.kick).toHaveBeenCalledOnce();
  });

  it('reenvia cadastro de owner para o deliveryEmail real, nunca para o placeholder', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        familyId: 'family-1',
        email: pendingOwnerEmail(userId),
        emailVerifiedAt: null,
        isActive: true,
      })
      .mockResolvedValueOnce(null);
    tx.userActionToken.findFirst.mockResolvedValue(null);

    await service.resendEmailVerification(challengeId);

    expect(tx.userActionToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ deliveryEmail: 'owner@example.com' }),
    });
    expect(tx.userActionToken.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ deliveryEmail: pendingOwnerEmail(userId) }),
    });
    expect(outbox.kick).toHaveBeenCalledOnce();
  });

  it('impede reenvio do owner perdedor depois que outro usuário promove o e-mail', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        familyId: 'family-1',
        email: pendingOwnerEmail(userId),
        emailVerifiedAt: null,
        isActive: true,
      })
      .mockResolvedValueOnce({ id: 'winner-user' });

    await expect(service.resendEmailVerification(challengeId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.userActionToken.create).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('aplica quota persistente por destinatário sem filtrar por userId', async () => {
    const { service, tx } = setup();
    const quotaNow = new Date('2026-08-01T12:00:00.000Z');
    tx.userActionToken.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3);

    await expect(
      service.assertEmailVerificationRecipientQuota(
        tx as never,
        ' OWNER@example.com ',
        quotaNow,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(tx.userActionToken.count).toHaveBeenCalledWith({
      where: {
        purpose: UserActionTokenPurpose.email_verification,
        deliveryEmail: 'owner@example.com',
        createdAt: { gte: new Date(quotaNow.getTime() - 60 * 60_000) },
      },
    });
    expect(tx.userActionToken.count.mock.calls[0]?.[0]?.where).not.toHaveProperty(
      'userId',
    );
  });
});

describe('UserActionTokenService pending invite verification', () => {
  it('promove o e-mail solicitado por OTP sem ativar o convidado', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        email: pendingInviteEmail(userId),
        isActive: false,
        emailVerifiedAt: null,
      })
      .mockResolvedValueOnce(null);
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.confirmPendingInviteEmailVerification(challengeId, '000042'),
    ).resolves.toBe(userId);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        email: 'owner@example.com',
        emailVerifiedAt: expect.any(Date),
      },
    });
    expect(tx.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }),
    );
  });

  it('não transforma qualquer usuário inativo em convidado elegível', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile('inactive'));

    await expect(
      service.confirmPendingInviteEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('não promove o e-mail quando o entitlement deixa de permitir acesso', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile('pending', null));
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.confirmPendingInviteEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
  });

  it('não reenvia o OTP quando o entitlement deixa de permitir acesso', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile('pending', null));
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.resendPendingInviteEmailVerification(challengeId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.create).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('reenvia para requestedEmail e nunca para o placeholder interno', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);
    tx.userActionToken.findFirst.mockResolvedValue(null);

    await expect(
      service.resendPendingInviteEmailVerification(challengeId),
    ).resolves.toMatchObject({ sent: true });

    expect(tx.userActionToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ deliveryEmail: 'owner@example.com' }),
    });
    expect(tx.userActionToken.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ deliveryEmail: pendingInviteEmail(userId) }),
    });
    expect(outbox.kick).toHaveBeenCalledOnce();
  });

  it('marca sent=false quando reutiliza desafio recente, mesmo com id diferente', async () => {
    const { outbox, prisma, service, tx } = setup();
    const newerChallengeId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);
    tx.userActionToken.findFirst.mockResolvedValue({
      id: newerChallengeId,
      deliveryEmail: 'owner@example.com',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(),
    });

    await expect(
      service.resendPendingInviteEmailVerification(challengeId),
    ).resolves.toMatchObject({
      sent: false,
      verification: { challengeId: newerChallengeId },
    });
    expect(tx.userActionToken.create).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('recupera metadados do desafio mais recente antes da confirmação', async () => {
    const { prisma, service, tx } = setup();
    const latest = tokenRow({ id: 'latest-challenge' });
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      passwordHash: 'bcrypt-hash',
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);
    tx.userActionToken.findFirst.mockResolvedValue(latest);

    await expect(
      service.pendingInviteEmailVerificationStatus(challengeId),
    ).resolves.toMatchObject({
      status: 'verify_email',
      verification: {
        challengeId: 'latest-challenge',
        destinationMasked: expect.any(String),
      },
    });
  });

  it('recupera pending_approval depois que o OTP comitou', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'owner@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'owner@example.com',
      passwordHash: 'bcrypt-hash',
      isActive: false,
      emailVerifiedAt: new Date(),
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.pendingInviteEmailVerificationStatus(challengeId),
    ).resolves.toEqual({ status: 'pending_approval' });
    expect(tx.userActionToken.findFirst).not.toHaveBeenCalled();
  });

  it('falha fechado no status quando challenge ou entitlement não corresponde', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({
      userId,
      purpose: UserActionTokenPurpose.email_verification,
      deliveryEmail: 'other@example.com',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ id: userId }]);
    tx.user.findUnique.mockResolvedValue({
      id: userId,
      email: pendingInviteEmail(userId),
      passwordHash: 'bcrypt-hash',
      isActive: false,
      emailVerifiedAt: null,
    });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile('pending', null));
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.pendingInviteEmailVerificationStatus(challengeId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.findFirst).not.toHaveBeenCalled();
  });

  it('não consome o desafio quando outro usuário já promoveu o e-mail', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        email: pendingInviteEmail(userId),
        isActive: false,
        emailVerifiedAt: null,
      })
      .mockResolvedValueOnce({ id: 'winner-user' });
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);

    await expect(
      service.confirmPendingInviteEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('traduz P2002 da promoção concorrente sem consumir o desafio', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow()]);
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: userId,
        email: pendingInviteEmail(userId),
        isActive: false,
        emailVerifiedAt: null,
      })
      .mockResolvedValueOnce(null);
    tx.memberProfile.findUnique.mockResolvedValue(pendingProfile());
    tx.memberApproval.findMany.mockResolvedValue([pendingApproval()]);
    tx.user.update.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.confirmPendingInviteEmailVerification(challengeId, '000042'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userActionToken.update).not.toHaveBeenCalled();
  });
});

describe('UserActionTokenService password reset', () => {
  it('awaits only a durable encrypted insert before returning the generic response', async () => {
    const { crypto, prisma, service } = setup();

    await expect(service.requestPasswordReset(' OWNER@example.com ')).resolves.toBeUndefined();

    expect(crypto.encryptPasswordResetRequest).toHaveBeenCalledWith(
      expect.any(String),
      'owner@example.com',
    );
    expect(prisma.passwordResetRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        emailCiphertext: 'encrypted-email',
        payloadKeyVersion: 'v1',
        nextAttemptAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('claims an eligible request and commits token, outbox and ciphertext cleanup atomically', async () => {
    const { crypto, outbox, prisma, service, tx } = setup();
    const lockedAt = new Date();
    vi.mocked(prisma.passwordResetRequest.findFirst)
      .mockResolvedValueOnce({ id: requestId } as never)
      .mockResolvedValue(null);
    vi.mocked(prisma.passwordResetRequest.findUnique).mockResolvedValue({
      id: requestId,
      emailCiphertext: 'encrypted-email',
      payloadKeyVersion: 'v1',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    } as never);
    tx.$queryRaw
      .mockImplementationOnce(() => {
        const claim = vi.mocked(prisma.passwordResetRequest.updateMany).mock.calls[0]?.[0];
        const lease = (claim?.data as { lockedAt?: Date } | undefined)?.lockedAt ?? lockedAt;
        return Promise.resolve([{
          id: requestId,
          status: PasswordResetRequestStatus.processing,
          emailCiphertext: 'encrypted-email',
          payloadKeyVersion: 'v1',
          lockedAt: lease,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        }]);
      })
      .mockResolvedValueOnce([{ id: userId }]);
    tx.user.findUnique
      .mockResolvedValueOnce({ id: userId })
      .mockResolvedValueOnce({
        id: userId,
        email: 'owner@example.com',
        isActive: true,
        emailVerifiedAt: new Date(),
        profile: { status: 'active' },
      });
    tx.userActionToken.findFirst.mockResolvedValue(null);

    await service.dispatchPasswordResetRequests();

    expect(crypto.decryptPasswordResetRequest).toHaveBeenCalledWith(requestId, {
      emailCiphertext: 'encrypted-email',
      payloadKeyVersion: 'v1',
    });
    expect(tx.userActionToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: UserActionTokenPurpose.password_reset,
        deliveryEmail: 'owner@example.com',
        emailOutbox: { create: expect.objectContaining({ payloadCiphertext: 'encrypted-payload' }) },
      }),
    });
    expect(tx.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: requestId,
        status: PasswordResetRequestStatus.processing,
        lockedAt: expect.any(Date),
      }),
      data: expect.objectContaining({
        status: PasswordResetRequestStatus.completed,
        emailCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        completedAt: expect.any(Date),
      }),
    });
    expect(outbox.kick).toHaveBeenCalledOnce();
  });

  it('completes unknown requests with the same durable terminal state and no delivery', async () => {
    const { outbox, prisma, service, tx } = setup();
    vi.mocked(prisma.passwordResetRequest.findFirst)
      .mockResolvedValueOnce({ id: requestId } as never)
      .mockResolvedValue(null);
    vi.mocked(prisma.passwordResetRequest.findUnique).mockResolvedValue({
      id: requestId,
      emailCiphertext: 'encrypted-email',
      payloadKeyVersion: 'v1',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    } as never);
    tx.$queryRaw.mockImplementationOnce(() => {
      const claim = vi.mocked(prisma.passwordResetRequest.updateMany).mock.calls[0]?.[0];
      const lease = (claim?.data as { lockedAt?: Date } | undefined)?.lockedAt;
      return Promise.resolve([{
        id: requestId,
        status: PasswordResetRequestStatus.processing,
        emailCiphertext: 'encrypted-email',
        payloadKeyVersion: 'v1',
        lockedAt: lease,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      }]);
    });
    tx.user.findUnique.mockResolvedValue(null);

    await service.dispatchPasswordResetRequests();

    expect(tx.userActionToken.create).not.toHaveBeenCalled();
    expect(tx.passwordResetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PasswordResetRequestStatus.completed,
          emailCiphertext: null,
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('retains a failed processing lease for stale-lock recovery instead of losing the request', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.passwordResetRequest.findFirst)
      .mockResolvedValueOnce({ id: requestId } as never)
      .mockResolvedValue(null);
    vi.mocked(prisma.passwordResetRequest.findUnique).mockResolvedValue({
      id: requestId,
      emailCiphertext: 'encrypted-email',
      payloadKeyVersion: 'v1',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    } as never);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.dispatchPasswordResetRequests()).resolves.toBeUndefined();

    expect(prisma.passwordResetRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: PasswordResetRequestStatus.processing,
              lockedAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
      }),
    );
    expect(prisma.passwordResetRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PasswordResetRequestStatus.processing,
          attempts: { increment: 1 },
        }),
      }),
    );
  });

  it('validates a reset secret against its domain and rejects malformed input generically', async () => {
    const { crypto, prisma, service } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue(
      tokenRow({ purpose: UserActionTokenPurpose.password_reset }) as never,
    );

    await expect(service.validatePasswordResetToken(resetToken)).resolves.toEqual({
      expiresAt: expect.any(Date),
    });
    expect(crypto.secretMatches).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: UserActionTokenPurpose.password_reset }),
      resetSecret,
      'valid-hmac',
    );

    vi.mocked(crypto.secretMatches).mockReturnValue(false);
    await expect(service.validatePasswordResetToken('malformed')).resolves.toBeUndefined();
  });

  it('consumes reset once, installs a password for Google-only access and invalidates all sessions', async () => {
    const { prisma, service, tx } = setup();
    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([tokenRow({ purpose: UserActionTokenPurpose.password_reset })]);
    tx.user.findUnique.mockResolvedValue({ id: userId, isActive: true, emailVerifiedAt: new Date() });
    tx.userActionToken.findMany.mockResolvedValue([{ id: 'another-reset-token' }]);

    await service.confirmPasswordReset(resetToken, 'new-password-123', 'new-password-123');

    expect(bcrypt.hash).toHaveBeenCalledWith('new-password-123', 12);
    expect(tx.userActionToken.update).toHaveBeenCalledWith({
      where: { id: challengeId },
      data: { consumedAt: expect.any(Date) },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { passwordHash: 'new-bcrypt-hash', authVersion: { increment: 1 } },
    });
    expect(tx.userActionToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['another-reset-token'] } }),
      }),
    );
  });

  it('rejects mismatched confirmation before token lookup and prevents replay', async () => {
    const { prisma, service, tx } = setup();

    await expect(
      service.confirmPasswordReset(resetToken, 'new-password-123', 'different-password'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.userActionToken.findUnique).not.toHaveBeenCalled();

    vi.mocked(prisma.userActionToken.findUnique).mockResolvedValue({ userId } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: userId }])
      .mockResolvedValueOnce([
        tokenRow({ purpose: UserActionTokenPurpose.password_reset, consumedAt: new Date() }),
      ]);
    await expect(service.confirmPasswordReset(resetToken, 'new-password-123', 'new-password-123')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uses a narrowly-scoped HttpOnly cookie and __Secure prefix in production transport', () => {
    const { service, values } = setup();
    values.COOKIE_SECURE = true;
    const response = { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response;
    const expiresAt = new Date(Date.now() + 30_000);

    service.setPasswordResetCookie(response, resetToken, expiresAt);
    service.clearPasswordResetCookie(response);

    expect(service.passwordResetCookieName()).toBe('__Secure-financeiro-password-reset');
    expect(response.cookie).toHaveBeenCalledWith(
      '__Secure-financeiro-password-reset',
      resetToken,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/password-reset',
      }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      '__Secure-financeiro-password-reset',
      expect.objectContaining({ httpOnly: true, secure: true, path: '/auth/password-reset' }),
    );
  });
});
