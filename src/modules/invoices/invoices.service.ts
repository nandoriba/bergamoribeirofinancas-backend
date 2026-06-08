import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { clampDayForMonth, startOfMonth } from '../../shared/date-range';
import { normalizeAmountCents } from '../../shared/finance-calculator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly invoiceInclude = {
    account: { include: { memberProfile: { select: { id: true, displayName: true } } } },
    transactions: {
      include: {
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
        installmentPlan: {
          include: {
            transactions: {
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
  };

  list(user: AuthenticatedUser) {
    return this.prisma.invoice.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: this.invoiceInclude,
      orderBy: { referenceMonth: 'desc' },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateInvoiceDto) {
    const account = await this.prisma.account.findFirst({
      where: { id: dto.accountId, memberProfileId: user.profileId, type: 'credit_card' },
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
        memberProfileId: user.profileId,
      },
      include: this.invoiceInclude,
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInvoiceDto) {
    const invoice = await this.ensureInvoice(user, id);
    const nextAccountId = dto.accountId ?? invoice.accountId;
    const account = await this.prisma.account.findFirst({
      where: { id: nextAccountId, memberProfileId: user.profileId, type: 'credit_card' },
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
        },
      });
      if (existing) throw new BadRequestException('Fatura já existe para este cartão e mês');
    }
    const totalCents = dto.status === 'closed' ? await this.calculateInvoiceTotalCents(id) : undefined;

    return this.prisma.invoice.update({
      where: { id },
      data: {
        accountId: dto.accountId,
        referenceMonth: nextReferenceMonth,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        closingDate: dto.closingDate ? new Date(dto.closingDate) : undefined,
        status: dto.status,
        totalCents,
      },
      include: this.invoiceInclude,
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureInvoice(user, id);
    return this.prisma.invoice.delete({ where: { id } });
  }

  private async ensureInvoice(user: AuthenticatedUser, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, memberProfileId: user.profileId },
    });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');
    return invoice;
  }

  private async calculateInvoiceTotalCents(invoiceId: string) {
    const transactions = await this.prisma.transaction.findMany({
      where: { invoiceId, isInvoicePayment: false },
      select: { amountCents: true },
    });
    return transactions.reduce((sum, transaction) => sum + normalizeAmountCents(transaction.amountCents), 0);
  }

  private dateFromAccountDay(referenceMonth: Date, day?: number | null) {
    return day ? clampDayForMonth(referenceMonth, day) : undefined;
  }
}
