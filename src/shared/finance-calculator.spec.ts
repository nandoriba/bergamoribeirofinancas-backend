import { describe, expect, it } from 'vitest';

import {
  accountBalanceCents,
  accountCreditCents,
  cumulativeAccountDailyBalances,
  closingBalanceCents,
  creditCardExpenseCents,
  cumulativeDailyBalances,
  dailyExpenseSeries,
  expenseCents,
  incomeCents,
  netCents,
  transactionImpactCents,
  type FinanceTransaction,
} from './finance-calculator';

describe('finance-calculator', () => {
  const transactions: FinanceTransaction[] = [
    { date: new Date('2026-06-01T00:00:00.000Z'), type: 'income', amountCents: 500_00 },
    { date: new Date('2026-06-02T00:00:00.000Z'), type: 'expense', amountCents: 120_00 },
    {
      date: new Date('2026-06-02T00:00:00.000Z'),
      type: 'expense',
      amountCents: 80_00,
      account: { type: 'credit_card' },
    },
    { date: new Date('2026-06-03T00:00:00.000Z'), type: 'transfer', amountCents: 300_00 },
  ];

  it('uses income as positive, expense as negative and transfer as neutral', () => {
    expect(transactionImpactCents(transactions[0])).toBe(500_00);
    expect(transactionImpactCents(transactions[1])).toBe(-120_00);
    expect(transactionImpactCents(transactions[3])).toBe(0);
  });

  it('summarizes income, expense and net in cents', () => {
    expect(incomeCents(transactions)).toBe(500_00);
    expect(expenseCents(transactions)).toBe(200_00);
    expect(netCents(transactions)).toBe(300_00);
    expect(closingBalanceCents(1_000_00, transactions)).toBe(1_300_00);
  });

  it('keeps credit card expenses separated from cash expenses', () => {
    expect(creditCardExpenseCents(transactions)).toBe(80_00);
  });

  it('counts credit card expenses as positive credit in account balance cards', () => {
    expect(accountCreditCents(transactions)).toBe(580_00);
    expect(accountBalanceCents(transactions)).toBe(460_00);
    expect(cumulativeAccountDailyBalances(1_000_00, transactions, 3)).toEqual([1_500_00, 1_460_00, 1_460_00]);
  });

  it('builds cumulative balances by UTC day', () => {
    expect(cumulativeDailyBalances(1_000_00, transactions, 3)).toEqual([1_500_00, 1_300_00, 1_300_00]);
  });

  it('uses application date for daily operational series', () => {
    const futureBookkeeping: FinanceTransaction[] = [
      {
        date: new Date('2026-07-20T00:00:00.000Z'),
        applicationDate: new Date('2026-06-05T00:00:00.000Z'),
        type: 'expense',
        amountCents: 75_00,
      },
    ];

    expect(dailyExpenseSeries(futureBookkeeping, 30)[4]).toBe(75_00);
  });

  it('ignores invoice-only adjustments in operational financial totals', () => {
    const invoiceAdjustment: FinanceTransaction = {
      date: new Date('2026-06-03T00:00:00.000Z'),
      applicationDate: new Date('2026-06-03T00:00:00.000Z'),
      type: 'expense',
      amountCents: 4_341_62,
      isInvoiceAdjustment: true,
      account: { type: 'credit_card' },
    };
    const withAdjustment = [...transactions, invoiceAdjustment];

    expect(incomeCents(withAdjustment)).toBe(incomeCents(transactions));
    expect(expenseCents(withAdjustment)).toBe(expenseCents(transactions));
    expect(creditCardExpenseCents(withAdjustment)).toBe(creditCardExpenseCents(transactions));
    expect(netCents(withAdjustment)).toBe(netCents(transactions));
    expect(accountBalanceCents(withAdjustment)).toBe(accountBalanceCents(transactions));
    expect(dailyExpenseSeries(withAdjustment, 30)[2]).toBe(0);
  });
});
