import { BadRequestException } from '@nestjs/common';
import { EmailOutboxStatus, ProfileStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { pendingInviteEmail } from '../auth/auth-security.util';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MemberApprovalsService } from './member-approvals.service';

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

function approval(status: 'pending' | 'approved' | 'rejected' = 'pending', verified = true) {
  const profileStatus: ProfileStatus =
    status === 'pending'
      ? ProfileStatus.pending
      : status === 'approved'
        ? ProfileStatus.active
        : ProfileStatus.inactive;
  return {
    id: 'approval-1',
    requestedName: 'Membro',
    requestedEmail: 'member@example.com',
    status,
    reviewedAt: status === 'pending' ? null : new Date(),
    createdAt: new Date(),
    userId: 'member-1',
    approvedUser: {
      isActive: status === 'approved',
      emailVerifiedAt: verified ? new Date() : null,
      profile: {
        id: 'profile-1',
        status: profileStatus,
      },
    },
  };
}

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
    family: {
      findUnique: vi.fn().mockResolvedValue({
        ownerUserId: owner.id,
        currentSubscription: activeSubscription,
      }),
    },
    memberApproval: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    memberProfile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userActionToken: {
      findMany: vi.fn().mockResolvedValue([{ id: 'token-1' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    family: tx.family,
    memberApproval: tx.memberApproval,
    $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaService;
  return { service: new MemberApprovalsService(prisma), prisma, tx };
}

describe('MemberApprovalsService', () => {
  it('aprova somente após e-mail verificado e ativa usuário/perfil por CAS', async () => {
    const { service, tx } = setup();
    tx.memberApproval.findFirst
      .mockResolvedValueOnce(approval('pending', true))
      .mockResolvedValueOnce(approval('approved', true));

    await expect(service.approve(owner, 'approval-1')).resolves.toMatchObject({
      id: 'approval-1',
      status: 'approved',
      emailVerified: true,
      readyForApproval: false,
    });
    expect(tx.memberApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'pending' }) }),
    );
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: false, emailVerifiedAt: { not: null } }),
        data: { isActive: true },
      }),
    );
    expect(tx.memberProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: ProfileStatus.active } }),
    );
  });

  it('bloqueia aprovação antes da confirmação de e-mail', async () => {
    const { service, tx } = setup();
    tx.memberApproval.findFirst.mockResolvedValue(approval('pending', false));

    await expect(service.approve(owner, 'approval-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.memberApproval.updateMany).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('é idempotente para a mesma decisão terminal', async () => {
    const { service, tx } = setup();
    tx.memberApproval.findFirst.mockResolvedValue(approval('approved', true));

    await expect(service.approve(owner, 'approval-1')).resolves.toMatchObject({
      status: 'approved',
    });
    expect(tx.memberApproval.updateMany).not.toHaveBeenCalled();
  });

  it('rejeita por CAS e revoga tokens/outbox do candidato', async () => {
    const { service, tx } = setup();
    const rejected = approval('rejected', true);
    rejected.approvedUser.isActive = false;
    tx.memberApproval.findFirst
      .mockResolvedValueOnce(approval('pending', true))
      .mockResolvedValueOnce(rejected);

    await expect(service.reject(owner, 'approval-1')).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: pendingInviteEmail('member-1'),
          emailVerifiedAt: null,
          isActive: false,
          authVersion: { increment: 1 },
        },
      }),
    );
    expect(tx.userActionToken.updateMany).toHaveBeenCalled();
    expect(tx.userIdentity.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'member-1' },
    });
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EmailOutboxStatus.discarded,
          lastErrorCode: 'MEMBER_REJECTED',
        }),
      }),
    );
  });
});
