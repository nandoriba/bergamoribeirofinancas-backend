import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

@Injectable()
export class InstallmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.installmentPlan.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(user: AuthenticatedUser, dto: CreateInstallmentDto) {
    return this.prisma.installmentPlan.create({
      data: {
        ...dto,
        startsAt: new Date(dto.startsAt),
        paidInstallments: dto.paidInstallments ?? 0,
        memberProfileId: user.profileId,
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInstallmentDto) {
    await this.ensure(user, id);
    return this.prisma.installmentPlan.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensure(user, id);
    return this.prisma.installmentPlan.delete({ where: { id } });
  }

  private async ensure(user: AuthenticatedUser, id: string) {
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!plan) throw new NotFoundException('Parcelamento não encontrado');
    return plan;
  }
}

