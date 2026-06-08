import { BadRequestException, Injectable } from '@nestjs/common';
import { ImportRowStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  addMonths,
  daysInMonth,
  endOfDay,
  endOfMonth,
  monthKey,
  parseMonth,
  startOfMonth,
} from '../../shared/date-range';
import {
  accountBalanceCents,
  accountCreditCents,
  creditCardExpenseCents,
  cumulativeAccountDailyBalances,
  dailyCreditCardSeries,
  dailyExpenseSeries,
  expenseCents,
  incomeCents,
  normalizeAmountCents,
} from '../../shared/finance-calculator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { RecurringService } from '../recurring/recurring.service';

const SHORT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const CATEGORY_COLORS = ['#3d6cb0', '#5c89c4', '#7aa5d4', '#9abfe2', '#b8d3ec', '#3a4a66'];

const transactionInclude = {
  account: true,
  category: true,
  memberProfile: { select: { id: true, displayName: true } },
} satisfies Prisma.TransactionInclude;

type DashboardTransaction = Prisma.TransactionGetPayload<{ include: typeof transactionInclude }>;
type DashboardInvoice = Prisma.InvoiceGetPayload<{ include: { account: true } }>;
type DashboardRecurring = Prisma.RecurringTemplateGetPayload<Record<string, never>>;

interface DashboardQuery {
  referenceMonth?: string;
  profileId?: string;
  family: boolean;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringService: RecurringService,
  ) {}

  async getDashboard(user: AuthenticatedUser, query: DashboardQuery) {
    const reference = parseMonth(query.referenceMonth);
    const monthStart = startOfMonth(reference);
    const monthEnd = endOfMonth(reference);
    const profileIds = await this.resolveProfileIds(user, query);

    await this.recurringService.materializeForProfiles(profileIds, reference);

    const [monthTransactions, previousMonthTransactions, importRows, installments, invoices, recurring] =
      await Promise.all([
        this.getTransactions(profileIds, monthStart, monthEnd),
        this.getTransactions(profileIds, startOfMonth(addMonths(reference, -1)), endOfMonth(addMonths(reference, -1))),
        this.getImportPreviewRows(profileIds),
        this.prisma.installmentPlan.findMany({
          where: { memberProfileId: { in: profileIds } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.invoice.findMany({
          where: {
            memberProfileId: { in: profileIds },
            referenceMonth: monthStart,
            status: { in: ['open', 'closed'] },
          },
          include: { account: true },
          orderBy: [{ dueDate: 'asc' }],
          take: 4,
        }),
        this.prisma.recurringTemplate.findMany({
          where: {
            memberProfileId: { in: profileIds },
            status: 'active',
            startsAt: { lte: monthEnd },
            OR: [{ endsAt: null }, { endsAt: { gte: monthStart } }],
          },
          orderBy: [{ dayOfMonth: 'asc' }],
          take: 4,
        }),
      ]);

    const today = new Date();
    const todayEnd = endOfDay(today);
    const currentTransactions = monthTransactions.filter(
      (transaction) => transaction.status === 'confirmed' && transaction.applicationDate <= todayEnd,
    );
    const numberOfDays = daysInMonth(reference);
    const saldoDiarioAtual = cumulativeAccountDailyBalances(0, currentTransactions, numberOfDays);
    const saldoDiarioProjetado = cumulativeAccountDailyBalances(0, monthTransactions, numberOfDays);
    const despesaDiariaAtualSpark = dailyExpenseSeries(currentTransactions, numberOfDays);
    const despesaDiariaProjetadaSpark = dailyExpenseSeries(monthTransactions, numberOfDays);
    const cartaoDiariaAtualSpark = dailyCreditCardSeries(currentTransactions, numberOfDays);
    const cartaoDiariaProjetadaSpark = dailyCreditCardSeries(monthTransactions, numberOfDays);
    const despesaFuturo = expenseCents(monthTransactions);
    const categoryTotals = this.groupExpenseCategories(monthTransactions);
    const confirmedInstallments = this.summarizeCreditCardInstallments(currentTransactions);
    const projectedInstallments = this.summarizeCreditCardInstallments(monthTransactions);

    return {
      monthRef: monthKey(reference),
      monthShort: this.formatMonth(reference),
      today: this.formatShortDate(today),
      saldoAtual: accountBalanceCents(currentTransactions),
      saldoFuturo: accountBalanceCents(monthTransactions),
      saldoAtualTotal: accountCreditCents(currentTransactions),
      saldoProjetadoTotal: accountCreditCents(monthTransactions),
      saldoAnt: 0,
      saldoMaxMes: Math.max(0, ...saldoDiarioProjetado),
      despesaAtual: expenseCents(currentTransactions),
      despesaFuturo,
      despesaAntMes: expenseCents(previousMonthTransactions),
      cartaoAtual: creditCardExpenseCents(currentTransactions),
      cartaoFuturo: creditCardExpenseCents(monthTransactions),
      cartaoAntMes: creditCardExpenseCents(previousMonthTransactions),
      receitaPrevista: incomeCents(monthTransactions),
      parcelasConfirmadasQuantidade: confirmedInstallments.count,
      parcelasConfirmadasValorCents: confirmedInstallments.amountCents,
      parcelasProjetadasQuantidade: projectedInstallments.count,
      parcelasProjetadasValorCents: projectedInstallments.amountCents,
      top5: categoryTotals.top5,
      outrosCat: categoryTotals.others,
      avisos: this.buildAlerts(invoices, recurring),
      parcelas: installments.map((plan) => ({
        name: plan.description,
        pago: plan.paidInstallments,
        total: plan.totalInstallments,
        mensal: plan.monthlyAmountCents,
        restante: Math.max(plan.totalInstallments - plan.paidInstallments, 0) * plan.monthlyAmountCents,
      })),
      saldoMensal: await this.buildMonthlyBalances(profileIds, reference),
      saldoDiario: saldoDiarioProjetado,
      saldoDiarioAtual,
      saldoDiarioProjetado,
      despesaDiariaSpark: despesaDiariaProjetadaSpark,
      despesaDiariaAtualSpark,
      despesaDiariaProjetadaSpark,
      cartaoDiariaSpark: cartaoDiariaProjetadaSpark,
      cartaoDiariaAtualSpark,
      cartaoDiariaProjetadaSpark,
      donutSlices: categoryTotals.donutSlices,
      despesaTotalMes: despesaFuturo,
      transactions: monthTransactions.slice(0, 12).map((transaction) => this.mapTransaction(transaction)),
      importPreview: importRows.map((row) => ({
        id: row.id,
        batchId: row.importBatch.id,
        date: row.date ? this.formatShortDate(row.date) : '-',
        description: row.description ?? 'Linha sem descrição',
        source: row.importBatch.type,
        suggestedCategory: row.suggestedCategory ?? 'Revisar',
        value: row.amountCents ?? 0,
        status: row.status,
      })),
    };
  }

  private async resolveProfileIds(user: AuthenticatedUser, query: DashboardQuery): Promise<string[]> {
    if (query.profileId) {
      const profile = await this.prisma.memberProfile.findFirst({
        where: { id: query.profileId, familyId: user.familyId, status: 'active' },
        select: { id: true },
      });
      if (!profile) throw new BadRequestException('Perfil inválido');
      return [profile.id];
    }

    if (!query.family) return [user.profileId];

    const profiles = await this.prisma.memberProfile.findMany({
      where: { familyId: user.familyId, status: 'active' },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });

    return profiles.map((profile) => profile.id);
  }

  private getTransactions(profileIds: string[], start: Date, end: Date) {
    return this.prisma.transaction.findMany({
      where: {
        memberProfileId: { in: profileIds },
        referenceMonth: { gte: start, lte: end },
      },
      include: transactionInclude,
      orderBy: [{ referenceMonth: 'desc' }, { applicationDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async getOpeningBalanceCents(profileIds: string[], monthStart: Date): Promise<number> {
    const [openings, accounts, priorTransactions] = await Promise.all([
      this.prisma.monthlyOpening.findMany({
        where: { memberProfileId: { in: profileIds }, referenceMonth: monthStart },
      }),
      this.prisma.account.findMany({
        where: { memberProfileId: { in: profileIds } },
        select: { memberProfileId: true, initialBalanceCents: true },
      }),
      this.prisma.transaction.findMany({
        where: {
          memberProfileId: { in: profileIds },
          referenceMonth: { lt: monthStart },
          status: 'confirmed',
        },
        include: { account: true },
      }),
    ]);

    const openingByProfile = new Map(openings.map((opening) => [opening.memberProfileId, opening.balanceCents]));
    const initialByProfile = new Map<string, number>();
    for (const account of accounts) {
      initialByProfile.set(
        account.memberProfileId,
        (initialByProfile.get(account.memberProfileId) ?? 0) + account.initialBalanceCents,
      );
    }

    const priorNetByProfile = new Map<string, number>();
    for (const transaction of priorTransactions) {
      priorNetByProfile.set(
        transaction.memberProfileId,
        (priorNetByProfile.get(transaction.memberProfileId) ?? 0) + accountBalanceCents([transaction]),
      );
    }

    return profileIds.reduce((total, profileId) => {
      const opening =
        openingByProfile.get(profileId) ?? (initialByProfile.get(profileId) ?? 0) + (priorNetByProfile.get(profileId) ?? 0);
      return total + opening;
    }, 0);
  }

  private groupExpenseCategories(transactions: DashboardTransaction[]) {
    const totals = new Map<string, { name: string; value: number; color: string }>();

    for (const transaction of transactions) {
      if (transaction.type !== 'expense') continue;
      const name = transaction.category?.name ?? 'Sem categoria';
      const current = totals.get(name) ?? {
        name,
        value: 0,
        color: transaction.category?.color ?? CATEGORY_COLORS[totals.size % CATEGORY_COLORS.length],
      };
      current.value += normalizeAmountCents(transaction.amountCents);
      totals.set(name, current);
    }

    const sorted = [...totals.values()].sort((a, b) => b.value - a.value);
    const top5 = sorted.slice(0, 5);
    const others = sorted.slice(5).reduce((total, category) => total + category.value, 0);
    const total = top5.reduce((sum, category) => sum + category.value, 0) + others;
    const donutSlices = top5.map((category) => ({
      ...category,
      pct: total > 0 ? category.value / total : 0,
    }));

    return { top5, others, donutSlices };
  }

  private async buildMonthlyBalances(profileIds: string[], reference: Date) {
    const firstMonth = addMonths(reference, -11);
    const start = startOfMonth(firstMonth);
    const end = endOfMonth(reference);
    const transactions = await this.prisma.transaction.findMany({
      where: { memberProfileId: { in: profileIds }, referenceMonth: { gte: start, lte: end } },
      orderBy: { referenceMonth: 'asc' },
    });

    let runningBalance = await this.getOpeningBalanceCents(profileIds, start);
    const points = [];
    for (let index = 0; index < 12; index += 1) {
      const month = addMonths(firstMonth, index);
      const key = monthKey(month);
      const monthTransactions = transactions.filter((transaction) => monthKey(transaction.referenceMonth) === key);
      runningBalance += accountBalanceCents(monthTransactions);
      points.push({ m: SHORT_MONTHS[month.getUTCMonth()], v: runningBalance });
    }
    return points;
  }

  private buildAlerts(invoices: DashboardInvoice[], recurring: DashboardRecurring[]) {
    const invoiceAlerts = invoices.map((invoice) => ({
      kind: 'warn' as const,
      icon: 'card' as const,
      title: `Fatura ${invoice.account.name}`,
      sub: invoice.dueDate ? `Vence em ${this.formatShortDate(invoice.dueDate)}` : 'Vencimento não definido',
      due: this.formatMoney(invoice.totalCents),
      cta: 'Pagar fatura',
    }));

    const recurringAlerts = recurring.slice(0, Math.max(0, 4 - invoiceAlerts.length)).map((template) => ({
      kind: 'info' as const,
      icon: 'repeat' as const,
      title: template.description,
      sub: `Recorrente no dia ${String(template.dayOfMonth).padStart(2, '0')}`,
      due: this.formatMoney(template.amountCents),
      cta: 'Conferir',
    }));

    return [...invoiceAlerts, ...recurringAlerts];
  }

  private mapTransaction(transaction: DashboardTransaction) {
    return {
      id: transaction.id,
      date: this.formatShortDate(transaction.applicationDate),
      description: transaction.description,
      account: transaction.account?.name ?? 'Sem conta',
      category: transaction.category?.name ?? 'Sem categoria',
      profile: transaction.memberProfile.displayName,
      type: transaction.type === 'income' ? 'income' : 'expense',
      value: normalizeAmountCents(transaction.amountCents),
      status: transaction.status,
    };
  }

  private summarizeCreditCardInstallments(transactions: DashboardTransaction[]) {
    const installments = transactions.filter(
      (transaction) =>
        transaction.type === 'expense' &&
        transaction.account?.type === 'credit_card' &&
        transaction.installmentNumber !== null &&
        transaction.installmentNumber !== undefined,
    );
    return {
      count: installments.length,
      amountCents: expenseCents(installments),
    };
  }

  private getImportPreviewRows(profileIds: string[]) {
    return this.prisma.importRow.findMany({
      where: {
        status: { in: [ImportRowStatus.new, ImportRowStatus.duplicate, ImportRowStatus.review] },
        importBatch: { memberProfileId: { in: profileIds }, status: 'preview' },
      },
      include: { importBatch: true },
      orderBy: [{ createdAt: 'desc' }],
      take: 12,
    });
  }

  private formatMonth(date: Date): string {
    return `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  private formatShortDate(date: Date): string {
    return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private formatMoney(cents: number): string {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  }
}
