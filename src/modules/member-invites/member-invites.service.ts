import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { RegisterWithInviteDto } from './dto/register-with-invite.dto';

@Injectable()
export class MemberInvitesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(_user: AuthenticatedUser, _dto: CreateMemberInviteDto): Promise<never> {
    return this.inviteOnboardingUnavailable();
  }

  async list(user: AuthenticatedUser) {
    return this.prisma.memberInvite.findMany({
      where: { familyId: user.familyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        token: true,
        email: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async getPublic(token: string) {
    const invite = await this.prisma.memberInvite.findUnique({
      where: { token },
      include: { family: true },
    });

    if (!invite || invite.status !== 'active' || invite.expiresAt < new Date()) {
      throw new NotFoundException('Convite inválido ou expirado');
    }

    return {
      token: invite.token,
      familyName: invite.family.name,
      email: invite.email,
      expiresAt: invite.expiresAt,
    };
  }

  async register(_dto: RegisterWithInviteDto): Promise<never> {
    return this.inviteOnboardingUnavailable();
  }

  private inviteOnboardingUnavailable(): never {
    throw new ServiceUnavailableException(
      'Novos convites estão temporariamente indisponíveis enquanto a verificação de email é atualizada.',
    );
  }
}
