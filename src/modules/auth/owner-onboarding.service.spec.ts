import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LegalAcceptanceSource, PlatformRole, Prisma, ProfileStatus, UserActionTokenPurpose } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthService } from './auth.service';
import { OwnerOnboardingService } from './owner-onboarding.service';
import type { PreparedActionToken, UserActionTokenService } from './user-action-token.service';

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('bcrypt-hash') },
}));

const now = new Date('2026-08-01T12:00:00.000Z');
const prepared: PreparedActionToken = {
  token: {
    id: 'token-1',
    purpose: UserActionTokenPurpose.email_verification,
    secretHash: 'hmac-hash',
    deliveryEmail: 'owner@example.com',
    userId: 'user-1',
    expiresAt: new Date('2026-08-01T12:15:00.000Z'),
    createdAt: now,
  },
  outbox: {
    id: 'outbox-1',
    payloadCiphertext: 'encrypted',
    payloadKeyVersion: 'v1',
    nextAttemptAt: now,
  },
};

function setup(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const values: Record<string, unknown> = {
    OWNER_SIGNUP_ENABLED: true,
    EMAIL_PROVIDER: 'resend',
    LEGAL_BUNDLE_VERSION: '2026-08-01',
    PENDING_PAYMENT_TTL_DAYS: 7,
    GOOGLE_OAUTH_ENABLED: true,
    SUPPORT_EMAIL: 'support@example.com',
    ...overrides,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const tx = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async () => events.push('user')),
    },
    family: {
      create: vi.fn(async () => events.push('family')),
      update: vi.fn(async () => events.push('owner')),
    },
    memberProfile: { create: vi.fn(async () => events.push('profile')) },
    legalAcceptance: { create: vi.fn(async () => events.push('legal')) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      const result = await callback(tx);
      events.push('commit');
      return result;
    }),
  } as unknown as PrismaService;
  const actionTokens = {
    prepareEmailVerification: vi.fn((_userId: string, email: string, issuedAt: Date) => ({
      ...prepared,
      token: { ...prepared.token, deliveryEmail: email, createdAt: issuedAt },
    })),
    createPrepared: vi.fn(async () => events.push('token-outbox')),
    dispatchPrepared: vi.fn(() => events.push('dispatch')),
    verificationMetadata: vi.fn().mockReturnValue({
      challengeId: 'token-1',
      destinationMasked: 'ow***@e***.com',
      resendAvailableAt: new Date('2026-08-01T12:01:00.000Z'),
      expiresAt: prepared.token.expiresAt,
    }),
    confirmEmailVerification: vi.fn(),
  } as unknown as UserActionTokenService;
  const authService = { createSessionForUserId: vi.fn() } as unknown as AuthService;
  const service = new OwnerOnboardingService(prisma, config, actionTokens, authService);

  return { actionTokens, events, prisma, service, tx };
}

const dto = {
  ownerName: 'Fernanda Ribeiro',
  familyName: 'Família Ribeiro',
  email: ' OWNER@Example.COM ',
  password: 'correct horse battery staple',
  legalAcceptanceVersion: '2026-08-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(now);
});

describe('OwnerOnboardingService', () => {
  it('fails closed before hashing or writing when public signup is disabled', async () => {
    const { actionTokens, prisma, service } = setup({ OWNER_SIGNUP_ENABLED: false });

    await expect(service.registerLocalOwner(dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(actionTokens.prepareEmailVerification).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires Resend and the exact current legal bundle version', async () => {
    const disabledEmail = setup({ EMAIL_PROVIDER: 'disabled' });
    await expect(disabledEmail.service.registerLocalOwner(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const staleLegal = setup();
    await expect(
      staleLegal.service.registerLocalOwner({ ...dto, legalAcceptanceVersion: 'old' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(staleLegal.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects passwords that fit the DTO character limit but exceed bcrypt 72-byte input', async () => {
    const { prisma, service } = setup();

    await expect(
      service.registerLocalOwner({ ...dto, password: 'á'.repeat(40) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomically creates family, owner, active profile, legal acceptance and token/outbox', async () => {
    const { actionTokens, events, service, tx } = setup();

    const result = await service.registerLocalOwner(dto);

    expect(bcrypt.hash).toHaveBeenCalledWith(dto.password, 12);
    expect(actionTokens.prepareEmailVerification).toHaveBeenCalledWith(
      expect.any(String),
      'owner@example.com',
      expect.any(Date),
    );
    expect(tx.family.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        name: dto.familyName,
        pendingPaymentExpiresAt: new Date('2026-08-08T12:00:00.000Z'),
      },
    });
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        email: 'owner@example.com',
        passwordHash: 'bcrypt-hash',
        name: dto.ownerName,
        platformRole: PlatformRole.user,
        isActive: true,
        emailVerifiedAt: null,
        familyId: expect.any(String),
      }),
    });
    expect(tx.memberProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: dto.ownerName,
        status: ProfileStatus.active,
        userId: expect.any(String),
        familyId: expect.any(String),
      }),
    });
    expect(tx.legalAcceptance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bundleVersion: '2026-08-01',
        source: LegalAcceptanceSource.local,
        acceptedAt: now,
      }),
    });
    expect(actionTokens.createPrepared).toHaveBeenCalledOnce();
    expect(tx.family.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: { ownerUserId: expect.any(String) },
    });
    expect(events.at(-2)).toBe('commit');
    expect(events.at(-1)).toBe('dispatch');
    expect(result.challengeId).toBe('token-1');
  });

  it('never dispatches an email before a failed transaction commits', async () => {
    const { actionTokens, prisma, service } = setup();
    vi.mocked(prisma.$transaction).mockRejectedValue({ code: 'P2002' });

    await expect(service.registerLocalOwner(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(actionTokens.dispatchPrepared).not.toHaveBeenCalled();
  });

  it('retries serialization conflicts but dispatches exactly once after commit', async () => {
    const { actionTokens, prisma, service, tx } = setup();
    vi.mocked(prisma.$transaction)
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback) => callback(tx as never));

    await service.registerLocalOwner(dto);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(actionTokens.dispatchPrepared).toHaveBeenCalledOnce();
  });

  it('publishes only safe capability, legal and support configuration', () => {
    const { service } = setup();

    expect(service.publicConfig()).toEqual({
      ownerSignupEnabled: true,
      googleEnabled: true,
      legal: { version: '2026-08-01', termsPath: '/termos', privacyPath: '/privacidade' },
      supportEmail: 'support@example.com',
    });
  });
});
