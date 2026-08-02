import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SubscriptionAccessPolicy } from '../../payments/subscription-access.policy';
import type { JwtPayload } from '../auth.types';
import { JwtStrategy } from '../jwt.strategy';

function setup() {
  const prisma = {
    user: { findUnique: vi.fn() },
  } as unknown as PrismaService;
  const config = {
    getOrThrow: vi.fn().mockReturnValue('a-secure-test-secret-with-32-chars'),
  } as unknown as ConfigService;

  return { prisma, strategy: new JwtStrategy(config, prisma, new SubscriptionAccessPolicy()) };
}

describe('JwtStrategy', () => {
  const forgedPayload: JwtPayload = {
    jti: 'forged-token-id',
    sub: 'member-user',
    email: 'forged@example.com',
    platformRole: PlatformRole.admin,
    tenantRole: 'owner',
    familyId: 'foreign-family',
    profileId: 'foreign-profile',
    authVersion: 7,
  };

  it('ignores authorization claims and rebuilds the context from the database', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      isActive: true,
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 7,
      familyId: 'real-family',
      profile: { id: 'real-profile', status: 'active' },
      family: {
        ownerUserId: 'another-user',
        pendingPaymentExpiresAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    } as never);

    await expect(strategy.validate(forgedPayload)).resolves.toEqual({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      tenantRole: 'member',
      familyId: 'real-family',
      profileId: 'real-profile',
      requiredAction: 'payment',
      subscriptionAccess: {
        effectiveStatus: 'pending_payment',
        accessAllowed: false,
        reason: 'SUBSCRIPTION_ABSENT',
      },
    });
  });

  it('rejects inactive database users even when the token says owner', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      isActive: false,
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 7,
      profile: { id: 'real-profile', status: 'active' },
      family: { ownerUserId: 'member-user', pendingPaymentExpiresAt: null },
    } as never);

    await expect(strategy.validate(forgedPayload)).rejects.toEqual(new UnauthorizedException('Sessão inválida'));
  });

  it('rejects a token issued before the current credential version', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      isActive: true,
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 8,
      familyId: 'real-family',
      profile: { id: 'real-profile', status: 'active' },
      family: { ownerUserId: 'another-user', pendingPaymentExpiresAt: null },
    } as never);

    await expect(strategy.validate(forgedPayload)).rejects.toEqual(
      new UnauthorizedException('Sessão inválida'),
    );
  });

  it('rejects an unverified account even if every signed claim is current', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      isActive: true,
      emailVerifiedAt: null,
      authVersion: 7,
      familyId: 'real-family',
      profile: { id: 'real-profile', status: 'active' },
      family: { ownerUserId: 'another-user', pendingPaymentExpiresAt: null },
    } as never);

    await expect(strategy.validate(forgedPayload)).rejects.toEqual(
      new UnauthorizedException('Sessão inválida'),
    );
  });
});
