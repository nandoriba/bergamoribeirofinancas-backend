import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { dateFromAccountDay } from '../../shared/credit-card-invoice';
import { addMonths, clampDayForMonth, endOfDay, startOfMonth } from '../../shared/date-range';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { ListInstallmentsQueryDto } from './dto/list-installments-query.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

type PrismaExecutor = PrismaService | Prisma.TransactionClient;

@Injectable()
export class InstallmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  async list(context: TenantContext, query: ListInstallmentsQueryDto = new ListInstallmentsQueryDto()) {
    const where = this.tenantScope.byFamilyProfiles(context);
    if (query.cursor) {
      const cursor = await this.prisma.installmentPlan.findFirst({
        where: { id: query.cursor, ...where },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Cursor inválido');
    }

    const [rows, summary] = await Promise.all([
      this.prisma.installmentPlan.findMany({
        where,
        include: {
          transactions: {
            where: this.consistentTransactionsWhere(context),
            include: {
              account: true,
              category: true,
              invoice: { include: { account: true } },
              memberProfile: { select: { id: true, displayName: true } },
            },
            orderBy: [{ referenceMonth: 'asc' }, { installmentNumber: 'asc' }],
          },
          memberProfile: { select: { id: true, displayName: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.summarizeFamily(context),
    ]);

    const hasNextPage = rows.length > query.limit;
    const page = hasNextPage ? rows.slice(0, query.limit) : rows;
    const items = page.map((plan) => this.withComputedAmounts(plan));

    return {
      items,
      summary,
      pageInfo: {
        hasNextPage,
        nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
      },
    };
  }

  async create(context: TenantContext, dto: CreateInstallmentDto) {
    this.validateInstallmentShape(dto);
    return this.prisma.$transaction((tx) => this.createInTransaction(tx, context, dto));
  }

  async createInTransaction(tx: Prisma.TransactionClient, context: TenantContext, dto: CreateInstallmentDto) {
    this.validateInstallmentShape(dto);
    const account = await this.validateRelations(tx, context, dto.accountId, dto.categoryId, dto.invoiceId);
    const description = cleanInstallmentDescription(dto.description);
    const firstReferenceMonth = startOfMonth(new Date(dto.firstReferenceMonth));
    const firstInstallmentReference = addMonths(firstReferenceMonth, 1 - dto.firstInstallmentNumber);
    const monthlyAmountCents = Math.abs(dto.monthlyAmountCents);
    const totalAmountCents = monthlyAmountCents * dto.totalInstallments;
    const candidates = await this.findLinkCandidates(tx, context, dto, firstInstallmentReference);

    if (candidates.length > 0 && !dto.confirmExistingLinks) {
      throw new ConflictException({
        code: 'installment_link_confirmation_required',
        candidates,
      });
    }

    const bookkeepingDate = new Date(dto.startsAt);
    const baseApplicationDate = new Date(dto.firstApplicationDate ?? dto.startsAt);
    const todayEnd = endOfDay(new Date());

    const installmentApplicationDates = Array.from({ length: dto.totalInstallments }, (_, index) =>
      dateWithDay(addMonths(firstInstallmentReference, index), baseApplicationDate.getUTCDate()),
    );
    const plan = await tx.installmentPlan.create({
      data: {
        description,
        totalInstallments: dto.totalInstallments,
        firstInstallmentNumber: dto.firstInstallmentNumber,
        firstReferenceMonth,
        paidInstallments:
          dto.paidInstallments ??
          installmentApplicationDates.filter((applicationDate) => applicationDate <= todayEnd).length,
        monthlyAmountCents,
        totalAmountCents,
        startsAt: bookkeepingDate,
        memberProfileId: context.authorProfileId,
      },
    });

    for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
      const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
      const applicationDate = installmentApplicationDates[installmentNumber - 1];
      const invoiceId = account?.type === 'credit_card'
        ? await this.findOrCreateInvoice(tx, context, account, referenceMonth, dto.invoiceId)
        : undefined;
      const candidate = candidates.find((item) => item.installmentNumber === installmentNumber);

      if (candidate) {
        const linked = await tx.transaction.updateMany({
          where: {
            id: candidate.candidateTransactionId,
            memberProfileId: context.authorProfileId,
            installmentPlanId: null,
            updatedAt: candidate.updatedAt,
            referenceMonth,
            amountCents: monthlyAmountCents,
            type: 'expense',
            accountId: dto.accountId ?? null,
            categoryId: dto.categoryId ?? null,
            ...this.tenantScope.consistentTransactionRelations(context),
          },
          data: {
            installmentPlanId: plan.id,
            installmentNumber,
            applicationDate,
            status: 'confirmed',
            linkedToPlanAt: new Date(),
            linkedToPlanByUserId: context.userId,
            accountId: dto.accountId,
            categoryId: dto.categoryId,
            invoiceId,
          },
        });
        if (linked.count !== 1) {
          throw new ConflictException({
            code: 'installment_link_candidate_changed',
            message: 'Um lançamento candidato foi alterado; revise o parcelamento antes de confirmar.',
          });
        }
        continue;
      }

      await tx.transaction.create({
        data: {
          date: bookkeepingDate,
          applicationDate,
          referenceMonth,
          description: `${description} - Parcela ${installmentNumber}/${dto.totalInstallments}`,
          amountCents: monthlyAmountCents,
          type: 'expense',
          status: 'confirmed',
          recurrenceType: 'none',
          source: 'installment',
          accountId: dto.accountId,
          categoryId: dto.categoryId,
          invoiceId,
          installmentPlanId: plan.id,
          installmentNumber,
          memberProfileId: context.authorProfileId,
        },
      });
    }

    const created = await tx.installmentPlan.findUniqueOrThrow({
      where: { id: plan.id, memberProfileId: context.authorProfileId },
      include: {
        transactions: {
          where: this.consistentTransactionsWhere(context),
          include: {
            account: true,
            category: true,
            invoice: { include: { account: true } },
            memberProfile: { select: { id: true, displayName: true } },
          },
          orderBy: [{ referenceMonth: 'asc' }, { installmentNumber: 'asc' }],
        },
        memberProfile: { select: { id: true, displayName: true } },
      },
    });

    return this.withComputedAmounts(created);
  }

  async update(context: TenantContext, id: string, dto: UpdateInstallmentDto) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.ensure(tx, context, id);
      const description = dto.description === undefined ? undefined : cleanInstallmentDescription(dto.description);
      if (description !== undefined && !description) throw new BadRequestException('Descrição obrigatória');
      if (dto.paidInstallments !== undefined && dto.paidInstallments > current.totalInstallments) {
        throw new BadRequestException('Parcelas pagas não podem ser maiores que o total de parcelas');
      }

      if (description !== undefined && description !== current.description) {
        const generatedTransactions = await tx.transaction.findMany({
          where: {
            installmentPlanId: id,
            memberProfileId: context.authorProfileId,
            source: 'installment',
          },
          select: { id: true, installmentNumber: true },
        });
        for (const transaction of generatedTransactions) {
          await tx.transaction.update({
            where: { id: transaction.id, memberProfileId: context.authorProfileId },
            data: {
              description: `${description} - Parcela ${transaction.installmentNumber ?? '?'}/${current.totalInstallments}`,
            },
          });
        }
      }

      const updated = await tx.installmentPlan.update({
        where: { id, memberProfileId: context.authorProfileId },
        data: { description, paidInstallments: dto.paidInstallments },
        include: {
          transactions: {
            where: this.consistentTransactionsWhere(context),
            include: {
              account: true,
              category: true,
              invoice: { include: { account: true } },
              memberProfile: { select: { id: true, displayName: true } },
            },
            orderBy: [{ referenceMonth: 'asc' }, { installmentNumber: 'asc' }],
          },
          memberProfile: { select: { id: true, displayName: true } },
        },
      });

      return this.withComputedAmounts(updated);
    });
  }

  async remove(context: TenantContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.ensure(tx, context, id);
      await tx.transaction.updateMany({
        where: { installmentPlanId: id, memberProfileId: context.authorProfileId },
        data: {
          installmentPlanId: null,
          installmentNumber: null,
        },
      });
      return tx.installmentPlan.delete({ where: { id, memberProfileId: context.authorProfileId } });
    });
  }

  async removeTelegramCreatedPlanInTransaction(tx: Prisma.TransactionClient, context: TenantContext, id: string) {
    const plan = await tx.installmentPlan.findFirst({
      where: { id, memberProfileId: context.authorProfileId },
    });
    if (!plan) throw new NotFoundException('Parcelamento não encontrado');

    await tx.transaction.deleteMany({
      where: { installmentPlanId: id, memberProfileId: context.authorProfileId },
    });
    return tx.installmentPlan.delete({ where: { id, memberProfileId: context.authorProfileId } });
  }

  private async ensure(client: PrismaExecutor, context: TenantContext, id: string) {
    const plan = await client.installmentPlan.findFirst({
      where: { id, memberProfileId: context.authorProfileId },
    });
    if (!plan) throw new NotFoundException('Parcelamento não encontrado');
    return plan;
  }

  private withComputedAmounts<TPlan extends { totalInstallments: number; paidInstallments: number; monthlyAmountCents: number }>(
    plan: TPlan,
  ) {
    const remainingInstallments = Math.max(plan.totalInstallments - plan.paidInstallments, 0);
    return {
      ...plan,
      remainingInstallments,
      amountToPayCents: remainingInstallments * Math.abs(plan.monthlyAmountCents),
    };
  }

  private async validateRelations(
    client: PrismaExecutor,
    context: TenantContext,
    accountId?: string,
    categoryId?: string,
    invoiceId?: string,
  ) {
    const account = accountId
      ? await client.account.findFirst({ where: { id: accountId, memberProfileId: context.authorProfileId } })
      : null;
    if (accountId && !account) throw new BadRequestException('Conta inválida');

    if (categoryId) {
      const category = await client.category.findFirst({
        where: { id: categoryId, familyId: context.familyId },
      });
      if (!category) throw new BadRequestException('Categoria inválida');
    }

    if (invoiceId) {
      const invoice = await client.invoice.findFirst({
        where: { id: invoiceId, memberProfileId: context.authorProfileId },
      });
      if (!invoice) throw new BadRequestException('Fatura inválida');
      if (!accountId) {
        throw new BadRequestException('Informe a conta da fatura');
      }
      if (invoice.accountId !== accountId) {
        throw new BadRequestException('Fatura não pertence à conta selecionada');
      }
      if (account?.type !== 'credit_card') {
        throw new BadRequestException('Fatura só pode ser vinculada a cartão de crédito');
      }
    }

    return account;
  }

  private async findLinkCandidates(
    client: PrismaExecutor,
    context: TenantContext,
    dto: CreateInstallmentDto,
    firstInstallmentReference: Date,
  ) {
    const normalizedDescription = normalizeText(dto.description);
    const monthlyAmountCents = Math.abs(dto.monthlyAmountCents);
    const candidates = [];

    for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
      const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
      const existing = await client.transaction.findFirst({
        where: {
          memberProfileId: context.authorProfileId,
          referenceMonth,
          amountCents: monthlyAmountCents,
          installmentPlanId: null,
          type: 'expense',
          accountId: dto.accountId ?? null,
          categoryId: dto.categoryId ?? null,
          ...this.tenantScope.consistentTransactionRelations(context),
        },
        orderBy: { createdAt: 'asc' },
      });

      if (existing && isSimilar(normalizedDescription, normalizeText(existing.description))) {
        candidates.push({
          candidateTransactionId: existing.id,
          installmentNumber,
          referenceMonth: referenceMonth.toISOString(),
          description: existing.description,
          amountCents: existing.amountCents,
          updatedAt: existing.updatedAt,
        });
      }
    }

    return candidates;
  }

  private async findOrCreateInvoice(
    tx: Prisma.TransactionClient,
    context: TenantContext,
    account: { id: string; closingDay: number | null; dueDay: number | null },
    referenceMonth: Date,
    preferredInvoiceId?: string,
  ) {
    if (preferredInvoiceId) {
      const preferred = await tx.invoice.findFirst({
        where: {
          id: preferredInvoiceId,
          accountId: account.id,
          memberProfileId: context.authorProfileId,
          referenceMonth,
        },
      });
      if (preferred) return preferred.id;
    }

    const invoice = await tx.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId: account.id,
          referenceMonth,
        },
        memberProfileId: context.authorProfileId,
      },
      update: {},
      create: {
        accountId: account.id,
        memberProfileId: context.authorProfileId,
        referenceMonth,
        status: 'open',
        closingDate: dateFromAccountDay(referenceMonth, account.closingDay),
        dueDate: dateFromAccountDay(referenceMonth, account.dueDay),
      },
    });

    return invoice.id;
  }

  private consistentTransactionsWhere(context: TenantContext): Prisma.TransactionWhereInput {
    return {
      ...this.tenantScope.byFamilyProfiles(context),
      ...this.tenantScope.consistentTransactionRelations(context),
    };
  }

  private async summarizeFamily(context: TenantContext) {
    const [summary] = await this.prisma.$queryRaw<
      Array<{ totalPurchaseCents: bigint; totalInstallments: bigint; totalAmountToPayCents: bigint }>
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(ABS(plan."totalAmountCents")), 0)::bigint AS "totalPurchaseCents",
        COALESCE(SUM(plan."totalInstallments"), 0)::bigint AS "totalInstallments",
        COALESCE(
          SUM(GREATEST(plan."totalInstallments" - plan."paidInstallments", 0) * ABS(plan."monthlyAmountCents")),
          0
        )::bigint AS "totalAmountToPayCents"
      FROM "InstallmentPlan" plan
      INNER JOIN "MemberProfile" profile ON profile.id = plan."memberProfileId"
      WHERE profile."familyId" = ${context.familyId}
    `);

    return {
      totalPurchaseCents: Number(summary?.totalPurchaseCents ?? 0n),
      totalInstallments: Number(summary?.totalInstallments ?? 0n),
      totalAmountToPayCents: Number(summary?.totalAmountToPayCents ?? 0n),
    };
  }

  private validateInstallmentShape(dto: Pick<CreateInstallmentDto, 'description' | 'firstInstallmentNumber' | 'monthlyAmountCents' | 'paidInstallments' | 'totalInstallments'>) {
    if (!cleanInstallmentDescription(dto.description)) {
      throw new BadRequestException('Descrição obrigatória');
    }
    if (dto.firstInstallmentNumber > dto.totalInstallments) {
      throw new BadRequestException('Parcela atual não pode ser maior que o total de parcelas');
    }
    if ((dto.paidInstallments ?? 0) > dto.totalInstallments) {
      throw new BadRequestException('Parcelas pagas não podem ser maiores que o total de parcelas');
    }
    if (dto.monthlyAmountCents <= 0) {
      throw new BadRequestException('Valor da parcela deve ser maior que zero');
    }
  }
}

function cleanInstallmentDescription(description: string) {
  return description
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—]+\s*$/g, '')
    .trim();
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/parcela\s*\d+\s*\/\s*\d+/g, '')
    .replace(/\d+\s*\/\s*\d+/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function isSimilar(base: string, candidate: string) {
  if (!base || !candidate) return false;
  if (candidate.includes(base) || base.includes(candidate)) return true;
  const baseTokens = new Set(base.split(' '));
  const candidateTokens = new Set(candidate.split(' '));
  const intersection = [...baseTokens].filter((token) => candidateTokens.has(token)).length;
  const union = new Set([...baseTokens, ...candidateTokens]).size;
  return union > 0 && intersection / union >= 0.7;
}

function dateWithDay(referenceMonth: Date, day: number) {
  return clampDayForMonth(referenceMonth, day);
}
