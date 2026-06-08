import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { addMonths, startOfMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

@Injectable()
export class InstallmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.installmentPlan.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: {
        transactions: {
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
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateInstallmentDto) {
    const account = await this.validateRelations(user, dto.accountId, dto.categoryId, dto.invoiceId);
    const firstReferenceMonth = startOfMonth(new Date(dto.firstReferenceMonth));
    const firstInstallmentReference = addMonths(firstReferenceMonth, 1 - dto.firstInstallmentNumber);
    const candidates = await this.findLinkCandidates(user, dto, firstInstallmentReference);

    if (candidates.length > 0 && !dto.confirmExistingLinks) {
      throw new ConflictException({
        code: 'installment_link_confirmation_required',
        candidates,
      });
    }

    const bookkeepingDate = new Date(dto.startsAt);
    const currentMonth = startOfMonth(new Date());

    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.installmentPlan.create({
        data: {
          description: dto.description,
          totalInstallments: dto.totalInstallments,
          firstInstallmentNumber: dto.firstInstallmentNumber,
          firstReferenceMonth,
          paidInstallments:
            dto.paidInstallments ??
            Array.from({ length: dto.totalInstallments }, (_, index) => addMonths(firstInstallmentReference, index)).filter(
              (reference) => reference <= currentMonth,
            ).length,
          monthlyAmountCents: dto.monthlyAmountCents,
          totalAmountCents: dto.totalAmountCents,
          startsAt: bookkeepingDate,
          memberProfileId: user.profileId,
        },
      });

      for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
        const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
        const invoiceId = account?.type === 'credit_card'
          ? await this.findOrCreateInvoice(tx, user, account, referenceMonth, dto.invoiceId)
          : undefined;
        const candidate = candidates.find((item) => item.installmentNumber === installmentNumber);

        if (candidate) {
          await tx.transaction.update({
            where: { id: candidate.candidateTransactionId },
            data: {
              installmentPlanId: plan.id,
              installmentNumber,
              linkedToPlanAt: new Date(),
              linkedToPlanByUserId: user.id,
              invoiceId,
            },
          });
          continue;
        }

        await tx.transaction.create({
          data: {
            date: bookkeepingDate,
            referenceMonth,
            description: `${dto.description} - Parcela ${installmentNumber}/${dto.totalInstallments}`,
            amountCents: dto.monthlyAmountCents,
            type: 'expense',
            status: referenceMonth > currentMonth ? 'pending' : 'confirmed',
            recurrenceType: 'none',
            source: 'installment',
            accountId: dto.accountId,
            categoryId: dto.categoryId,
            invoiceId,
            installmentPlanId: plan.id,
            installmentNumber,
            memberProfileId: user.profileId,
          },
        });
      }

      return tx.installmentPlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: {
          transactions: {
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
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInstallmentDto) {
    await this.ensure(user, id);
    return this.prisma.installmentPlan.update({
      where: { id },
      data: {
        description: dto.description,
        totalInstallments: dto.totalInstallments,
        paidInstallments: dto.paidInstallments,
        firstInstallmentNumber: dto.firstInstallmentNumber,
        monthlyAmountCents: dto.monthlyAmountCents,
        totalAmountCents: dto.totalAmountCents,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        firstReferenceMonth: dto.firstReferenceMonth ? new Date(dto.firstReferenceMonth) : undefined,
      },
      include: {
        transactions: {
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
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensure(user, id);
    await this.prisma.transaction.updateMany({
      where: { installmentPlanId: id },
      data: {
        installmentPlanId: null,
        installmentNumber: null,
      },
    });
    return this.prisma.installmentPlan.delete({ where: { id } });
  }

  private async ensure(user: AuthenticatedUser, id: string) {
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!plan) throw new NotFoundException('Parcelamento não encontrado');
    return plan;
  }

  private async validateRelations(user: AuthenticatedUser, accountId?: string, categoryId?: string, invoiceId?: string) {
    const account = accountId
      ? await this.prisma.account.findFirst({ where: { id: accountId, memberProfileId: user.profileId } })
      : null;
    if (accountId && !account) throw new BadRequestException('Conta inválida');

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

    return account;
  }

  private async findLinkCandidates(user: AuthenticatedUser, dto: CreateInstallmentDto, firstInstallmentReference: Date) {
    const normalizedDescription = normalizeText(dto.description);
    const candidates = [];

    for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
      const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
      const existing = await this.prisma.transaction.findFirst({
        where: {
          memberProfileId: user.profileId,
          referenceMonth,
          amountCents: dto.monthlyAmountCents,
          installmentPlanId: null,
          type: 'expense',
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
        });
      }
    }

    return candidates;
  }

  private async findOrCreateInvoice(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    account: NonNullable<Awaited<ReturnType<InstallmentsService['validateRelations']>>>,
    referenceMonth: Date,
    preferredInvoiceId?: string,
  ) {
    if (preferredInvoiceId) {
      const preferred = await tx.invoice.findFirst({
        where: { id: preferredInvoiceId, accountId: account.id, memberProfileId: user.profileId, referenceMonth },
      });
      if (preferred) return preferred.id;
    }

    const invoice = await tx.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId: account.id,
          referenceMonth,
        },
      },
      update: {},
      create: {
        accountId: account.id,
        memberProfileId: user.profileId,
        referenceMonth,
        status: 'open',
        closingDate: account.closingDay ? dateWithDay(referenceMonth, account.closingDay) : undefined,
        dueDate: account.dueDay ? dateWithDay(referenceMonth, account.dueDay) : undefined,
      },
    });

    return invoice.id;
  }
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
  const safeDay = Math.min(Math.max(day, 1), new Date(Date.UTC(referenceMonth.getUTCFullYear(), referenceMonth.getUTCMonth() + 1, 0)).getUTCDate());
  return new Date(Date.UTC(referenceMonth.getUTCFullYear(), referenceMonth.getUTCMonth(), safeDay));
}
