import { describe, expect, it } from 'vitest';

import {
  closingBalanceCents,
  creditCardExpenseCents,
  cumulativeDailyBalances,
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

  it('builds cumulative balances by UTC day', () => {
    expect(cumulativeDailyBalances(1_000_00, transactions, 3)).toEqual([1_500_00, 1_300_00, 1_300_00]);
  });
});
