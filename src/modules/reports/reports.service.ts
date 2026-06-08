import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { endOfMonth, monthKey, parseMonth, startOfMonth } from '../../shared/date-range';
import { expenseCents, incomeCents, netCents, normalizeAmountCents } from '../../shared/finance-calculator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async monthly(user: AuthenticatedUser, query: { month?: string; family: boolean }) {
    const reference = parseMonth(query.month);
    const profileIds = await this.getProfileIds(user, query.family);
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: { in: profileIds },
        date: { gte: startOfMonth(reference), lte: endOfMonth(reference) },
      },
      include: {
        account: true,
        category: true,
        memberProfile: { select: { id: true, displayName: true } },
      },
      orderBy: [{ date: 'asc' }],
    });

    const profiles = new Map<string, { id: string; name: string; incomeCents: number; expenseCents: number; netCents: number }>();
    const categories = new Map<string, { name: string; type: string; valueCents: number; color: string }>();
    const accounts = new Map<string, { name: string; type: string; valueCents: number }>();

    for (const transaction of transactions) {
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
        incomeCents: incomeCents(transactions),
        expenseCents: expenseCents(transactions),
        netCents: netCents(transactions),
      },
      profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
      categories: [...categories.values()].sort((a, b) => b.valueCents - a.valueCents),
      accounts: [...accounts.values()].sort((a, b) => Math.abs(b.valueCents) - Math.abs(a.valueCents)),
    };
  }

  private async getProfileIds(user: AuthenticatedUser, family: boolean) {
    if (!family) return [user.profileId];
    const profiles = await this.prisma.memberProfile.findMany({
      where: { familyId: user.familyId, status: 'active' },
      select: { id: true },
    });
    return profiles.map((profile) => profile.id);
  }
}
