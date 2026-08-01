import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { clampDayForMonth, endOfDay, endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';

@Injectable()
export class RecurringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  async list(context: TenantContext) {
    const accounts = await this.prisma.account.findMany({
      where: this.tenantScope.byFamilyProfiles(context),
      select: { id: true },
    });
    const templates = await this.prisma.recurringTemplate.findMany({
      where: {
        deletedAt: null,
        ...this.tenantScope.byFamilyProfiles(context),
        ...this.tenantScope.consistentRecurringRelations(
          context,
          accounts.map((account) => account.id),
        ),
      },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return templates;
  }

  async create(context: TenantContext, dto: CreateRecurringDto) {
    await this.validateRelations(context, dto.accountId, dto.categoryId);
    this.validatePeriod(dto.startsAt, dto.endsAt);
    return this.prisma.recurringTemplate.create({
      data: {
        description: dto.description.trim(),
        amountCents: Math.abs(dto.amountCents),
        type: dto.type,
        dayOfMonth: dto.dayOfMonth,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        notes: normalizeOptionalText(dto.notes),
        status: dto.status ?? 'active',
        accountId: dto.accountId,
        categoryId: dto.categoryId,
        memberProfileId: context.authorProfileId,
      },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async update(context: TenantContext, id: string, dto: UpdateRecurringDto) {
    const current = await this.ensure(context, id);
    await this.validateRelations(
      context,
      dto.accountId ?? current.accountId ?? undefined,
      dto.categoryId ?? current.categoryId ?? undefined,
    );
    this.validatePeriod(dto.startsAt ?? current.startsAt.toISOString(), dto.endsAt ?? current.endsAt?.toISOString());
    return this.prisma.recurringTemplate.update({
      where: { id, memberProfileId: context.authorProfileId },
      data: {
        ...dto,
        description: dto.description?.trim(),
        amountCents: dto.amountCents !== undefined ? Math.abs(dto.amountCents) : undefined,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        notes: dto.notes !== undefined ? normalizeOptionalText(dto.notes) : undefined,
      },
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async remove(context: TenantContext, id: string) {
    await this.ensure(context, id);
    return this.prisma.recurringTemplate.update({
      where: { id, memberProfileId: context.authorProfileId },
      data: {
        deletedAt: new Date(),
        status: 'paused',
      },
    });
  }

  async generateForMonth(context: TenantContext, month?: string) {
    const reference = parseMonth(month);
    const transactions = await this.materializeOwnProfile(context, reference);
    return { generated: transactions.length, transactions };
  }

  async materializeOwnProfile(context: TenantContext, reference: Date) {
    const monthStart = startOfMonth(reference);
    const monthEnd = endOfMonth(reference);
    const accounts = await this.prisma.account.findMany({
      where: this.tenantScope.byAuthor(context),
      select: { id: true },
    });
    const templates = await this.prisma.recurringTemplate.findMany({
      where: {
        memberProfileId: context.authorProfileId,
        deletedAt: null,
        status: 'active',
        startsAt: { lte: monthEnd },
        OR: [{ endsAt: null }, { endsAt: { gte: monthStart } }],
        ...this.tenantScope.consistentRecurringRelations(
          context,
          accounts.map((account) => account.id),
        ),
      },
    });

    const created = [];
    const bookkeepingDate = new Date();
    const todayEnd = endOfDay(bookkeepingDate);
    for (const template of templates) {
      await this.validateRelations(context, template.accountId ?? undefined, template.categoryId ?? undefined);
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
          notes: template.notes,
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

  private async ensure(context: TenantContext, id: string) {
    const template = await this.prisma.recurringTemplate.findFirst({
      where: { id, memberProfileId: context.authorProfileId, deletedAt: null },
    });
    if (!template) throw new NotFoundException('Recorrente não encontrado');
    return template;
  }

  private async validateRelations(context: TenantContext, accountId?: string, categoryId?: string) {
    if (accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: accountId, memberProfileId: context.authorProfileId },
      });
      if (!account) throw new BadRequestException('Conta inválida');
    }

    if (categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: categoryId, familyId: context.familyId },
      });
      if (!category) throw new BadRequestException('Categoria inválida');
    }
  }

  private validatePeriod(startsAt?: string, endsAt?: string | null) {
    if (!startsAt || !endsAt) return;
    if (new Date(endsAt) < new Date(startsAt)) {
      throw new BadRequestException('Data final não pode ser anterior à data inicial');
    }
  }
}

function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
