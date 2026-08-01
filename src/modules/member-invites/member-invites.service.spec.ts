import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MemberInvitesService } from './member-invites.service';

describe('MemberInvitesService verification rollout gate', () => {
  it('does not create an unusable invite before verified invite onboarding exists', async () => {
    const memberInvite = { create: vi.fn(), findUnique: vi.fn() };
    const prisma = { memberInvite } as unknown as PrismaService;
    const service = new MemberInvitesService(prisma);
    const owner = {
      id: 'owner-1',
      familyId: 'family-1',
      tenantRole: 'owner',
    } as AuthenticatedUser;

    await expect(service.create(owner, { expiresInDays: 7 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(memberInvite.create).not.toHaveBeenCalled();
    expect(memberInvite.findUnique).not.toHaveBeenCalled();
  });

  it('rejects registration before token lookup or database writes', async () => {
    const memberInvite = { create: vi.fn(), findUnique: vi.fn() };
    const prisma = { memberInvite, $transaction: vi.fn() } as unknown as PrismaService;
    const service = new MemberInvitesService(prisma);

    await expect(
      service.register({
        token: 'opaque-invite',
        name: 'Convidada',
        email: 'member@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(memberInvite.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
