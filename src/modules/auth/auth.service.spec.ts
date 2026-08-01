import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { PlatformRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

function setup() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  } as unknown as PrismaService;
  const jwtService = {
    signAsync: vi.fn().mockResolvedValue('signed-token'),
  } as unknown as JwtService;
  const config = {
    get: vi.fn().mockReturnValue(false),
  } as unknown as ConfigService;

  return { prisma, jwtService, service: new AuthService(prisma, jwtService, config) };
}

describe('AuthService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a Google-only account with the generic error and a timing-safe dummy comparison', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'google-user',
      email: 'google@example.com',
      passwordHash: null,
      name: 'Google User',
      platformRole: PlatformRole.user,
      themePreference: 'dark',
      isActive: true,
      familyId: 'family-1',
      profile: { id: 'profile-1', status: 'active' },
      family: { ownerUserId: 'google-user' },
    } as never);

    await expect(service.login('google@example.com', 'irrelevant')).rejects.toEqual(
      new UnauthorizedException('Email ou senha inválidos'),
    );
    expect(bcrypt.compare).toHaveBeenCalledOnce();
    expect(bcrypt.compare).toHaveBeenCalledWith('irrelevant', expect.any(String));
  });

  it('serializes and signs the tenant role derived from Family.ownerUserId', async () => {
    const { prisma, jwtService, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'owner-user',
      email: 'owner@example.com',
      passwordHash: 'password-hash',
      name: 'Owner User',
      platformRole: PlatformRole.user,
      themePreference: 'dark',
      isActive: true,
      familyId: 'family-1',
      profile: { id: 'profile-1', status: 'active' },
      family: { ownerUserId: 'owner-user' },
    } as never);
    (bcrypt.compare as unknown as { mockResolvedValue(value: boolean): void }).mockResolvedValue(true);

    const result = await service.login('OWNER@example.com', 'correct-password');

    expect(result.user).toMatchObject({
      id: 'owner-user',
      platformRole: PlatformRole.user,
      tenantRole: 'owner',
      familyId: 'family-1',
      profileId: 'profile-1',
    });
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: 'owner-user',
      email: 'owner@example.com',
      platformRole: PlatformRole.user,
      tenantRole: 'owner',
      familyId: 'family-1',
      profileId: 'profile-1',
    });
  });
});
