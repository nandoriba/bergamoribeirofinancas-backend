import { Injectable } from '@nestjs/common';
import { ImportRowStatus, Prisma } from '@prisma/client';
import type { ImportType, TransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import {
  addMonths,
  clampDayForMonth,
  daysInMonth,
  endOfDay,
  endOfMonth,
  monthKey,
  parseMonth,
  startOfMonth,
} from '../../shared/date-range';
import {
  accountBalanceCents,
  creditCardExpenseCents,
  cumulativeDailyBalances,
  dailyCreditCardSeries,
  dailyExpenseSeries,
  expenseCents,
  incomeCents,
  normalizeAmountCents,
} from '../../shared/finance-calculator';
import type { TenantContext } from '../../shared/tenant-context';
import { RecurringService } from '../recurring/recurring.service';

const SHORT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const CATEGORY_COLORS = ['#3d6cb0', '#5c89c4', '#7aa5d4', '#9abfe2', '#b8d3ec', '#3a4a66'];
const CREDIT_CARD_CATEGORY = { name: 'Cartão', color: '#d99090' };
const BALANCE_COMPOSITION_COLORS = {
  balance: '#64b88f',
  expense: '#7aa5d4',
  card: '#d99090',
};

const transactionInclude = {
  account: true,
  category: true,
  memberProfile: { select: { id: true, displayName: true } },
} satisfies Prisma.TransactionInclude;

const recurringAccountSelect = {
  id: true,
  name: true,
  type: true,
} satisfies Prisma.AccountSelect;

const recurringTemplateInclude = {
  category: true,
} satisfies Prisma.RecurringTemplateInclude;

type DashboardTransaction = Prisma.TransactionGetPayload<{ include: typeof transactionInclude }>;
type DashboardInvoice = Prisma.InvoiceGetPayload<{ include: { account: true } }>;
type DashboardRecurring = Prisma.RecurringTemplateGetPayload<{ include: typeof recurringTemplateInclude }> & {
  account: Prisma.AccountGetPayload<{ select: typeof recurringAccountSelect }> | null;
};
type DashboardInstallmentPlan = Prisma.InstallmentPlanGetPayload<Record<string, never>>;
type DashboardImportRow = Prisma.ImportRowGetPayload<{ include: { importBatch: true } }>;
type DashboardMetricTransaction = Pick<
  DashboardTransaction,
  | 'amountCents'
  | 'applicationDate'
  | 'category'
  | 'date'
  | 'description'
  | 'installmentNumber'
  | 'isInvoiceAdjustment'
  | 'isInvoicePayment'
  | 'status'
  | 'type'
> & {
  account: Pick<NonNullable<DashboardTransaction['account']>, 'name' | 'type'> | null;
};
export type ImportPreviewStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'review';

export interface ImportDuplicateCandidate {
  id?: string;
  description: string;
  applicationDate: string;
  amountCents: number;
  source: string;
  accountName?: string | null;
}

interface DashboardQuery {
  referenceMonth?: string;
  profileId?: string;
  family?: boolean;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringService: RecurringService,
    private readonly tenantScope: TenantScopeService,
  ) {}

  async getDashboard(context: TenantContext, query: DashboardQuery) {
    const reference = parseMonth(query.referenceMonth);
    const monthStart = startOfMonth(reference);
    const monthEnd = endOfMonth(reference);
    const profileIds = await this.tenantScope.resolveProfileIds(context, {
      family: query.family ?? true,
      profileId: query.profileId,
    });

    const [monthTransactions, previousMonthTransactions, importRows, installments, invoices, recurring] =
      await Promise.all([
        this.getTransactions(context, profileIds, monthStart, monthEnd),
        this.getTransactions(
          context,
          profileIds,
          startOfMonth(addMonths(reference, -1)),
          endOfMonth(addMonths(reference, -1)),
        ),
        this.getImportPreviewRows([context.authorProfileId]),
        this.prisma.installmentPlan.findMany({
          where: { memberProfileId: { in: profileIds } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.invoice.findMany({
          where: {
            memberProfileId: { in: profileIds },
            referenceMonth: monthStart,
            status: { in: ['open', 'closed'] },
            ...this.tenantScope.consistentInvoiceRelations(context),
          },
          include: { account: true },
          orderBy: [{ dueDate: 'asc' }],
          take: 4,
        }),
        this.getRecurringTemplates(context, profileIds, monthStart, monthEnd),
      ]);

    const projectedRecurringTransactions = this.buildProjectedRecurringTransactions(
      recurring,
      monthTransactions,
      monthStart,
    );
    const projectedMonthTransactions: DashboardMetricTransaction[] = [
      ...monthTransactions,
      ...projectedRecurringTransactions,
    ];

    const today = new Date();
    const todayEnd = endOfDay(today);
    const currentTransactions = monthTransactions.filter(
      (transaction) => transaction.status === 'confirmed' && transaction.applicationDate <= todayEnd,
    );
    const currentFinancialTransactions = currentTransactions.filter((transaction) => !transaction.isInvoiceAdjustment);
    const monthFinancialTransactions = projectedMonthTransactions.filter(
      (transaction) => !transaction.isInvoiceAdjustment,
    );
    const previousMonthFinancialTransactions = previousMonthTransactions.filter(
      (transaction) => !transaction.isInvoiceAdjustment,
    );
    const currentSpendingTransactions = currentFinancialTransactions.filter((transaction) => !isInvoicePaymentTransaction(transaction));
    const monthSpendingTransactions = monthFinancialTransactions.filter((transaction) => !isInvoicePaymentTransaction(transaction));
    const previousMonthSpendingTransactions = previousMonthFinancialTransactions.filter(
      (transaction) => !isInvoicePaymentTransaction(transaction),
    );
    const numberOfDays = daysInMonth(reference);
    const saldoDiarioAtual = cumulativeDailyBalances(0, currentSpendingTransactions, numberOfDays);
    const saldoDiarioProjetado = cumulativeDailyBalances(0, monthSpendingTransactions, numberOfDays);
    const despesaDiariaAtualSpark = dailyExpenseSeries(currentSpendingTransactions, numberOfDays);
    const despesaDiariaProjetadaSpark = dailyExpenseSeries(monthSpendingTransactions, numberOfDays);
    const cartaoDiariaAtualSpark = dailyCreditCardSeries(currentFinancialTransactions, numberOfDays);
    const cartaoDiariaProjetadaSpark = dailyCreditCardSeries(monthFinancialTransactions, numberOfDays);
    const despesaFuturo = expenseCents(monthSpendingTransactions);
    const categoryTotals = this.groupExpenseCategories(monthSpendingTransactions);
    const confirmedInstallments = this.summarizeCreditCardInstallments(currentFinancialTransactions);
    const projectedInstallments = this.summarizeCreditCardInstallments(monthFinancialTransactions);
    const saldoAtualTotal = incomeCents(currentFinancialTransactions);
    const saldoProjetadoTotal = incomeCents(monthFinancialTransactions);
    const despesaAtual = expenseCents(currentSpendingTransactions);
    const cartaoAtual = creditCardExpenseCents(currentFinancialTransactions);
    const cartaoFuturo = creditCardExpenseCents(monthFinancialTransactions);
    const saldoComposicaoConfirmada = buildBalanceComposition({
      title: 'Composição confirmada',
      totalLabel: 'CONFIRMADO',
      balanceLabel: 'Saldo total confirmado sem despesa',
      expenseLabel: 'Despesa confirmada',
      cardLabel: 'Cartão confirmado',
      balanceCents: saldoAtualTotal,
      expenseCents: Math.max(despesaAtual - cartaoAtual, 0),
      cardCents: cartaoAtual,
    });
    const saldoComposicaoProjetada = buildBalanceComposition({
      title: 'Composição projetada',
      totalLabel: 'PROJETADO',
      balanceLabel: 'Saldo projetado total',
      expenseLabel: 'Despesa projetada',
      cardLabel: 'Cartão projetado',
      balanceCents: saldoProjetadoTotal,
      expenseCents: Math.max(despesaFuturo - cartaoFuturo, 0),
      cardCents: cartaoFuturo,
    });
    const importPreview = await this.mapImportPreviewRows(importRows, context);

    return {
      monthRef: monthKey(reference),
      monthShort: this.formatMonth(reference),
      today: this.formatShortDate(today),
      saldoAtual: saldoAtualTotal - despesaAtual,
      saldoFuturo: saldoProjetadoTotal - despesaFuturo,
      saldoAtualTotal,
      saldoProjetadoTotal,
      saldoAnt: 0,
      saldoMaxMes: Math.max(0, ...saldoDiarioProjetado),
      despesaAtual,
      despesaFuturo,
      despesaAntMes: expenseCents(previousMonthSpendingTransactions),
      cartaoAtual,
      cartaoFuturo,
      cartaoAntMes: creditCardExpenseCents(previousMonthFinancialTransactions),
      receitaPrevista: incomeCents(monthFinancialTransactions),
      parcelasConfirmadasQuantidade: confirmedInstallments.count,
      parcelasConfirmadasValorCents: confirmedInstallments.amountCents,
      parcelasProjetadasQuantidade: projectedInstallments.count,
      parcelasProjetadasValorCents: projectedInstallments.amountCents,
      top5: categoryTotals.top5,
      outrosCat: categoryTotals.others,
      avisos: this.buildAlerts(invoices, recurring),
      parcelas: installments.filter(isOpenInstallmentPlan).map((plan) => ({
        id: plan.id,
        name: plan.description,
        pago: plan.paidInstallments,
        total: plan.totalInstallments,
        mensal: plan.monthlyAmountCents,
        restante: Math.max(plan.totalInstallments - plan.paidInstallments, 0) * plan.monthlyAmountCents,
      })),
      saldoMensal: await this.buildMonthlyBalances(
        profileIds,
        reference,
        context,
        projectedRecurringTransactions,
      ),
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
      saldoComposicaoConfirmada,
      saldoComposicaoProjetada,
      transactions: monthTransactions.slice(0, 12).map((transaction) => this.mapTransaction(transaction)),
      importPreview,
    };
  }

  private getTransactions(context: TenantContext, profileIds: string[], start: Date, end: Date) {
    return this.prisma.transaction.findMany({
      where: {
        memberProfileId: { in: profileIds },
        referenceMonth: { gte: start, lte: end },
        ...this.tenantScope.consistentTransactionRelations(context),
      },
      include: transactionInclude,
      orderBy: [{ referenceMonth: 'desc' }, { applicationDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async getRecurringTemplates(
    context: TenantContext,
    profileIds: string[],
    monthStart: Date,
    monthEnd: Date,
  ) {
    const accounts = await this.prisma.account.findMany({
      where: { memberProfileId: { in: profileIds } },
      select: recurringAccountSelect,
    });

    const templates = await this.prisma.recurringTemplate.findMany({
      where: {
        memberProfileId: { in: profileIds },
        deletedAt: null,
        status: 'active',
        startsAt: { lte: monthEnd },
        OR: [{ endsAt: null }, { endsAt: { gte: monthStart } }],
        ...this.tenantScope.consistentRecurringRelations(
          context,
          accounts.map((account) => account.id),
        ),
      },
      include: recurringTemplateInclude,
      orderBy: [{ dayOfMonth: 'asc' }],
    });

    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    return templates.flatMap((template) => {
      const applicationDate = clampDayForMonth(monthStart, template.dayOfMonth);
      if (!isRecurringOccurrenceWithinPeriod(applicationDate, template.startsAt, template.endsAt)) return [];
      return [
        {
          ...template,
          account: template.accountId ? (accountsById.get(template.accountId) ?? null) : null,
        },
      ];
    });
  }

  private buildProjectedRecurringTransactions(
    templates: DashboardRecurring[],
    persistedTransactions: DashboardTransaction[],
    monthStart: Date,
  ): DashboardMetricTransaction[] {
    const materializedTemplateIds = new Set(
      persistedTransactions.flatMap((transaction) =>
        transaction.recurringTemplateId ? [transaction.recurringTemplateId] : [],
      ),
    );
    const materializedExternalIds = new Set(
      persistedTransactions.flatMap((transaction) => (transaction.externalId ? [transaction.externalId] : [])),
    );
    const monthKey = monthStart.toISOString().slice(0, 7);

    return templates.flatMap((template) => {
      const externalId = `recurring:${template.id}:${monthKey}`;
      if (materializedTemplateIds.has(template.id) || materializedExternalIds.has(externalId)) return [];

      const applicationDate = clampDayForMonth(monthStart, template.dayOfMonth);
      if (!isRecurringOccurrenceWithinPeriod(applicationDate, template.startsAt, template.endsAt)) return [];
      return [
        {
          account: template.account,
          amountCents: template.amountCents,
          applicationDate,
          category: template.category,
          date: applicationDate,
          description: template.description,
          installmentNumber: null,
          isInvoiceAdjustment: false,
          isInvoicePayment: false,
          status: 'pending' as const,
          type: template.type,
        },
      ];
    });
  }

  private async getOpeningBalanceCents(
    profileIds: string[],
    monthStart: Date,
    context?: TenantContext,
  ): Promise<number> {
    const [accounts, priorTransactions] = await Promise.all([
      this.prisma.account.findMany({
        where: { memberProfileId: { in: profileIds } },
        select: { memberProfileId: true, initialBalanceCents: true },
      }),
      this.prisma.transaction.findMany({
        where: {
          memberProfileId: { in: profileIds },
          referenceMonth: { lt: monthStart },
          status: 'confirmed',
          ...(context ? this.tenantScope.consistentTransactionRelations(context) : {}),
        },
        include: { account: true },
      }),
    ]);

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
      const opening = (initialByProfile.get(profileId) ?? 0) + (priorNetByProfile.get(profileId) ?? 0);
      return total + opening;
    }, 0);
  }

  private groupExpenseCategories(transactions: DashboardMetricTransaction[]) {
    const totals = new Map<string, { name: string; value: number; color: string }>();

    for (const transaction of transactions) {
      if (transaction.isInvoiceAdjustment || transaction.type !== 'expense' || isInvoicePaymentTransaction(transaction)) continue;
      const category = expenseCategoryForDashboard(transaction);
      const name = category.name;
      const current = totals.get(name) ?? {
        name,
        value: 0,
        color: category.color ?? CATEGORY_COLORS[totals.size % CATEGORY_COLORS.length],
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

  private async buildMonthlyBalances(
    profileIds: string[],
    reference: Date,
    context?: TenantContext,
    projectedReferenceTransactions: DashboardMetricTransaction[] = [],
  ) {
    const firstMonth = addMonths(reference, -11);
    const start = startOfMonth(firstMonth);
    const end = endOfMonth(reference);
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: { in: profileIds },
        referenceMonth: { gte: start, lte: end },
        ...(context ? this.tenantScope.consistentTransactionRelations(context) : {}),
      },
      include: { account: true },
      orderBy: { referenceMonth: 'asc' },
    });

    let runningBalance = await this.getOpeningBalanceCents(profileIds, start, context);
    const points = [];
    for (let index = 0; index < 12; index += 1) {
      const month = addMonths(firstMonth, index);
      const key = monthKey(month);
      const monthTransactions = transactions.filter((transaction) => monthKey(transaction.referenceMonth) === key);
      const projectedTransactions = key === monthKey(reference) ? projectedReferenceTransactions : [];
      runningBalance += accountBalanceCents([...monthTransactions, ...projectedTransactions]);
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

  private summarizeCreditCardInstallments(transactions: DashboardMetricTransaction[]) {
    const installments = transactions.filter(
      (transaction) =>
        transaction.type === 'expense' &&
        !transaction.isInvoiceAdjustment &&
        transaction.account?.type === 'credit_card' &&
        transaction.installmentNumber !== null &&
        transaction.installmentNumber !== undefined,
    );
    return {
      count: installments.length,
      amountCents: expenseCents(installments),
    };
  }

  private async getImportPreviewRows(profileIds: string[]) {
    const latestBatch = await this.prisma.importBatch.findFirst({
      where: { memberProfileId: { in: profileIds }, status: 'preview' },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!latestBatch) return [];

    return this.prisma.importRow.findMany({
      where: {
        status: { in: [ImportRowStatus.new, ImportRowStatus.duplicate, ImportRowStatus.review] },
        importBatchId: latestBatch.id,
      },
      include: { importBatch: true },
      orderBy: [{ rowIndex: 'asc' }, { id: 'asc' }],
    });
  }

  private async mapImportPreviewRows(rows: DashboardImportRow[], context?: TenantContext) {
    return Promise.all(
      rows.map(async (row) => {
        const invoiceAdjustmentCandidate = isInvoiceAdjustmentPreviewCandidate(row.importBatch.type, row);
        const invoiceAdjustmentDefault = invoiceAdjustmentCandidate && isInvoiceAdjustmentDefault(row);
        const legacyReviewAdjustment =
          row.status === ImportRowStatus.review &&
          invoiceAdjustmentCandidate &&
          Boolean(row.date) &&
          row.amountCents !== null;

        return {
          id: row.id,
          batchId: row.importBatch.id,
          date: row.date ? this.formatShortDate(row.date) : '-',
          description: row.description ?? 'Linha sem descrição',
          applicationDate: row.date ? toDateKey(row.date) : null,
          source: row.importBatch.type,
          suggestedCategory: row.suggestedCategory ?? 'Revisar',
          value: row.amountCents ?? 0,
          status: legacyReviewAdjustment ? 'new' : mapImportPreviewStatus(row.status, row.falseDuplicate),
          reviewReason: legacyReviewAdjustment ? null : resolveImportReviewReason(row.status),
          duplicateCandidates: await this.resolveImportDuplicateCandidates(row, context),
          invoiceAdjustmentCandidate,
          invoiceAdjustmentDefault,
        };
      }),
    );
  }

  private async resolveImportDuplicateCandidates(
    row: DashboardImportRow,
    context?: TenantContext,
  ): Promise<ImportDuplicateCandidate[]> {
    if (row.status !== ImportRowStatus.duplicate || !row.date || row.amountCents === null) {
      return [];
    }

    const signedAmountCents = duplicateAmountForImportRow(row.importBatch.type, row.amountCents);
    const persisted = readImportDuplicateCandidates(row.duplicateCandidates).filter(
      (candidate) =>
        candidate.applicationDate === toDateKey(row.date as Date) && Math.round(candidate.amountCents) === signedAmountCents,
    );
    if (persisted.length > 0) return persisted;

    const description = normalizeText(row.description ?? '');
    const shouldIncludeCandidate = (candidateDescription: string) =>
      !row.falseDuplicate || normalizeText(candidateDescription) !== description;
    const [transactions, batchRows] = await Promise.all([
      this.prisma.transaction.findMany({
        where: {
          memberProfileId: row.importBatch.memberProfileId,
          applicationDate: row.date,
          amountCents: normalizeAmountCents(signedAmountCents),
          type: signedAmountCents >= 0 ? 'income' : 'expense',
          ...(context ? this.tenantScope.consistentTransactionRelations(context) : {}),
        },
        select: {
          id: true,
          description: true,
          applicationDate: true,
          amountCents: true,
          type: true,
          account: { select: { name: true } },
        },
      }),
      this.prisma.importRow.findMany({
        where: {
          importBatchId: row.importBatchId,
          date: row.date,
          id: { not: row.id },
        },
        select: {
          id: true,
          description: true,
          date: true,
          amountCents: true,
        },
      }),
    ]);

    const transactionCandidates = transactions
      .filter((transaction) => shouldIncludeCandidate(transaction.description))
      .map((transaction) => ({
        id: transaction.id,
        description: cleanRepeatedSeparators(transaction.description),
        applicationDate: toDateKey(transaction.applicationDate),
        amountCents: signedTransactionAmountCents(transaction),
        source: 'Sistema',
        accountName: transaction.account?.name,
      }));

    const previewCandidates = batchRows
      .filter(
        (candidate) =>
          candidate.date &&
          candidate.description &&
          candidate.amountCents !== null &&
          duplicateAmountForImportRow(row.importBatch.type, candidate.amountCents) === signedAmountCents &&
          shouldIncludeCandidate(candidate.description),
      )
      .map((candidate) => ({
        id: candidate.id,
        description: cleanRepeatedSeparators(candidate.description as string),
        applicationDate: toDateKey(candidate.date as Date),
        amountCents: duplicateAmountForImportRow(row.importBatch.type, candidate.amountCents as number),
        source: 'Prévia atual',
      }));

    return [...transactionCandidates, ...previewCandidates];
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

function isOpenInstallmentPlan(plan: Pick<DashboardInstallmentPlan, 'paidInstallments' | 'totalInstallments'>): boolean {
  return plan.paidInstallments < plan.totalInstallments;
}

function mapImportPreviewStatus(status: ImportRowStatus, falseDuplicate: boolean): ImportPreviewStatus {
  if (status === ImportRowStatus.duplicate && falseDuplicate) return 'possible_duplicate';
  if (status === ImportRowStatus.duplicate) return 'duplicate';
  if (status === ImportRowStatus.review) return 'review';
  return 'new';
}

function readImportDuplicateCandidates(value: Prisma.JsonValue | null): ImportDuplicateCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const parsed = parseImportDuplicateCandidate(candidate);
    return parsed ? [parsed] : [];
  });
}

function parseImportDuplicateCandidate(value: Prisma.JsonValue): ImportDuplicateCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.description !== 'string' ||
    typeof candidate.applicationDate !== 'string' ||
    typeof candidate.amountCents !== 'number' ||
    typeof candidate.source !== 'string'
  ) {
    return null;
  }

  return {
    id: typeof candidate.id === 'string' ? candidate.id : undefined,
    description: cleanRepeatedSeparators(candidate.description),
    applicationDate: candidate.applicationDate,
    amountCents: candidate.amountCents,
    source: candidate.source,
    accountName: typeof candidate.accountName === 'string' ? candidate.accountName : undefined,
  };
}

function cleanRepeatedSeparators(description: string) {
  return description.replace(/\s*[-–—]+\s*[-–—]+\s*Parcela/gi, ' - Parcela').trim();
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isRecurringOccurrenceWithinPeriod(applicationDate: Date, startsAt: Date, endsAt?: Date | null) {
  const occurrence = toDateKey(applicationDate);
  if (occurrence < toDateKey(startsAt)) return false;
  return !endsAt || occurrence <= toDateKey(endsAt);
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveImportReviewReason(status: ImportRowStatus): string | null {
  if (status !== ImportRowStatus.review) return null;
  return 'Linha sem dados suficientes para importação automática.';
}

function isCreditCardPaymentReceived(description?: string | null): boolean {
  const text = normalizeText(description ?? '');
  return text.includes('pagamento recebido');
}

function isCreditCardInvoiceAdjustmentCandidate(description?: string | null): boolean {
  const text = normalizeText(description ?? '');
  return (
    isCreditCardPaymentReceived(description) ||
    ['estorno', 'credito', 'reembolso'].some((token) => text.includes(token))
  );
}

function isInvoiceAdjustmentPreviewCandidate(
  source: string,
  row: { raw?: Prisma.JsonValue; description: string | null },
): boolean {
  if (source !== 'nubank_credit_card') return false;
  return readRawBoolean(row.raw, 'invoiceAdjustmentCandidate') ?? isCreditCardInvoiceAdjustmentCandidate(row.description);
}

function isInvoiceAdjustmentDefault(row: { raw?: Prisma.JsonValue; description: string | null }): boolean {
  return readRawBoolean(row.raw, 'invoiceAdjustmentDefault') ?? isCreditCardPaymentReceived(row.description);
}

function readRawBoolean(raw: Prisma.JsonValue | undefined, key: string): boolean | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !(key in raw)) return null;
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return null;
}

function isInvoicePaymentTransaction(
  transaction: Pick<DashboardMetricTransaction, 'type' | 'description' | 'isInvoicePayment' | 'account' | 'category'>,
): boolean {
  if (transaction.isInvoicePayment) return true;
  if (transaction.type !== 'expense' || transaction.account?.type === 'credit_card') return false;

  const description = normalizeText(transaction.description);
  const category = normalizeText(transaction.category?.name ?? '');
  return category === 'cartao' && description.includes('pagamento') && description.includes('fatura');
}

function expenseCategoryForDashboard(
  transaction: Pick<DashboardMetricTransaction, 'account' | 'category'>,
): { name: string; color?: string | null } {
  if (transaction.account?.type === 'credit_card') return CREDIT_CARD_CATEGORY;
  return {
    name: transaction.category?.name ?? 'Sem categoria',
    color: transaction.category?.color,
  };
}

function buildBalanceComposition(input: {
  title: string;
  totalLabel: string;
  balanceLabel: string;
  expenseLabel: string;
  cardLabel: string;
  balanceCents: number;
  expenseCents: number;
  cardCents: number;
}) {
  const slices = [
    { name: input.balanceLabel, value: normalizeAmountCents(input.balanceCents), color: BALANCE_COMPOSITION_COLORS.balance },
    { name: input.expenseLabel, value: normalizeAmountCents(input.expenseCents), color: BALANCE_COMPOSITION_COLORS.expense },
    { name: input.cardLabel, value: normalizeAmountCents(input.cardCents), color: BALANCE_COMPOSITION_COLORS.card },
  ];
  const totalValue = slices.reduce((total, slice) => total + slice.value, 0);

  return {
    title: input.title,
    totalLabel: input.totalLabel,
    totalValue,
    slices: slices.map((slice) => ({
      ...slice,
      pct: totalValue > 0 ? slice.value / totalValue : 0,
    })),
  };
}

function duplicateAmountForImportRow(importType: ImportType, amountCents: number): number {
  const signedAmountCents = Math.round(amountCents);
  if (importType === 'nubank_credit_card') return -normalizeAmountCents(signedAmountCents);
  return signedAmountCents;
}

function signedTransactionAmountCents(transaction: { amountCents: number; type: TransactionType }): number {
  const amountCents = normalizeAmountCents(transaction.amountCents);
  return transaction.type === 'income' ? amountCents : -amountCents;
}
