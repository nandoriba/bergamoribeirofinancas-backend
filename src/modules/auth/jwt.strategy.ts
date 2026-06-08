import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';

function extractJwtFromCookie(request: Request): string | null {
  return request.cookies?.financeiro_session ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractJwtFromCookie, ExtractJwt.fromAuthHeaderAsBearerToken()]),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { profile: true },
    });

    if (!user?.isActive || !user.profile || user.profile.status !== 'active') {
      throw new UnauthorizedException('Sessão inválida');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      familyId: user.familyId,
      profileId: user.profile.id,
    };
  }
}

