import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { endOfDay, endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
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

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, query: { referenceMonth?: string; profileId?: string }) {
    const reference = parseMonth(query.referenceMonth);
    const where: Prisma.TransactionWhereInput = {
      memberProfile: { familyId: user.familyId },
      referenceMonth: { gte: startOfMonth(reference), lte: endOfMonth(reference) },
    };

    if (query.profileId) {
      where.memberProfileId = query.profileId;
    }

    const transactions = await this.prisma.transaction.findMany({
      where,
      include: transactionInclude,
      orderBy: [{ applicationDate: 'desc' }, { createdAt: 'desc' }],
    });
    return transactions.map(mapTransactionResponse);
  }

  async create(user: AuthenticatedUser, dto: CreateTransactionDto) {
    await this.validateRelations(user, dto.accountId, dto.categoryId, dto.invoiceId);
    const applicationDate = new Date(dto.applicationDate);
    await this.validateDuplicate(user, dto, applicationDate);
    const transaction = await this.prisma.transaction.create({
      data: {
        date: new Date(),
        applicationDate,
        referenceMonth: startOfMonth(new Date(dto.referenceMonth ?? dto.applicationDate)),
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
        invoiceId: dto.invoiceId,
        installmentNumber: dto.installmentNumber,
        memberProfileId: user.profileId,
      },
      include: transactionInclude,
    });
    return mapTransactionResponse(transaction);
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateTransactionDto) {
    const current = await this.ensureTransaction(user, id);
    const { allowDuplicate: _allowDuplicate, ...updateData } = dto;
    await this.validateRelations(
      user,
      dto.accountId ?? current.accountId ?? undefined,
      dto.categoryId,
      dto.invoiceId ?? current.invoiceId ?? undefined,
    );
    const applicationDate = dto.applicationDate ? new Date(dto.applicationDate) : current.applicationDate;
    const transaction = await this.prisma.transaction.update({
      where: { id },
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
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureTransaction(user, id);
    return this.prisma.transaction.delete({ where: { id } });
  }

  private async ensureTransaction(user: AuthenticatedUser, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, memberProfileId: user.profileId },
    });
    if (!transaction) {
      throw new NotFoundException('Lançamento não encontrado');
    }
    return transaction;
  }

  private async validateRelations(
    user: AuthenticatedUser,
    accountId?: string,
    categoryId?: string,
    invoiceId?: string,
  ) {
    const account = accountId
      ? await this.prisma.account.findFirst({
          where: { id: accountId, memberProfileId: user.profileId },
        })
      : null;

    if (accountId && !account) {
      throw new BadRequestException('Conta inválida');
    }

    if (categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: categoryId, familyId: user.familyId },
      });
      if (!category) throw new BadRequestException('Categoria inválida');
    }

    if (invoiceId) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: invoiceId, memberProfileId: user.profileId },
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
  }

  private resolveManualStatus(applicationDate: Date, requested?: 'confirmed' | 'pending') {
    if (applicationDate <= endOfDay(new Date())) return 'confirmed';
    return requested ?? 'pending';
  }

  private async validateDuplicate(user: AuthenticatedUser, dto: CreateTransactionDto, applicationDate: Date) {
    const sameValueAndDate = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: user.profileId,
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
