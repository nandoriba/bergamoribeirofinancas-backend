import { addMonths, clampDayForMonth, startOfMonth } from './date-range';

export interface CreditCardInvoiceAccount {
  closingDay?: number | null;
  dueDay?: number | null;
}

export function resolveCreditCardReferenceMonth(account: CreditCardInvoiceAccount, applicationDate: Date): Date | null {
  if (!account.closingDay) return null;
  const monthStart = startOfMonth(applicationDate);
  return applicationDate.getUTCDate() <= account.closingDay ? monthStart : addMonths(monthStart, 1);
}

export function dateFromAccountDay(referenceMonth: Date, day?: number | null): Date | undefined {
  return day ? clampDayForMonth(referenceMonth, day) : undefined;
}
