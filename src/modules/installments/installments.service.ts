import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { addMonths, clampDayForMonth, endOfDay, startOfMonth } from '../../shared/date-range';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

@Injectable()
export class InstallmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser) {
    const plans = await this.prisma.installmentPlan.findMany({
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

    const items = plans.map((plan) => this.withComputedAmounts(plan));

    return {
      items,
      summary: {
        totalPurchaseCents: items.reduce((sum, plan) => sum + Math.abs(plan.totalAmountCents), 0),
        totalInstallments: items.reduce((sum, plan) => sum + plan.totalInstallments, 0),
        totalAmountToPayCents: items.reduce((sum, plan) => sum + plan.amountToPayCents, 0),
      },
    };
  }

  async create(user: AuthenticatedUser, dto: CreateInstallmentDto) {
    this.validateInstallmentShape(dto);
    const account = await this.validateRelations(user, dto.accountId, dto.categoryId, dto.invoiceId);
    const description = cleanInstallmentDescription(dto.description);
    const firstReferenceMonth = startOfMonth(new Date(dto.firstReferenceMonth));
    const firstInstallmentReference = addMonths(firstReferenceMonth, 1 - dto.firstInstallmentNumber);
    const monthlyAmountCents = Math.abs(dto.monthlyAmountCents);
    const totalAmountCents = monthlyAmountCents * dto.totalInstallments;
    const candidates = await this.findLinkCandidates(user, dto, firstInstallmentReference);

    if (candidates.length > 0 && !dto.confirmExistingLinks) {
      throw new ConflictException({
        code: 'installment_link_confirmation_required',
        candidates,
      });
    }

    const bookkeepingDate = new Date(dto.startsAt);
    const baseApplicationDate = new Date(dto.firstApplicationDate ?? dto.startsAt);
    const todayEnd = endOfDay(new Date());

    return this.prisma.$transaction(async (tx) => {
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
          memberProfileId: user.profileId,
        },
      });

      for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
        const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
        const applicationDate = installmentApplicationDates[installmentNumber - 1];
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
              applicationDate,
              status: 'confirmed',
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
            memberProfileId: user.profileId,
          },
        });
      }

      const created = await tx.installmentPlan.findUniqueOrThrow({
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

      return this.withComputedAmounts(created);
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInstallmentDto) {
    const current = await this.ensure(user, id);
    const description = dto.description === undefined ? undefined : cleanInstallmentDescription(dto.description);
    this.validateInstallmentShape({
      description: description ?? current.description,
      totalInstallments: dto.totalInstallments ?? current.totalInstallments,
      firstInstallmentNumber: dto.firstInstallmentNumber ?? current.firstInstallmentNumber,
      paidInstallments: dto.paidInstallments ?? current.paidInstallments,
      monthlyAmountCents: dto.monthlyAmountCents ?? current.monthlyAmountCents,
    });
    const totalAmountCents =
      Math.abs(dto.monthlyAmountCents ?? current.monthlyAmountCents) * (dto.totalInstallments ?? current.totalInstallments);
    const updated = await this.prisma.installmentPlan.update({
      where: { id },
      data: {
        description,
        totalInstallments: dto.totalInstallments,
        paidInstallments: dto.paidInstallments,
        firstInstallmentNumber: dto.firstInstallmentNumber,
        monthlyAmountCents: dto.monthlyAmountCents !== undefined ? Math.abs(dto.monthlyAmountCents) : undefined,
        totalAmountCents,
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

    return this.withComputedAmounts(updated);
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
      where: { id, memberProfileId: user.profileId },
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

  private async findLinkCandidates(user: AuthenticatedUser, dto: CreateInstallmentDto, firstInstallmentReference: Date) {
    const normalizedDescription = normalizeText(dto.description);
    const monthlyAmountCents = Math.abs(dto.monthlyAmountCents);
    const candidates = [];

    for (let installmentNumber = 1; installmentNumber <= dto.totalInstallments; installmentNumber += 1) {
      const referenceMonth = addMonths(firstInstallmentReference, installmentNumber - 1);
      const existing = await this.prisma.transaction.findFirst({
        where: {
          memberProfileId: user.profileId,
          referenceMonth,
          amountCents: monthlyAmountCents,
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
