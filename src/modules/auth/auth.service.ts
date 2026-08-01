import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';

const DUMMY_PASSWORD_HASH = '$2a$12$if2i1aU0zMN0sCeQf1OH2uyr2PwSJfsiaiVxNoRMV.v8KuvXLmjbC';
const SESSION_USER_INCLUDE = {
  profile: true,
  family: { select: { name: true, ownerUserId: true } },
} as const;

type SessionUserRecord = Prisma.UserGetPayload<{ include: typeof SESSION_USER_INCLUDE }>;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: SESSION_USER_INCLUDE,
    });

    const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.profile || !user.passwordHash || !passwordMatches) {
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    if (!user.isActive || user.profile.status !== 'active') {
      throw new UnauthorizedException('Usuário pendente ou inativo');
    }

    return this.createSession(user);
  }

  async confirmCurrentPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        isActive: true,
        profile: { select: { status: true } },
      },
    });
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

    if (!user || !user.profile || !user.passwordHash || !passwordMatches || !user.isActive || user.profile.status !== 'active') {
      throw new UnauthorizedException('Senha atual inválida');
    }
  }

  async createSessionForUserId(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: SESSION_USER_INCLUDE,
    });

    if (!user || !user.profile || !user.isActive || user.profile.status !== 'active') {
      throw new UnauthorizedException('Usuário pendente ou inativo');
    }

    return this.createSession(user);
  }

  setSessionCookie(response: Response, token: string) {
    response.cookie('financeiro_session', token, {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  clearSessionCookie(response: Response) {
    response.clearCookie('financeiro_session', {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      sameSite: 'lax',
      path: '/',
    });
  }

  async me(user: AuthenticatedUser) {
    const dbUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: SESSION_USER_INCLUDE,
    });

    return this.serializeUser(user, dbUser.name, dbUser.themePreference, dbUser.family.name);
  }

  private async createSession(user: SessionUserRecord) {
    if (!user.profile) throw new UnauthorizedException('Usuário pendente ou inativo');

    const authUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      platformRole: user.platformRole,
      tenantRole: user.family.ownerUserId === user.id ? 'owner' : 'member',
      familyId: user.familyId,
      profileId: user.profile.id,
    };

    return {
      user: this.serializeUser(authUser, user.name, user.themePreference, user.family.name),
      token: await this.sign(authUser),
    };
  }

  private async sign(user: AuthenticatedUser) {
    const payload: JwtPayload = {
      jti: randomUUID(),
      sub: user.id,
      email: user.email,
      platformRole: user.platformRole,
      tenantRole: user.tenantRole,
      familyId: user.familyId,
      profileId: user.profileId,
    };

    return this.jwtService.signAsync(payload);
  }

  private serializeUser(
    user: AuthenticatedUser,
    name: string,
    themePreference: string,
    familyName?: string,
  ) {
    return {
      id: user.id,
      email: user.email,
      name,
      platformRole: user.platformRole,
      tenantRole: user.tenantRole,
      familyId: user.familyId,
      familyName,
      profileId: user.profileId,
      themePreference,
    };
  }
}
