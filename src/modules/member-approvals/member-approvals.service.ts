import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class MemberApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.memberApproval.findMany({
      where: { familyId: user.familyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        requestedName: true,
        requestedEmail: true,
        status: true,
        reviewedAt: true,
        createdAt: true,
      },
    });
  }

  async approve(user: AuthenticatedUser, id: string) {
    const approval = await this.prisma.memberApproval.findFirst({
      where: { id, familyId: user.familyId },
    });

    if (!approval) {
      throw new NotFoundException('Solicitação não encontrada');
    }

    if (approval.status !== 'pending' || !approval.userId) {
      throw new BadRequestException('Solicitação não está pendente');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: approval.userId! },
        data: { isActive: true },
      });
      await tx.memberProfile.update({
        where: { userId: approval.userId! },
        data: { status: 'active' },
      });
      return tx.memberApproval.update({
        where: { id },
        data: {
          status: 'approved',
          reviewerUserId: user.id,
          reviewedAt: new Date(),
        },
      });
    });
  }

  async reject(user: AuthenticatedUser, id: string) {
    const approval = await this.prisma.memberApproval.findFirst({
      where: { id, familyId: user.familyId },
    });

    if (!approval) {
      throw new NotFoundException('Solicitação não encontrada');
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException('Solicitação não está pendente');
    }

    return this.prisma.$transaction(async (tx) => {
      if (approval.userId) {
        await tx.user.update({ where: { id: approval.userId }, data: { isActive: false } });
        await tx.memberProfile.update({ where: { userId: approval.userId }, data: { status: 'inactive' } });
      }

      return tx.memberApproval.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewerUserId: user.id,
          reviewedAt: new Date(),
        },
      });
    });
  }
}

