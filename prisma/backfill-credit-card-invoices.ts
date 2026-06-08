import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const memberProfileId = requiredEnv('BACKFILL_PROFILE_ID');
  const accountId = requiredEnv('BACKFILL_ACCOUNT_ID');
  const apply = process.env.BACKFILL_APPLY === 'true';
  const fromMonth = parseMonth(process.env.BACKFILL_FROM_MONTH);
  const toMonth = parseMonth(process.env.BACKFILL_TO_MONTH);

  const account = await prisma.account.findFirst({
    where: { id: accountId, memberProfileId, type: 'credit_card' },
  });
  if (!account) {
    throw new Error('BACKFILL_ACCOUNT_ID must be a credit card account from BACKFILL_PROFILE_ID');
  }

  const where: Prisma.TransactionWhereInput = {
    memberProfileId,
    source: 'nubank_credit_card',
    accountId: null,
    invoiceId: null,
  };

  if (fromMonth || toMonth) {
    where.referenceMonth = {
      gte: fromMonth,
      lte: toMonth,
    };
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: [{ referenceMonth: 'asc' }, { date: 'asc' }, { createdAt: 'asc' }],
  });

  const purchases = transactions.filter((transaction) => !isCreditCardAdjustment(transaction.description));
  const skipped = transactions.filter((transaction) => isCreditCardAdjustment(transaction.description));
  const summary = summarize(transactions, skipped);

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', accountId, memberProfileId, summary }, null, 2));

  if (!apply) {
    console.log('Dry-run only. Set BACKFILL_APPLY=true to update transactions and create/reuse invoices.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const transaction of purchases) {
      const invoice = await tx.invoice.upsert({
        where: {
          accountId_referenceMonth: {
            accountId: account.id,
            referenceMonth: transaction.referenceMonth,
          },
        },
        update: {},
        create: {
          accountId: account.id,
          memberProfileId,
          referenceMonth: transaction.referenceMonth,
          status: 'open',
          closingDate: account.closingDay ? dateWithDay(transaction.referenceMonth, account.closingDay) : undefined,
          dueDate: account.dueDay ? dateWithDay(transaction.referenceMonth, account.dueDay) : undefined,
        },
      });

      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          accountId: account.id,
          invoiceId: invoice.id,
          type: 'expense',
          amountCents: Math.abs(transaction.amountCents),
        },
      });
    }
  });

  console.log(`Updated ${purchases.length} transactions. Skipped ${skipped.length} adjustment-like transactions.`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseMonth(value?: string): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${value} must use YYYY-MM format`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

function summarize(
  transactions: Awaited<ReturnType<PrismaClient['transaction']['findMany']>>,
  skipped: Awaited<ReturnType<PrismaClient['transaction']['findMany']>>,
) {
  const skippedIds = new Set(skipped.map((transaction) => transaction.id));
  const byMonth = new Map<string, { total: number; purchases: number; skipped: number; amountCents: number }>();

  for (const transaction of transactions) {
    const key = monthKey(transaction.referenceMonth);
    const current = byMonth.get(key) ?? { total: 0, purchases: 0, skipped: 0, amountCents: 0 };
    current.total += 1;
    if (skippedIds.has(transaction.id)) {
      current.skipped += 1;
    } else {
      current.purchases += 1;
      current.amountCents += Math.abs(transaction.amountCents);
    }
    byMonth.set(key, current);
  }

  return [...byMonth.entries()].map(([month, values]) => ({ month, ...values }));
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dateWithDay(referenceMonth: Date, day: number): Date {
  const daysInMonth = new Date(
    Date.UTC(referenceMonth.getUTCFullYear(), referenceMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const safeDay = Math.min(Math.max(day, 1), daysInMonth);
  return new Date(Date.UTC(referenceMonth.getUTCFullYear(), referenceMonth.getUTCMonth(), safeDay));
}

function isCreditCardAdjustment(description?: string | null): boolean {
  const text = (description ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return ['pagamento', 'estorno', 'credito', 'reembolso'].some((token) => text.includes(token));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
