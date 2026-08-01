import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailOutboxStatus, Prisma, ProfileStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { pendingInviteEmail } from '../auth/auth-security.util';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from '../payments/subscription-access.projection';

const SERIALIZABLE_RETRIES = 3;
const APPROVAL_SELECT = Prisma.validator<Prisma.MemberApprovalSelect>()({
  id: true,
  requestedName: true,
  requestedEmail: true,
  status: true,
  reviewedAt: true,
  createdAt: true,
  userId: true,
  approvedUser: {
    select: {
      isActive: true,
      emailVerifiedAt: true,
      profile: { select: { id: true, status: true } },
    },
  },
});

type ApprovalProjection = Prisma.MemberApprovalGetPayload<{
  select: typeof APPROVAL_SELECT;
}>;

@Injectable()
export class MemberApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser) {
    await this.assertOwnerAccess(this.prisma, user);
    const approvals = await this.prisma.memberApproval.findMany({
      where: { familyId: user.familyId },
      orderBy: { createdAt: 'desc' },
      select: APPROVAL_SELECT,
    });
    return approvals.map((approval) => this.toResponse(approval));
  }

  approve(user: AuthenticatedUser, id: string) {
    return this.review(user, id, 'approved');
  }

  reject(user: AuthenticatedUser, id: string) {
    return this.review(user, id, 'rejected');
  }

  private async review(
    user: AuthenticatedUser,
    id: string,
    decision: 'approved' | 'rejected',
  ) {
    return this.withSerializableRetry(async (tx) => {
      await this.lockFamily(tx, user.familyId);
      await this.assertOwnerAccess(tx, user);
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "MemberApproval"
         WHERE "id" = ${id} AND "familyId" = ${user.familyId}
         FOR UPDATE
      `;

      const approval = await tx.memberApproval.findFirst({
        where: { id, familyId: user.familyId },
        select: APPROVAL_SELECT,
      });
      if (!approval) throw new NotFoundException('Solicitação não encontrada.');

      if (approval.status === decision) return this.toResponse(approval);
      if (approval.status !== 'pending') {
        throw new BadRequestException('Solicitação já foi revisada.');
      }
      if (!approval.userId || !approval.approvedUser?.profile) {
        throw new BadRequestException('Solicitação sem membro pendente válido.');
      }

      if (decision === 'approved') {
        if (!approval.approvedUser.emailVerifiedAt) {
          throw new BadRequestException('O membro ainda não verificou o e-mail.');
        }
        if (
          approval.approvedUser.isActive ||
          approval.approvedUser.profile.status !== ProfileStatus.pending
        ) {
          throw new BadRequestException('Solicitação sem membro pendente válido.');
        }
      }

      const reviewedAt = new Date();
      const reviewed = await tx.memberApproval.updateMany({
        where: {
          id,
          familyId: user.familyId,
          status: 'pending',
        },
        data: {
          status: decision,
          reviewerUserId: user.id,
          reviewedAt,
        },
      });
      if (reviewed.count !== 1) {
        throw new BadRequestException('Solicitação já foi revisada.');
      }

      if (decision === 'approved') {
        const activatedUser = await tx.user.updateMany({
          where: {
            id: approval.userId,
            familyId: user.familyId,
            isActive: false,
            emailVerifiedAt: { not: null },
          },
          data: { isActive: true },
        });
        const activatedProfile = await tx.memberProfile.updateMany({
          where: {
            id: approval.approvedUser.profile.id,
            userId: approval.userId,
            familyId: user.familyId,
            status: ProfileStatus.pending,
          },
          data: { status: ProfileStatus.active },
        });
        if (activatedUser.count !== 1 || activatedProfile.count !== 1) {
          throw new BadRequestException('Solicitação sem membro pendente válido.');
        }
      } else {
        await tx.user.updateMany({
          where: { id: approval.userId, familyId: user.familyId },
          data: {
            email: pendingInviteEmail(approval.userId),
            emailVerifiedAt: null,
            isActive: false,
            authVersion: { increment: 1 },
          },
        });
        await tx.memberProfile.updateMany({
          where: {
            id: approval.approvedUser.profile.id,
            userId: approval.userId,
            familyId: user.familyId,
          },
          data: { status: ProfileStatus.inactive },
        });
        await tx.userIdentity.deleteMany({ where: { userId: approval.userId } });
        await this.revokePendingActionTokens(tx, approval.userId, reviewedAt);
      }

      const result = await tx.memberApproval.findFirst({
        where: { id, familyId: user.familyId },
        select: APPROVAL_SELECT,
      });
      if (!result) throw new NotFoundException('Solicitação não encontrada.');
      return this.toResponse(result);
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
        lastErrorCode: 'MEMBER_REJECTED',
      },
    });
  }

  private toResponse(approval: ApprovalProjection) {
    const emailVerified = Boolean(approval.approvedUser?.emailVerifiedAt);
    return {
      id: approval.id,
      requestedName: approval.requestedName,
      requestedEmail: approval.requestedEmail,
      status: approval.status,
      emailVerified,
      readyForApproval:
        approval.status === 'pending' &&
        emailVerified &&
        approval.approvedUser?.isActive === false &&
        approval.approvedUser.profile?.status === ProfileStatus.pending,
      reviewedAt: approval.reviewedAt,
      createdAt: approval.createdAt,
    };
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
      throw new ForbiddenException(
        'Somente o owner de um tenant ativo pode revisar solicitações.',
      );
    }
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
