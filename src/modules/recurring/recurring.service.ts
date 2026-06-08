import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { parseMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';

@Injectable()
export class RecurringService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.recurringTemplate.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(user: AuthenticatedUser, dto: CreateRecurringDto) {
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
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateRecurringDto) {
    await this.ensure(user, id);
    return this.prisma.recurringTemplate.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensure(user, id);
    return this.prisma.recurringTemplate.delete({ where: { id } });
  }

  async generateForMonth(user: AuthenticatedUser, month?: string) {
    const reference = parseMonth(month);
    const templates = await this.prisma.recurringTemplate.findMany({
      where: {
        memberProfileId: user.profileId,
        status: 'active',
        startsAt: { lte: reference },
        OR: [{ endsAt: null }, { endsAt: { gte: reference } }],
      },
    });

    const created = [];
    for (const template of templates) {
      const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), template.dayOfMonth));
      const externalId = `recurring:${template.id}:${reference.toISOString().slice(0, 7)}`;
      const transaction = await this.prisma.transaction.upsert({
        where: {
          memberProfileId_externalId: {
            memberProfileId: user.profileId,
            externalId,
          },
        },
        update: {},
        create: {
          date,
          description: template.description,
          amountCents: template.amountCents,
          type: template.type,
          recurrenceType: 'monthly',
          externalId,
          source: 'recurring',
          accountId: template.accountId,
          categoryId: template.categoryId,
          memberProfileId: user.profileId,
          recurringTemplateId: template.id,
        },
      });
      created.push(transaction);
    }

    return { generated: created.length, transactions: created };
  }

  private async ensure(user: AuthenticatedUser, id: string) {
    const template = await this.prisma.recurringTemplate.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!template) throw new NotFoundException('Recorrente não encontrado');
    return template;
  }
}

