import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import {
  MemberInviteOnboardingService,
  type RegisterLocalInviteInput,
} from '../auth/member-invite-onboarding.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from '../payments/subscription-access.projection';
import type { CreateMemberInviteDto } from './dto/create-member-invite.dto';

const SERIALIZABLE_RETRIES = 3;

@Injectable()
export class MemberInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly onboarding: MemberInviteOnboardingService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateMemberInviteDto) {
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      now.getTime() + (dto.expiresInDays ?? 7) * 24 * 60 * 60_000,
    );
    const email = dto.email?.trim().toLowerCase();

    const invite = await this.withSerializableRetry(async (tx) => {
      await this.lockFamily(tx, user.familyId);
      await this.assertOwnerAccess(tx, user);
      return tx.memberInvite.create({
        data: {
          token,
          email,
          expiresAt,
          creatorUserId: user.id,
          familyId: user.familyId,
        },
        select: {
          id: true,
          email: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    });

    return {
      ...invite,
      link: this.inviteLink(token),
    };
  }

  async list(user: AuthenticatedUser) {
    await this.assertOwnerAccess(this.prisma, user);
    const now = new Date();
    const invites = await this.prisma.memberInvite.findMany({
      where: { familyId: user.familyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return invites.map((invite) => ({
      ...invite,
      status:
        invite.status === 'active' && invite.expiresAt <= now
          ? ('expired' as const)
          : invite.status,
    }));
  }

  resolve(token: string) {
    return this.onboarding.resolve(token);
  }

  register(input: RegisterLocalInviteInput) {
    return this.onboarding.registerLocal(input);
  }

  confirmEmail(challengeId: string, code: string) {
    return this.onboarding.confirmLocalEmail(challengeId, code);
  }

  resendEmail(challengeId: string) {
    return this.onboarding.resendLocalEmail(challengeId);
  }

  emailVerificationStatus(challengeId: string) {
    return this.onboarding.statusLocalEmail(challengeId);
  }

  async revoke(user: AuthenticatedUser, id: string) {
    return this.withSerializableRetry(async (tx) => {
      await this.lockFamily(tx, user.familyId);
      await this.assertOwnerAccess(tx, user);
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "MemberInvite"
         WHERE "id" = ${id} AND "familyId" = ${user.familyId}
         FOR UPDATE
      `;
      const invite = await tx.memberInvite.findFirst({
        where: { id, familyId: user.familyId },
        select: {
          id: true,
          email: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      if (!invite) throw new NotFoundException('Convite não encontrado.');
      if (invite.status === 'revoked' || invite.status === 'expired') return invite;
      if (invite.status === 'used') {
        throw new BadRequestException('Convite já utilizado.');
      }

      const now = new Date();
      const nextStatus = invite.expiresAt <= now ? 'expired' : 'revoked';
      const updated = await tx.memberInvite.updateMany({
        where: {
          id,
          familyId: user.familyId,
          status: 'active',
        },
        data: { status: nextStatus },
      });
      if (updated.count !== 1) {
        throw new BadRequestException('Convite não pode mais ser revogado.');
      }
      await tx.oAuthAttempt.updateMany({
        where: { memberInviteId: id, consumedAt: null },
        data: { consumedAt: now },
      });
      return { ...invite, status: nextStatus };
    });
  }

  private async lockFamily(tx: Prisma.TransactionClient, familyId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Family" WHERE "id" = ${familyId} FOR UPDATE
    `;
    if (locked.length !== 1) throw new ForbiddenException('Operação não permitida.');
  }

  private async assertOwnerAccess(
    client: Prisma.TransactionClient | PrismaService,
    user: AuthenticatedUser,
  ): Promise<void> {
    const family = await client.family.findUnique({
      where: { id: user.familyId },
      select: {
        ownerUserId: true,
        currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
      },
    });
    if (
      !family ||
      family.ownerUserId !== user.id ||
      !evaluateSubscriptionProjection(family.currentSubscription).accessAllowed
    ) {
      throw new ForbiddenException('Somente o owner de um tenant ativo pode gerenciar convites.');
    }
  }

  private inviteLink(token: string): string {
    const configuredOrigin = this.config.getOrThrow<string>('WEB_ORIGIN').split(',')[0]?.trim();
    if (!configuredOrigin) throw new Error('WEB_ORIGIN ausente');
    const url = new URL(configuredOrigin);
    url.pathname = `/convite/${token}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (isSerializableConflict(error) && attempt < SERIALIZABLE_RETRIES) continue;
        throw error;
      }
    }
    throw new Error('Serializable retry budget exhausted.');
  }
}

function isSerializableConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  return error.code === 'P2010' && error.meta?.code === '40001';
}
