import { TransactionType } from '@prisma/client';

export interface FinanceTransaction {
  date: Date;
  applicationDate?: Date;
  amountCents: number;
  type: TransactionType;
  status?: 'confirmed' | 'pending';
  isInvoicePayment?: boolean;
  isInvoiceAdjustment?: boolean;
  account?: { type?: string | null } | null;
}

export function normalizeAmountCents(value: number): number {
  return Math.abs(Math.round(value));
}

export function transactionImpactCents(transaction: FinanceTransaction): number {
  if (transaction.isInvoiceAdjustment) return 0;
  const amount = normalizeAmountCents(transaction.amountCents);
  if (transaction.type === 'income') return amount;
  if (transaction.type === 'expense') return -amount;
  return 0;
}

export function accountBalanceImpactCents(transaction: FinanceTransaction): number {
  if (transaction.isInvoiceAdjustment) return 0;
  const amount = normalizeAmountCents(transaction.amountCents);
  if (transaction.type === 'income') return amount;
  if (transaction.type === 'expense' && transaction.account?.type === 'credit_card') return amount;
  if (transaction.type === 'expense') return -amount;
  return 0;
}

export function incomeCents(transactions: FinanceTransaction[]): number {
  return transactions
    .filter((transaction) => !transaction.isInvoiceAdjustment && transaction.type === 'income')
    .reduce((total, transaction) => total + normalizeAmountCents(transaction.amountCents), 0);
}

export function expenseCents(transactions: FinanceTransaction[]): number {
  return transactions
    .filter((transaction) => !transaction.isInvoiceAdjustment && transaction.type === 'expense')
    .reduce((total, transaction) => total + normalizeAmountCents(transaction.amountCents), 0);
}

export function creditCardExpenseCents(transactions: FinanceTransaction[]): number {
  return transactions
    .filter(
      (transaction) =>
        !transaction.isInvoiceAdjustment &&
        transaction.type === 'expense' &&
        transaction.account?.type === 'credit_card',
    )
    .reduce((total, transaction) => total + normalizeAmountCents(transaction.amountCents), 0);
}

export function accountCreditCents(transactions: FinanceTransaction[]): number {
  return transactions
    .filter(
      (transaction) =>
        !transaction.isInvoiceAdjustment &&
        (transaction.type === 'income' ||
          (transaction.type === 'expense' && transaction.account?.type === 'credit_card')),
    )
    .reduce((total, transaction) => total + normalizeAmountCents(transaction.amountCents), 0);
}

export function accountDebitCents(transactions: FinanceTransaction[]): number {
  return transactions
    .filter(
      (transaction) =>
        !transaction.isInvoiceAdjustment &&
        transaction.type === 'expense' &&
        transaction.account?.type !== 'credit_card',
    )
    .reduce((total, transaction) => total + normalizeAmountCents(transaction.amountCents), 0);
}

export function netCents(transactions: FinanceTransaction[]): number {
  return transactions.reduce((total, transaction) => total + transactionImpactCents(transaction), 0);
}

export function accountBalanceCents(transactions: FinanceTransaction[]): number {
  return transactions.reduce((total, transaction) => total + accountBalanceImpactCents(transaction), 0);
}

export function closingBalanceCents(openingBalanceCents: number, transactions: FinanceTransaction[]): number {
  return openingBalanceCents + netCents(transactions);
}

export function cumulativeDailyBalances(
  openingBalanceCents: number,
  transactions: FinanceTransaction[],
  numberOfDays: number,
): number[] {
  const impactsByDay = new Array<number>(numberOfDays).fill(0);

  for (const transaction of transactions) {
    if (transaction.isInvoiceAdjustment) continue;
    const dayIndex = operationalDate(transaction).getUTCDate() - 1;
    if (dayIndex >= 0 && dayIndex < numberOfDays) {
      impactsByDay[dayIndex] += transactionImpactCents(transaction);
    }
  }

  const balances: number[] = [];
  let balance = openingBalanceCents;
  for (const impact of impactsByDay) {
    balance += impact;
    balances.push(balance);
  }

  return balances;
}

export function cumulativeAccountDailyBalances(
  openingBalanceCents: number,
  transactions: FinanceTransaction[],
  numberOfDays: number,
): number[] {
  const impactsByDay = new Array<number>(numberOfDays).fill(0);

  for (const transaction of transactions) {
    if (transaction.isInvoiceAdjustment) continue;
    const dayIndex = operationalDate(transaction).getUTCDate() - 1;
    if (dayIndex >= 0 && dayIndex < numberOfDays) {
      impactsByDay[dayIndex] += accountBalanceImpactCents(transaction);
    }
  }

  const balances: number[] = [];
  let balance = openingBalanceCents;
  for (const impact of impactsByDay) {
    balance += impact;
    balances.push(balance);
  }

  return balances;
}

export function dailyExpenseSeries(transactions: FinanceTransaction[], numberOfDays: number): number[] {
  const values = new Array<number>(numberOfDays).fill(0);
  for (const transaction of transactions) {
    if (transaction.isInvoiceAdjustment) continue;
    if (transaction.type !== 'expense') continue;
    const dayIndex = operationalDate(transaction).getUTCDate() - 1;
    if (dayIndex >= 0 && dayIndex < numberOfDays) {
      values[dayIndex] += normalizeAmountCents(transaction.amountCents);
    }
  }
  return values;
}

export function dailyCreditCardSeries(transactions: FinanceTransaction[], numberOfDays: number): number[] {
  const values = new Array<number>(numberOfDays).fill(0);
  for (const transaction of transactions) {
    if (transaction.isInvoiceAdjustment) continue;
    if (transaction.type !== 'expense' || transaction.account?.type !== 'credit_card') continue;
    const dayIndex = operationalDate(transaction).getUTCDate() - 1;
    if (dayIndex >= 0 && dayIndex < numberOfDays) {
      values[dayIndex] += normalizeAmountCents(transaction.amountCents);
    }
  }
  return values;
}

function operationalDate(transaction: FinanceTransaction): Date {
  return transaction.applicationDate ?? transaction.date;
}
