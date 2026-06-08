import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { InstallmentsService } from './installments.service';

describe('InstallmentsService', () => {
  const user: AuthenticatedUser = {
    id: 'user-1',
    email: 'fernando@example.com',
    role: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('materializes installment application dates from the selected reference months', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const transactionCreates: unknown[] = [];
    const tx = {
      installmentPlan: {
        create: vi.fn().mockResolvedValue({ id: 'plan-1' }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'plan-1',
          totalInstallments: 3,
          paidInstallments: 2,
          monthlyAmountCents: 100_00,
          transactions: [],
        }),
      },
      transaction: {
        create: vi.fn(async (args) => {
          transactionCreates.push(args.data);
          return args.data;
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      transaction: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new InstallmentsService(prisma as never);

    await service.create(user, {
      description: 'Farmamed',
      totalInstallments: 3,
      firstInstallmentNumber: 2,
      monthlyAmountCents: 100_00,
      totalAmountCents: 300_00,
      startsAt: '2026-06-08T12:00:00.000Z',
      firstApplicationDate: '2026-06-05',
      firstReferenceMonth: '2026-06-01',
    });

    expect(transactionCreates).toEqual([
      expect.objectContaining({
        referenceMonth: new Date('2026-05-01T00:00:00.000Z'),
        applicationDate: new Date('2026-05-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
      expect.objectContaining({
        referenceMonth: new Date('2026-06-01T00:00:00.000Z'),
        applicationDate: new Date('2026-06-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
      expect.objectContaining({
        referenceMonth: new Date('2026-07-01T00:00:00.000Z'),
        applicationDate: new Date('2026-07-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
    ]);
  });
});
