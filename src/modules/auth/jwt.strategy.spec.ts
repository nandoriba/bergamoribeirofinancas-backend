import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from './auth.types';
import { JwtStrategy } from './jwt.strategy';

function setup() {
  const prisma = {
    user: { findUnique: vi.fn() },
  } as unknown as PrismaService;
  const config = {
    getOrThrow: vi.fn().mockReturnValue('a-secure-test-secret-with-32-chars'),
  } as unknown as ConfigService;

  return { prisma, strategy: new JwtStrategy(config, prisma) };
}

describe('JwtStrategy', () => {
  const forgedPayload: JwtPayload = {
    sub: 'member-user',
    email: 'forged@example.com',
    platformRole: PlatformRole.admin,
    tenantRole: 'owner',
    familyId: 'foreign-family',
    profileId: 'foreign-profile',
  };

  it('ignores authorization claims and rebuilds the context from the database', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      isActive: true,
      familyId: 'real-family',
      profile: { id: 'real-profile', status: 'active' },
      family: { ownerUserId: 'another-user' },
    } as never);

    await expect(strategy.validate(forgedPayload)).resolves.toEqual({
      id: 'member-user',
      email: 'member@example.com',
      platformRole: PlatformRole.user,
      tenantRole: 'member',
      familyId: 'real-family',
      profileId: 'real-profile',
    });
  });

  it('rejects inactive database users even when the token says owner', async () => {
    const { prisma, strategy } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'member-user',
      isActive: false,
      profile: { id: 'real-profile', status: 'active' },
      family: { ownerUserId: 'member-user' },
    } as never);

    await expect(strategy.validate(forgedPayload)).rejects.toEqual(new UnauthorizedException('Sessão inválida'));
  });
});
