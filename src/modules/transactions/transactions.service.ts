import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { dateFromAccountDay, resolveCreditCardReferenceMonth } from '../../shared/credit-card-invoice';
import { endOfDay, endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';

const transactionInclude = {
  account: true,
  category: true,
  invoice: true,
  installmentPlan: true,
  memberProfile: { select: { id: true, displayName: true } },
} satisfies Prisma.TransactionInclude;

type TransactionWithRelations = Prisma.TransactionGetPayload<{ include: typeof transactionInclude }>;
type PrismaExecutor = PrismaService | Prisma.TransactionClient;

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  async list(
    context: TenantContext,
    query: { referenceMonth?: string; profileId?: string; cursor?: string; limit?: number },
  ) {
    const reference = parseMonth(query.referenceMonth);
    const limit = query.limit ?? 50;
    const profileIds = await this.tenantScope.resolveProfileIds(
      context,
      query.profileId ? { profileId: query.profileId } : { family: true },
    );
    const where: Prisma.TransactionWhereInput = {
      memberProfileId: { in: profileIds },
      referenceMonth: { gte: startOfMonth(reference), lte: endOfMonth(reference) },
      ...this.tenantScope.consistentTransactionRelations(context),
    };

    if (query.cursor) {
      const cursor = await this.prisma.transaction.findFirst({
        where: { ...where, id: query.cursor },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Cursor inválido');
    }

    const transactions = await this.prisma.transaction.findMany({
      where,
      include: transactionInclude,
      orderBy: [{ applicationDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasNextPage = transactions.length > limit;
    const page = hasNextPage ? transactions.slice(0, limit) : transactions;
    return {
      items: page.map(mapTransactionResponse),
      pageInfo: {
        nextCursor: hasNextPage ? (page.at(-1)?.id ?? null) : null,
        hasNextPage,
      },
    };
  }

  async create(context: TenantContext, dto: CreateTransactionDto) {
    return this.createInTransaction(this.prisma, context, dto);
  }

  async createInTransaction(client: PrismaExecutor, context: TenantContext, dto: CreateTransactionDto) {
    const account = await this.validateRelations(client, context, dto.accountId, dto.categoryId, dto.invoiceId);
    const applicationDate = new Date(dto.applicationDate);
    await this.validateDuplicate(client, context, dto, applicationDate);
    const fallbackReferenceMonth = startOfMonth(new Date(dto.referenceMonth ?? dto.applicationDate));
    const referenceMonth =
      account?.type === 'credit_card' && !dto.referenceMonth
        ? (resolveCreditCardReferenceMonth(account, applicationDate) ?? fallbackReferenceMonth)
        : fallbackReferenceMonth;
    const invoiceId =
      account?.type === 'credit_card'
        ? await this.findOrCreateInvoice(client, context, account, referenceMonth, dto.invoiceId)
        : dto.invoiceId;

    const transaction = await client.transaction.create({
      data: {
        date: new Date(),
        applicationDate,
        referenceMonth,
        description: dto.description.trim(),
        amountCents: Math.abs(dto.amountCents),
        type: dto.type,
        status: this.resolveManualStatus(applicationDate, dto.status),
        recurrenceType: dto.recurrenceType ?? 'none',
        source: dto.source,
        externalId: dto.externalId,
        notes: dto.notes,
        accountId: dto.accountId,
        categoryId: dto.categoryId,
        invoiceId,
        installmentNumber: dto.installmentNumber,
        memberProfileId: context.authorProfileId,
      },
      include: transactionInclude,
    });
    return mapTransactionResponse(transaction);
  }

  async update(context: TenantContext, id: string, dto: UpdateTransactionDto) {
    const current = await this.ensureTransaction(this.prisma, context, id);
    if (current.installmentPlanId && changesInstallmentStructure(dto)) {
      throw new ConflictException('Altere os dados estruturais pelo parcelamento vinculado.');
    }
    const updateData = { ...dto };
    delete updateData.allowDuplicate;
    const nextAccountId = hasOwn(dto, 'accountId') ? (dto.accountId ?? null) : current.accountId;
    const nextCategoryId = hasOwn(dto, 'categoryId') ? (dto.categoryId ?? null) : current.categoryId;
    const nextInvoiceId = hasOwn(dto, 'invoiceId') ? (dto.invoiceId ?? null) : current.invoiceId;
    await this.validateRelations(
      this.prisma,
      context,
      nextAccountId,
      nextCategoryId,
      nextInvoiceId,
    );
    const applicationDate = dto.applicationDate ? new Date(dto.applicationDate) : current.applicationDate;
    try {
      const transaction = await this.prisma.transaction.update({
        where: {
          id,
          memberProfileId: context.authorProfileId,
          updatedAt: current.updatedAt,
          installmentPlanId: current.installmentPlanId,
          AND: [this.tenantScope.consistentTransactionRelations(context)],
        },
        data: {
          ...updateData,
          date: undefined,
          description: dto.description?.trim(),
          amountCents: dto.amountCents !== undefined ? Math.abs(dto.amountCents) : undefined,
          applicationDate: dto.applicationDate ? applicationDate : undefined,
          referenceMonth: dto.referenceMonth ? startOfMonth(new Date(dto.referenceMonth)) : undefined,
          status: dto.status || dto.applicationDate ? this.resolveManualStatus(applicationDate, dto.status) : undefined,
        },
        include: transactionInclude,
      });
      return mapTransactionResponse(transaction);
    } catch (error) {
      if (hasPrismaCode(error, 'P2025')) {
        throw new ConflictException('O lançamento foi alterado; atualize os dados e tente novamente.');
      }
      throw error;
    }
  }

  async remove(context: TenantContext, id: string) {
    const transaction = await this.ensureTransaction(this.prisma, context, id);
    if (transaction.installmentPlanId) {
      throw new ConflictException('Remova o parcelamento vinculado em vez deste lançamento.');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.telegramFinancialOperation.updateMany({
          where: {
            transactionId: transaction.id,
            memberProfileId: context.authorProfileId,
            status: 'CREATED',
          },
          data: { status: 'UNDONE', undoneAt: new Date() },
        });
        return tx.transaction.delete({
          where: {
            id,
            memberProfileId: context.authorProfileId,
            updatedAt: transaction.updatedAt,
            installmentPlanId: null,
            AND: [this.tenantScope.consistentTransactionRelations(context)],
          },
        });
      });
    } catch (error) {
      if (hasPrismaCode(error, 'P2025')) {
        throw new ConflictException('O lançamento foi alterado; atualize os dados e tente novamente.');
      }
      throw error;
    }
  }

  private async ensureTransaction(client: PrismaExecutor, context: TenantContext, id: string) {
    const transaction = await client.transaction.findFirst({
      where: {
        id,
        memberProfileId: context.authorProfileId,
        ...this.tenantScope.consistentTransactionRelations(context),
      },
    });
    if (!transaction) {
      throw new NotFoundException('Lançamento não encontrado');
    }
    return transaction;
  }

  private async validateRelations(
    client: PrismaExecutor,
    context: TenantContext,
    accountId?: string | null,
    categoryId?: string | null,
    invoiceId?: string | null,
  ) {
    const account = accountId
      ? await client.account.findFirst({
          where: { id: accountId, memberProfileId: context.authorProfileId },
        })
      : null;

    if (accountId && !account) {
      throw new BadRequestException('Conta inválida');
    }

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

  private resolveManualStatus(applicationDate: Date, requested?: 'confirmed' | 'pending') {
    if (applicationDate <= endOfDay(new Date())) return 'confirmed';
    return requested ?? 'pending';
  }

  private async validateDuplicate(
    client: PrismaExecutor,
    context: TenantContext,
    dto: CreateTransactionDto,
    applicationDate: Date,
  ) {
    const sameValueAndDate = await client.transaction.findMany({
      where: {
        memberProfileId: context.authorProfileId,
        applicationDate,
        amountCents: Math.abs(dto.amountCents),
        type: dto.type,
      },
      select: {
        id: true,
        description: true,
        amountCents: true,
        applicationDate: true,
      },
      take: 5,
    });

    if (sameValueAndDate.length === 0) return;

    const description = normalizeDescription(dto.description);
    const strongDuplicate = sameValueAndDate.find(
      (transaction) => normalizeDescription(transaction.description) === description,
    );

    if (strongDuplicate) {
      throw new BadRequestException({
        code: 'STRONG_DUPLICATE',
        message: 'Já existe um lançamento com o mesmo valor, data de aplicação e descrição.',
        duplicate: this.mapDuplicate(strongDuplicate),
      });
    }

    if (!dto.allowDuplicate) {
      throw new ConflictException({
        code: 'FALSE_DUPLICATE',
        message: 'Já existe um lançamento com o mesmo valor e data de aplicação.',
        duplicate: this.mapDuplicate(sameValueAndDate[0]),
      });
    }
  }

  private mapDuplicate(transaction: { id: string; description: string; amountCents: number; applicationDate: Date }) {
    return {
      id: transaction.id,
      description: transaction.description,
      amountCents: transaction.amountCents,
      applicationDate: transaction.applicationDate.toISOString(),
    };
  }

  private async findOrCreateInvoice(
    client: PrismaExecutor,
    context: TenantContext,
    account: { id: string; closingDay: number | null; dueDay: number | null },
    referenceMonth: Date,
    preferredInvoiceId?: string,
  ) {
    if (preferredInvoiceId) return preferredInvoiceId;

    const invoice = await client.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId: account.id,
          referenceMonth,
        },
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

    if (invoice.memberProfileId !== context.authorProfileId) {
      throw new BadRequestException('Fatura inconsistente para a conta selecionada');
    }

    return invoice.id;
  }

}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasPrismaCode(error: unknown, code: string): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function changesInstallmentStructure(dto: UpdateTransactionDto) {
  return [
    'applicationDate',
    'referenceMonth',
    'amountCents',
    'type',
    'accountId',
    'categoryId',
    'invoiceId',
    'installmentNumber',
  ].some((field) => hasOwn(dto, field));
}

function normalizeDescription(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function mapTransactionResponse(transaction: TransactionWithRelations) {
  return {
    ...transaction,
    operationalCategory: resolveOperationalCategory(transaction),
  };
}

function resolveOperationalCategory(transaction: TransactionWithRelations) {
  if (transaction.isInvoiceAdjustment) {
    return {
      key: 'system:invoice_adjustment',
      name: 'Ajuste de fatura',
      color: '#e0c278',
    };
  }

  if (isInvoicePaymentTransaction(transaction)) {
    return {
      key: 'system:invoice_payment',
      name: 'Pagamento de fatura',
      color: '#d99090',
    };
  }

  if (transaction.type === 'expense' && transaction.account?.type === 'credit_card') {
    return {
      key: 'system:credit_card',
      name: 'Cartão',
      color: '#d99090',
    };
  }

  if (transaction.category) {
    return {
      key: `category:${transaction.category.id}`,
      name: transaction.category.name,
      color: transaction.category.color,
    };
  }

  return {
    key: 'system:uncategorized',
    name: 'Sem categoria',
    color: '#3a4a66',
  };
}

function isInvoicePaymentTransaction(transaction: TransactionWithRelations) {
  if (transaction.isInvoicePayment) return true;
  if (transaction.type !== 'expense' || transaction.account?.type === 'credit_card') return false;

  const description = normalizeDescription(transaction.description);
  const category = normalizeDescription(transaction.category?.name ?? '');
  return category === 'cartao' && description.includes('pagamento') && description.includes('fatura');
}
