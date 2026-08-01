import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailOutboxStatus, ProfileStatus, TelegramPendingStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MembersService } from './members.service';

const owner = {
  id: 'owner-1',
  familyId: 'family-1',
  tenantRole: 'owner',
} as AuthenticatedUser;

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

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
    family: {
      findUnique: vi.fn().mockResolvedValue({
        ownerUserId: owner.id,
        currentSubscription: activeSubscription,
      }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'member-1',
        isActive: true,
        updatedAt: new Date(),
        profile: { id: 'profile-1', status: ProfileStatus.active },
        approvalsReceived: [],
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    memberProfile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userActionToken: {
      findMany: vi.fn().mockResolvedValue([{ id: 'token-1' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    telegramUserLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    telegramAuthCode: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    telegramPendingConfirmation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    telegramAuthorizedGroup: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    family: tx.family,
    user: { ...tx.user, findMany: vi.fn() },
    $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaService;
  return { service: new MembersService(prisma), prisma, tx };
}

describe('MembersService', () => {
  it('desativa e revoga sessão, tokens de ação, outbox e Telegram atomicamente', async () => {
    const { service, tx } = setup();

    await expect(service.deactivate(owner, 'member-1')).resolves.toMatchObject({
      id: 'member-1',
      status: 'inactive',
      deactivatedAt: expect.any(Date),
    });

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'member-1', familyId: owner.familyId, isActive: true },
      data: { isActive: false, authVersion: { increment: 1 } },
    });
    expect(tx.userActionToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EmailOutboxStatus.discarded,
          payloadCiphertext: null,
          lastErrorCode: 'MEMBER_DEACTIVATED',
        }),
      }),
    );
    expect(tx.telegramUserLink.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
    expect(tx.telegramAuthCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
    );
    expect(tx.telegramPendingConfirmation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TelegramPendingStatus.CANCELLED }),
      }),
    );
  });

  it('recusa desativar o owner', async () => {
    const { service, tx } = setup();

    await expect(service.deactivate(owner, owner.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.user.findFirst).not.toHaveBeenCalled();
  });

  it('não revela membro de outro tenant', async () => {
    const { service, tx } = setup();
    tx.user.findFirst.mockResolvedValue(null);

    await expect(service.deactivate(owner, 'foreign-member')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('distingue e-mail pendente, aprovação pendente e métodos de autenticação', async () => {
    const { service, prisma } = setup();
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      {
        id: 'member-1',
        name: 'Membro local',
        email: 'pending-member-1@invite.invalid',
        platformRole: 'user',
        passwordHash: 'hash',
        isActive: false,
        emailVerifiedAt: null,
        createdAt: new Date(),
        profile: { id: 'profile-1', status: ProfileStatus.pending },
        approvalsReceived: [{ requestedEmail: 'member@example.com' }],
        identities: [],
      },
      {
        id: 'member-2',
        name: 'Membro Google',
        email: 'google@example.com',
        platformRole: 'user',
        passwordHash: null,
        isActive: false,
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        profile: { id: 'profile-2', status: ProfileStatus.pending },
        approvalsReceived: [{ requestedEmail: 'google@example.com' }],
        identities: [{ id: 'identity-1' }],
      },
      {
        id: 'member-3',
        name: 'Membro rejeitado',
        email: 'pending-member-3@invite.invalid',
        platformRole: 'user',
        passwordHash: 'hash',
        isActive: false,
        emailVerifiedAt: null,
        createdAt: new Date(),
        profile: { id: 'profile-3', status: ProfileStatus.inactive },
        approvalsReceived: [{ requestedEmail: 'rejected@example.com' }],
        identities: [],
      },
    ] as never);

    await expect(service.list(owner)).resolves.toEqual([
      expect.objectContaining({
        id: 'member-1',
        email: 'member@example.com',
        status: 'pending_email',
        authMethods: { password: true, google: false },
      }),
      expect.objectContaining({
        id: 'member-2',
        email: 'google@example.com',
        status: 'pending_approval',
        authMethods: { password: false, google: true },
      }),
      expect.objectContaining({
        id: 'member-3',
        email: 'rejected@example.com',
        status: 'inactive',
      }),
    ]);
  });
});
