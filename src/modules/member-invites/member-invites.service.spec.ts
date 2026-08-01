import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { MemberInviteOnboardingService } from '../auth/member-invite-onboarding.service';
import { MemberInvitesService } from './member-invites.service';

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
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-1' }]),
    family: {
      findUnique: vi.fn().mockResolvedValue({
        ownerUserId: owner.id,
        currentSubscription: activeSubscription,
      }),
    },
    memberInvite: {
      create: vi.fn().mockResolvedValue({
        id: 'invite-1',
        email: null,
        status: 'active',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      }),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    oAuthAttempt: { updateMany: vi.fn() },
  };
  const prisma = {
    ...tx,
    memberInvite: { ...tx.memberInvite, findMany: vi.fn() },
    $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaService;
  const config = {
    getOrThrow: vi.fn().mockReturnValue('https://financas.example'),
  } as unknown as ConfigService;
  const onboarding = {} as MemberInviteOnboardingService;
  return { service: new MemberInvitesService(prisma, config, onboarding), prisma, tx };
}

describe('MemberInvitesService', () => {
  it('devolve o link somente na criação e nunca o token cru', async () => {
    const { service } = setup();

    const result = await service.create(owner, { expiresInDays: 7 });

    expect(result.link).toMatch(/^https:\/\/financas\.example\/convite\/[A-Za-z0-9_-]{43}$/);
    expect(result).not.toHaveProperty('token');
  });

  it('não seleciona nem expõe token/link na listagem', async () => {
    const { service, prisma } = setup();
    vi.mocked(prisma.memberInvite.findMany).mockResolvedValue([]);

    const result = await service.list(owner);

    expect(result).toEqual([]);
    expect(prisma.memberInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ token: expect.anything() }),
      }),
    );
  });

  it('trata convite expirado como terminal ao revogar', async () => {
    const { service, tx } = setup();
    tx.memberInvite.findFirst.mockResolvedValue({
      id: 'invite-1',
      email: null,
      status: 'expired',
      expiresAt: new Date(Date.now() - 1),
      createdAt: new Date(),
    });

    await expect(service.revoke(owner, 'invite-1')).resolves.toMatchObject({
      id: 'invite-1',
      status: 'expired',
    });
    expect(tx.memberInvite.updateMany).not.toHaveBeenCalled();
  });
});
