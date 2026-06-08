import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { parseMonth, startOfMonth } from '../../shared/date-range';
import { netCents } from '../../shared/finance-calculator';

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 0 1 * *')
  async generateCurrentMonthOpenings() {
    const families = await this.prisma.family.findMany({ select: { id: true } });
    for (const family of families) {
      await this.generateMonthlyOpenings(family.id);
    }
  }

  async generateMonthlyOpenings(familyId: string, month?: string) {
    const reference = startOfMonth(parseMonth(month));
    const profiles = await this.prisma.memberProfile.findMany({
      where: { familyId, status: 'active' },
      include: {
        accounts: { select: { initialBalanceCents: true } },
        transactions: {
          where: { date: { lt: reference }, status: 'confirmed' },
          select: { amountCents: true, type: true, date: true },
        },
      },
      orderBy: { displayName: 'asc' },
    });

    const results = [];
    for (const profile of profiles) {
      const initialBalanceCents = profile.accounts.reduce((total, account) => total + account.initialBalanceCents, 0);
      const balanceCents = initialBalanceCents + netCents(profile.transactions);
      const opening = await this.prisma.monthlyOpening.upsert({
        where: {
          memberProfileId_referenceMonth: {
            memberProfileId: profile.id,
            referenceMonth: reference,
          },
        },
        update: { balanceCents },
        create: {
          memberProfileId: profile.id,
          referenceMonth: reference,
          balanceCents,
        },
      });
      results.push({
        profileId: profile.id,
        displayName: profile.displayName,
        balanceCents: opening.balanceCents,
      });
    }

    return {
      month: reference.toISOString().slice(0, 7),
      generated: results.length,
      openings: results,
    };
  }
}
