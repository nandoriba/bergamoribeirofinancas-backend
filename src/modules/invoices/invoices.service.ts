import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { clampDayForMonth, endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import { normalizeAmountCents } from '../../shared/finance-calculator';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  private invoiceInclude(context: TenantContext) {
    const familyTransactions = {
      ...this.tenantScope.byFamilyProfiles(context),
      ...this.tenantScope.consistentTransactionRelations(context),
    };
    return {
      account: { include: { memberProfile: { select: { id: true, displayName: true } } } },
      transactions: {
        where: familyTransactions,
        include: {
          category: true,
          memberProfile: { select: { id: true, displayName: true } },
          installmentPlan: {
            include: {
              transactions: {
                where: familyTransactions,
                include: {
                  invoice: {
                    include: {
                      account: true,
                    },
                  },
                },
                orderBy: [{ referenceMonth: 'asc' as const }, { installmentNumber: 'asc' as const }],
              },
            },
          },
        },
        orderBy: [{ referenceMonth: 'asc' as const }, { applicationDate: 'asc' as const }],
      },
    } satisfies Prisma.InvoiceInclude;
  }

  async list(context: TenantContext, query: ListInvoicesQueryDto = new ListInvoicesQueryDto()) {
    const referenceMonth = query.referenceMonth ? parseMonth(query.referenceMonth) : undefined;
    const where = {
      ...this.tenantScope.byFamilyProfiles(context),
      ...this.tenantScope.consistentInvoiceRelations(context),
      ...(referenceMonth
        ? { referenceMonth: { gte: startOfMonth(referenceMonth), lte: endOfMonth(referenceMonth) } }
        : {}),
    } satisfies Prisma.InvoiceWhereInput;

    if (query.cursor) {
      const cursor = await this.prisma.invoice.findFirst({
        where: { id: query.cursor, ...where },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Cursor inválido');
    }

    const rows = await this.prisma.invoice.findMany({
      where,
      include: this.invoiceInclude(context),
      orderBy: [{ referenceMonth: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasNextPage = rows.length > query.limit;
    const items = hasNextPage ? rows.slice(0, query.limit) : rows;

    return {
      items,
      pageInfo: {
        hasNextPage,
        nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
      },
    };
  }

  async create(context: TenantContext, dto: CreateInvoiceDto) {
    const account = await this.prisma.account.findFirst({
      where: { id: dto.accountId, ...this.tenantScope.byAuthor(context), type: 'credit_card' },
    });
    if (!account) throw new BadRequestException('Cartão inválido');

    const referenceMonth = startOfMonth(new Date(dto.referenceMonth));
    const existing = await this.prisma.invoice.findFirst({
      where: { accountId: account.id, referenceMonth },
    });
    if (existing) throw new BadRequestException('Fatura já existe para este cartão e mês');

    return this.prisma.invoice.create({
      data: {
        referenceMonth,
        dueDate: this.dateFromAccountDay(referenceMonth, account.dueDay),
        closingDate: this.dateFromAccountDay(referenceMonth, account.closingDay),
        totalCents: 0,
        status: 'open',
        accountId: dto.accountId,
        memberProfileId: context.authorProfileId,
      },
      include: this.invoiceInclude(context),
    });
  }

  async update(context: TenantContext, id: string, dto: UpdateInvoiceDto) {
    const invoice = await this.ensureInvoice(context, id);
    const nextAccountId = dto.accountId ?? invoice.accountId;
    const account = await this.prisma.account.findFirst({
      where: { id: nextAccountId, ...this.tenantScope.byAuthor(context), type: 'credit_card' },
    });
    if (!account) throw new BadRequestException('Cartão inválido');

    if (dto.status === 'paid' && invoice.status === 'open') {
      throw new BadRequestException('Feche a fatura antes de marcar como paga');
    }

    const nextReferenceMonth = dto.referenceMonth ? startOfMonth(new Date(dto.referenceMonth)) : undefined;
    if (nextReferenceMonth || dto.accountId) {
      const existing = await this.prisma.invoice.findFirst({
        where: {
          accountId: nextAccountId,
          referenceMonth: nextReferenceMonth ?? invoice.referenceMonth,
          id: { not: id },
          ...this.tenantScope.byAuthor(context),
        },
      });
      if (existing) throw new BadRequestException('Fatura já existe para este cartão e mês');
    }
    const totalCents = dto.status === 'closed' ? await this.calculateInvoiceTotalCents(context, id) : undefined;

    return this.prisma.invoice.update({
      where: { id, ...this.tenantScope.byAuthor(context) },
      data: {
        accountId: dto.accountId,
        referenceMonth: nextReferenceMonth,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        closingDate: dto.closingDate ? new Date(dto.closingDate) : undefined,
        status: dto.status,
        totalCents,
      },
      include: this.invoiceInclude(context),
    });
  }

  async remove(context: TenantContext, id: string) {
    await this.ensureInvoice(context, id);
    return this.prisma.invoice.delete({ where: { id, ...this.tenantScope.byAuthor(context) } });
  }

  private async ensureInvoice(context: TenantContext, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id,
        ...this.tenantScope.byAuthor(context),
        ...this.tenantScope.consistentInvoiceRelations(context),
      },
    });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');
    return invoice;
  }

  private async calculateInvoiceTotalCents(context: TenantContext, invoiceId: string) {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        invoiceId,
        memberProfileId: context.authorProfileId,
        isInvoicePayment: false,
        ...this.tenantScope.consistentTransactionRelations(context),
      },
      select: { amountCents: true, invoiceAmountCents: true, isInvoiceAdjustment: true },
    });
    return transactions.reduce(
      (sum, transaction) =>
        sum +
        (transaction.isInvoiceAdjustment
          ? (transaction.invoiceAmountCents ?? 0)
          : normalizeAmountCents(transaction.amountCents)),
      0,
    );
  }

  private dateFromAccountDay(referenceMonth: Date, day?: number | null) {
    return day ? clampDayForMonth(referenceMonth, day) : undefined;
  }
}
