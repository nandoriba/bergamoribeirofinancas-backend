export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function endOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

export function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

export function parseMonth(month?: string): Date {
  if (!month) {
    return startOfMonth(new Date());
  }

  const [year, monthIndex] = month.split('-').map(Number);
  if (!year || !monthIndex || monthIndex < 1 || monthIndex > 12) {
    return startOfMonth(new Date());
  }

  return new Date(Date.UTC(year, monthIndex - 1, 1));
}

export function addMonths(date: Date, amount: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
}

export function isSameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export function clampDayForMonth(date: Date, day: number): Date {
  const safeDay = Math.min(Math.max(day, 1), daysInMonth(date));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), safeDay));
}
