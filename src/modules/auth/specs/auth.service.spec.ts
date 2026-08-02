import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { PlatformRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AuthService } from '../auth.service';

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
    get: vi.fn((key: string) => key === 'SUPPORT_EMAIL' ? 'support@example.com' : false),
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
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 0,
      familyId: 'family-1',
      profile: { id: 'profile-1', status: 'active' },
      family: { ownerUserId: 'google-user', pendingPaymentExpiresAt: null },
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
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 3,
      familyId: 'family-1',
      profile: { id: 'profile-1', status: 'active' },
      family: {
        ownerUserId: 'owner-user',
        pendingPaymentExpiresAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    } as never);
    (bcrypt.compare as unknown as { mockResolvedValue(value: boolean): void }).mockResolvedValue(true);

    const result = await service.login('OWNER@example.com', 'correct-password');

    expect(result.user).toMatchObject({
      id: 'owner-user',
      platformRole: PlatformRole.user,
      tenantRole: 'owner',
      familyId: 'family-1',
      profileId: 'profile-1',
      requiredAction: 'payment',
      supportEmail: 'support@example.com',
    });
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      jti: expect.any(String),
      sub: 'owner-user',
      email: 'owner@example.com',
      platformRole: PlatformRole.user,
      tenantRole: 'owner',
      familyId: 'family-1',
      profileId: 'profile-1',
      authVersion: 3,
    });
  });

  it('rejects an unverified password account with the same generic login error', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'unverified-user',
      email: 'unverified@example.com',
      passwordHash: 'password-hash',
      name: 'Unverified User',
      platformRole: PlatformRole.user,
      themePreference: 'dark',
      isActive: true,
      emailVerifiedAt: null,
      authVersion: 0,
      familyId: 'family-1',
      profile: { id: 'profile-1', status: 'active' },
      family: { ownerUserId: 'unverified-user', pendingPaymentExpiresAt: null },
    } as never);
    (bcrypt.compare as unknown as { mockResolvedValue(value: boolean): void }).mockResolvedValue(true);

    await expect(service.login(' unverified@example.com ', 'correct-password')).rejects.toEqual(
      new UnauthorizedException('Email ou senha inválidos'),
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'unverified@example.com' } }),
    );
  });

  it('falha fechado para família legada sem assinatura autoritativa', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'legacy-user',
      email: 'legacy@example.com',
      passwordHash: 'password-hash',
      name: 'Legacy User',
      platformRole: PlatformRole.user,
      themePreference: 'dark',
      isActive: true,
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      authVersion: 0,
      familyId: 'legacy-family',
      profile: { id: 'legacy-profile', status: 'active' },
      family: { ownerUserId: 'legacy-user', pendingPaymentExpiresAt: null },
    } as never);
    (bcrypt.compare as unknown as { mockResolvedValue(value: boolean): void }).mockResolvedValue(true);

    await expect(service.login('legacy@example.com', 'correct-password')).resolves.toMatchObject({
      user: {
        requiredAction: 'payment',
        effectiveStatus: 'pending_payment',
        accessAllowed: false,
      },
    });
  });

  it('rejects current-password confirmation for a Google-only account without skipping bcrypt work', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      passwordHash: null,
      isActive: true,
      profile: { status: 'active' },
    } as never);

    await expect(service.confirmCurrentPassword('google-user', 'attempt')).rejects.toEqual(
      new UnauthorizedException('Senha atual inválida'),
    );
    expect(bcrypt.compare).toHaveBeenCalledWith('attempt', expect.any(String));
  });
});
