import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { clampDayForMonth, endOfDay, endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';

@Injectable()
export class RecurringService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.recurringTemplate.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateRecurringDto) {
    await this.validateRelations(user, dto.accountId, dto.categoryId);
    return this.prisma.recurringTemplate.create({
      data: {
        description: dto.description,
        amountCents: dto.amountCents,
        type: dto.type,
        dayOfMonth: dto.dayOfMonth,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        status: dto.status ?? 'active',
        accountId: dto.accountId,
        categoryId: dto.categoryId,
        memberProfileId: user.profileId,
      },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateRecurringDto) {
    await this.ensure(user, id);
    await this.validateRelations(user, dto.accountId, dto.categoryId);
    return this.prisma.recurringTemplate.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensure(user, id);
    return this.prisma.recurringTemplate.delete({ where: { id } });
  }

  async generateForMonth(user: AuthenticatedUser, month?: string) {
    const reference = parseMonth(month);
    const transactions = await this.materializeForProfiles([user.profileId], reference);
    return { generated: transactions.length, transactions };
  }

  async materializeForProfiles(profileIds: string[], reference: Date) {
    const monthStart = startOfMonth(reference);
    const monthEnd = endOfMonth(reference);
    const templates = await this.prisma.recurringTemplate.findMany({
      where: {
        memberProfileId: { in: profileIds },
        status: 'active',
        startsAt: { lte: monthEnd },
        OR: [{ endsAt: null }, { endsAt: { gte: monthStart } }],
      },
    });

    const created = [];
    const bookkeepingDate = new Date();
    const todayEnd = endOfDay(bookkeepingDate);
    for (const template of templates) {
      const applicationDate = clampDayForMonth(monthStart, template.dayOfMonth);
      const externalId = `recurring:${template.id}:${monthStart.toISOString().slice(0, 7)}`;
      const transaction = await this.prisma.transaction.upsert({
        where: {
          memberProfileId_externalId: {
            memberProfileId: template.memberProfileId,
            externalId,
          },
        },
        update: {},
        create: {
          date: bookkeepingDate,
          applicationDate,
          referenceMonth: monthStart,
          description: template.description,
          amountCents: template.amountCents,
          type: template.type,
          status: applicationDate <= todayEnd ? 'confirmed' : 'pending',
          recurrenceType: 'monthly',
          externalId,
          source: 'recurring',
          accountId: template.accountId,
          categoryId: template.categoryId,
          memberProfileId: template.memberProfileId,
          recurringTemplateId: template.id,
        },
      });
      created.push(transaction);
    }

    return created;
  }

  private async ensure(user: AuthenticatedUser, id: string) {
    const template = await this.prisma.recurringTemplate.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!template) throw new NotFoundException('Recorrente não encontrado');
    return template;
  }

  private async validateRelations(user: AuthenticatedUser, accountId?: string, categoryId?: string) {
    if (accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: accountId, memberProfileId: user.profileId },
      });
      if (!account) throw new BadRequestException('Conta inválida');
    }

    if (categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: categoryId, familyId: user.familyId },
      });
      if (!category) throw new BadRequestException('Categoria inválida');
    }
  }
}
