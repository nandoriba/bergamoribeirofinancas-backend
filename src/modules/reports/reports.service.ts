import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { addMonths, endOfMonth, monthKey, startOfMonth } from '../../shared/date-range';
import { expenseCents, incomeCents, netCents, normalizeAmountCents } from '../../shared/finance-calculator';
import type { TenantContext } from '../../shared/tenant-context';

const MAX_REPORT_MONTHS = 24;

interface MonthlyReportQuery {
  month?: string;
  from?: string;
  to?: string;
  profileId?: string;
  family?: boolean;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService,
  ) {}

  async monthly(context: TenantContext, query: MonthlyReportQuery) {
    if (query.month && (query.from || query.to)) {
      throw new BadRequestException('Use month ou o intervalo from/to, não ambos');
    }

    const profileIds = await this.tenantScope.resolveProfileIds(context, {
      family: query.family ?? true,
      profileId: query.profileId,
    });

    if (query.from || query.to) {
      const from = parseReportMonth(query.from ?? query.to);
      const to = parseReportMonth(query.to ?? query.from);
      assertValidRange(from, to);
      const months = [];
      for (let cursor = from; cursor <= to; cursor = addMonths(cursor, 1)) {
        months.push(await this.buildMonthlyReport(context, cursor, profileIds));
      }
      return {
        from: monthKey(from),
        to: monthKey(to),
        months,
      };
    }

    const reference = query.month ? parseReportMonth(query.month) : startOfMonth(new Date());
    return this.buildMonthlyReport(context, reference, profileIds);
  }

  private async buildMonthlyReport(context: TenantContext, reference: Date, profileIds: string[]) {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: { in: profileIds },
        referenceMonth: { gte: startOfMonth(reference), lte: endOfMonth(reference) },
        ...this.tenantScope.consistentTransactionRelations(context),
      },
      include: {
        account: true,
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
      orderBy: [{ referenceMonth: 'asc' }, { applicationDate: 'asc' }],
    });
    const financialTransactions = transactions.filter((transaction) => !transaction.isInvoiceAdjustment);

    const profiles = new Map<string, { id: string; name: string; incomeCents: number; expenseCents: number; netCents: number }>();
    const categories = new Map<string, { name: string; type: string; valueCents: number; color: string }>();
    const accounts = new Map<string, { name: string; type: string; valueCents: number }>();

    for (const transaction of financialTransactions) {
      const profile = profiles.get(transaction.memberProfile.id) ?? {
        id: transaction.memberProfile.id,
        name: transaction.memberProfile.displayName,
        incomeCents: 0,
        expenseCents: 0,
        netCents: 0,
      };
      if (transaction.type === 'income') profile.incomeCents += normalizeAmountCents(transaction.amountCents);
      if (transaction.type === 'expense') profile.expenseCents += normalizeAmountCents(transaction.amountCents);
      profile.netCents += netCents([transaction]);
      profiles.set(transaction.memberProfile.id, profile);

      const categoryName = transaction.category?.name ?? 'Sem categoria';
      const categoryKey = `${transaction.type}:${categoryName}`;
      const category = categories.get(categoryKey) ?? {
        name: categoryName,
        type: transaction.type,
        valueCents: 0,
        color: transaction.category?.color ?? '#7aa5d4',
      };
      category.valueCents += normalizeAmountCents(transaction.amountCents);
      categories.set(categoryKey, category);

      const accountName = transaction.account?.name ?? 'Sem conta';
      const account = accounts.get(accountName) ?? {
        name: accountName,
        type: transaction.account?.type ?? 'none',
        valueCents: 0,
      };
      account.valueCents += netCents([transaction]);
      accounts.set(accountName, account);
    }

    return {
      month: monthKey(reference),
      totals: {
        incomeCents: incomeCents(financialTransactions),
        expenseCents: expenseCents(financialTransactions),
        netCents: netCents(financialTransactions),
      },
      profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
      categories: [...categories.values()].sort((a, b) => b.valueCents - a.valueCents),
      accounts: [...accounts.values()].sort((a, b) => Math.abs(b.valueCents) - Math.abs(a.valueCents)),
    };
  }

}

function parseReportMonth(value?: string): Date {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? '');
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);

  if (!match || year < 1000) {
    throw new BadRequestException('Mês inválido; use o formato YYYY-MM');
  }

  return new Date(Date.UTC(year, month - 1, 1));
}

function assertValidRange(from: Date, to: Date) {
  const monthCount = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + 1;

  if (monthCount < 1) {
    throw new BadRequestException('O início do intervalo deve ser anterior ou igual ao fim');
  }

  if (monthCount > MAX_REPORT_MONTHS) {
    throw new BadRequestException(`O intervalo máximo é de ${MAX_REPORT_MONTHS} meses`);
  }
}
