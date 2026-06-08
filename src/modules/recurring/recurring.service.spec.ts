import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecurringService } from './recurring.service';

describe('RecurringService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('materializes application date from day of month in the selected reference month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const upsert = vi.fn(async (args) => args.create);
    const prisma = {
      recurringTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'recurring-1',
            description: 'Assinatura',
            amountCents: 50_00,
            type: 'expense',
            dayOfMonth: 10,
            notes: 'Cobrar reajuste anual',
            accountId: null,
            categoryId: null,
            memberProfileId: 'profile-1',
          },
        ]),
      },
      transaction: { upsert },
    };
    const service = new RecurringService(prisma as never);

    await service.materializeForProfiles(['profile-1'], new Date('2026-07-01T00:00:00.000Z'));

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          referenceMonth: new Date('2026-07-01T00:00:00.000Z'),
          applicationDate: new Date('2026-07-10T00:00:00.000Z'),
          notes: 'Cobrar reajuste anual',
          status: 'pending',
        }),
      }),
    );
  });
});
