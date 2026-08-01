import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmailOutboxStatus,
  IdentityProvider,
  Prisma,
  ProfileStatus,
  TelegramPendingStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { isPendingInviteEmail } from '../auth/auth-security.util';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from '../payments/subscription-access.projection';

const SERIALIZABLE_RETRIES = 3;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser) {
    const family = await this.assertOwnerAccess(this.prisma, user);
    const members = await this.prisma.user.findMany({
      where: { familyId: user.familyId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        platformRole: true,
        passwordHash: true,
        isActive: true,
        emailVerifiedAt: true,
        createdAt: true,
        profile: { select: { id: true, status: true } },
        approvalsReceived: {
          where: { familyId: user.familyId },
          orderBy: { createdAt: 'desc' },
          select: { requestedEmail: true },
          take: 1,
        },
        identities: {
          where: { provider: IdentityProvider.google },
          select: { id: true },
        },
      },
    });

    return members.map((member) => ({
      id: member.id,
      name: member.name,
      email: isPendingInviteEmail(member.email)
        ? (member.approvalsReceived[0]?.requestedEmail ?? null)
        : member.email,
      platformRole: member.platformRole,
      tenantRole: member.id === family.ownerUserId ? ('owner' as const) : ('member' as const),
      profileId: member.profile?.id ?? null,
      status: memberStatus(member),
      authMethods: {
        password: Boolean(member.passwordHash),
        google: member.identities.length > 0,
      },
      createdAt: member.createdAt,
    }));
  }

  async deactivate(user: AuthenticatedUser, memberId: string) {
    return this.withSerializableRetry(async (tx) => {
      await this.lockFamily(tx, user.familyId);
      const family = await this.assertOwnerAccess(tx, user);
      if (memberId === family.ownerUserId) {
        throw new BadRequestException('O owner não pode ser desativado.');
      }

      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User"
         WHERE "id" = ${memberId} AND "familyId" = ${user.familyId}
         FOR UPDATE
      `;
      const member = await tx.user.findFirst({
        where: { id: memberId, familyId: user.familyId },
        select: {
          id: true,
          isActive: true,
          updatedAt: true,
          profile: { select: { id: true, status: true } },
          approvalsReceived: {
            where: { familyId: user.familyId, status: 'pending' },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!member) throw new NotFoundException('Membro não encontrado.');
      if (!member.profile) {
        throw new BadRequestException('Membro sem perfil válido.');
      }
      if (
        member.profile.status === ProfileStatus.pending ||
        member.approvalsReceived.length > 0
      ) {
        throw new BadRequestException(
          'Solicitações pendentes devem ser tratadas na área de aprovações.',
        );
      }

      if (!member.isActive) {
        const cleanupAt = new Date();
        await tx.memberProfile.updateMany({
          where: { id: member.profile.id, userId: member.id, familyId: user.familyId },
          data: { status: ProfileStatus.inactive },
        });
        await this.revokePendingActionTokens(tx, member.id, cleanupAt);
        await this.revokeTelegramAccess(
          tx,
          member.id,
          member.profile.id,
          user.familyId,
          cleanupAt,
        );
        return {
          id: member.id,
          status: 'inactive' as const,
          deactivatedAt: member.updatedAt,
        };
      }

      const deactivatedAt = new Date();
      const deactivated = await tx.user.updateMany({
        where: { id: member.id, familyId: user.familyId, isActive: true },
        data: { isActive: false, authVersion: { increment: 1 } },
      });
      if (deactivated.count !== 1) {
        throw new BadRequestException('Membro não está ativo.');
      }

      await tx.memberProfile.updateMany({
        where: { id: member.profile.id, userId: member.id, familyId: user.familyId },
        data: { status: ProfileStatus.inactive },
      });
      await this.revokePendingActionTokens(tx, member.id, deactivatedAt);
      await this.revokeTelegramAccess(
        tx,
        member.id,
        member.profile.id,
        user.familyId,
        deactivatedAt,
      );

      return { id: member.id, status: 'inactive' as const, deactivatedAt };
    });
  }

  private async revokePendingActionTokens(
    tx: Prisma.TransactionClient,
    userId: string,
    revokedAt: Date,
  ): Promise<void> {
    const tokens = await tx.userActionToken.findMany({
      where: { userId, consumedAt: null, revokedAt: null },
      select: { id: true },
    });
    if (tokens.length === 0) return;
    const ids = tokens.map(({ id }) => id);
    await tx.userActionToken.updateMany({
      where: { id: { in: ids }, consumedAt: null, revokedAt: null },
      data: { revokedAt },
    });
    await tx.emailOutbox.updateMany({
      where: {
        userActionTokenId: { in: ids },
        status: { in: [EmailOutboxStatus.pending, EmailOutboxStatus.processing] },
      },
      data: {
        status: EmailOutboxStatus.discarded,
        payloadCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        discardedAt: revokedAt,
        lastErrorCode: 'MEMBER_DEACTIVATED',
      },
    });
  }

  private async revokeTelegramAccess(
    tx: Prisma.TransactionClient,
    userId: string,
    profileId: string,
    familyId: string,
    revokedAt: Date,
  ): Promise<void> {
    await Promise.all([
      tx.telegramUserLink.updateMany({
        where: { memberProfileId: profileId, revokedAt: null },
        data: { revokedAt },
      }),
      tx.telegramAuthCode.updateMany({
        where: {
          consumedAt: null,
          OR: [{ userId }, { memberProfileId: profileId }],
        },
        data: { consumedAt: revokedAt },
      }),
      tx.telegramPendingConfirmation.updateMany({
        where: {
          memberProfileId: profileId,
          status: TelegramPendingStatus.PENDING,
        },
        data: {
          status: TelegramPendingStatus.CANCELLED,
          resolvedAt: revokedAt,
        },
      }),
      tx.telegramAuthorizedGroup.updateMany({
        where: { familyId, authorizedByUserId: userId, revokedAt: null },
        data: { revokedAt },
      }),
    ]);
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
  ) {
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
      throw new ForbiddenException(
        'Somente o owner de um tenant ativo pode gerenciar membros.',
      );
    }
    return family;
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

function memberStatus(member: {
  isActive: boolean;
  emailVerifiedAt: Date | null;
  profile: { status: ProfileStatus } | null;
}) {
  if (member.profile?.status === ProfileStatus.pending) {
    return member.emailVerifiedAt ? ('pending_approval' as const) : ('pending_email' as const);
  }
  if (member.isActive && member.profile?.status === ProfileStatus.active) {
    return 'active' as const;
  }
  return 'inactive' as const;
}

function isSerializableConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  return error.code === 'P2010' && error.meta?.code === '40001';
}
