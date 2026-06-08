import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { RegisterWithInviteDto } from './dto/register-with-invite.dto';

@Injectable()
export class MemberInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateMemberInviteDto) {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + (dto.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);
    const invite = await this.prisma.memberInvite.create({
      data: {
        token,
        email: dto.email?.toLowerCase(),
        expiresAt,
        creatorUserId: user.id,
        familyId: user.familyId,
      },
    });

    return {
      id: invite.id,
      token: invite.token,
      email: invite.email,
      expiresAt: invite.expiresAt,
      status: invite.status,
      link: `${this.config.get<string>('WEB_ORIGIN') ?? 'http://127.0.0.1:8181'}/convite/${invite.token}`,
    };
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

  async register(dto: RegisterWithInviteDto) {
    const invite = await this.prisma.memberInvite.findUnique({
      where: { token: dto.token },
    });

    if (!invite || invite.status !== 'active' || invite.expiresAt < new Date()) {
      throw new BadRequestException('Convite inválido ou expirado');
    }

    if (invite.email && invite.email !== dto.email.toLowerCase()) {
      throw new BadRequestException('Convite emitido para outro email');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (existing) {
      throw new BadRequestException('Email já cadastrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const result = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          passwordHash,
          name: dto.name,
          role: UserRole.member,
          isActive: false,
          familyId: invite.familyId,
          profile: {
            create: {
              displayName: dto.name,
              status: 'pending',
              familyId: invite.familyId,
            },
          },
        },
        include: { profile: true },
      });

      const approval = await tx.memberApproval.create({
        data: {
          requestedEmail: createdUser.email,
          requestedName: createdUser.name,
          inviteId: invite.id,
          familyId: invite.familyId,
          userId: createdUser.id,
        },
      });

      await tx.memberInvite.update({
        where: { id: invite.id },
        data: { status: 'used' },
      });

      return { user: createdUser, approval };
    });

    return {
      status: 'pending',
      userId: result.user.id,
      approvalId: result.approval.id,
    };
  }
}

