import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { endOfMonth, parseMonth, startOfMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser, query: { month?: string; profileId?: string }) {
    const reference = parseMonth(query.month);
    const where: Prisma.TransactionWhereInput = {
      memberProfile: { familyId: user.familyId },
      referenceMonth: { gte: startOfMonth(reference), lte: endOfMonth(reference) },
    };

    if (query.profileId) {
      where.memberProfileId = query.profileId;
    }

    return this.prisma.transaction.findMany({
      where,
      include: {
        account: true,
        category: true,
        invoice: true,
        installmentPlan: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(user: AuthenticatedUser, dto: CreateTransactionDto) {
    await this.validateRelations(user, dto.accountId, dto.categoryId, dto.invoiceId);
    return this.prisma.transaction.create({
      data: {
        date: new Date(dto.date),
        referenceMonth: startOfMonth(new Date(dto.referenceMonth ?? dto.date)),
        description: dto.description,
        amountCents: dto.amountCents,
        type: dto.type,
        status: dto.status ?? 'confirmed',
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
      include: {
        account: true,
        category: true,
        invoice: true,
        installmentPlan: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateTransactionDto) {
    await this.ensureTransaction(user, id);
    await this.validateRelations(user, dto.accountId, dto.categoryId, dto.invoiceId);
    return this.prisma.transaction.update({
      where: { id },
      data: {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
        referenceMonth: dto.referenceMonth ? startOfMonth(new Date(dto.referenceMonth)) : undefined,
      },
      include: {
        account: true,
        category: true,
        invoice: true,
        installmentPlan: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureTransaction(user, id);
    return this.prisma.transaction.delete({ where: { id } });
  }

  private async ensureTransaction(user: AuthenticatedUser, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
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

    if (invoiceId) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: invoiceId, memberProfileId: user.profileId },
      });
      if (!invoice) throw new BadRequestException('Fatura inválida');
      if (accountId && invoice.accountId !== accountId) {
        throw new BadRequestException('Fatura não pertence à conta selecionada');
      }
    }
  }
}
