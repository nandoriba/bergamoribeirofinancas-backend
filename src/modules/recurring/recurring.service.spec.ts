import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { RecurringService } from './recurring.service';

describe('RecurringService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'membro@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('materializes application date from day of month in the selected reference month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const upsert = vi.fn(async (args) => args.create);
    const prisma = {
      account: { findMany: vi.fn().mockResolvedValue([]) },
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

    await service.materializeOwnProfile(context, new Date('2026-07-01T00:00:00.000Z'));

    expect(prisma.recurringTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberProfileId: 'profile-1',
          deletedAt: null,
          status: 'active',
        }),
      }),
    );
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

  it('soft deletes recurring templates to preserve transaction traceability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const update = vi.fn();
    const prisma = {
      recurringTemplate: {
        findFirst: vi.fn().mockResolvedValue({ id: 'recurring-1', memberProfileId: 'profile-1' }),
        update,
      },
    };
    const service = new RecurringService(prisma as never);

    await service.remove(context, 'recurring-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'recurring-1', memberProfileId: 'profile-1' },
      data: {
        deletedAt: new Date('2026-06-08T12:00:00.000Z'),
        status: 'paused',
      },
    });
  });

  it('fails closed when a recurring template references an account outside the author profile', async () => {
    const upsert = vi.fn();
    const prisma = {
      account: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      recurringTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'recurring-foreign-account',
            description: 'Inválida',
            amountCents: 10_00,
            type: 'expense',
            dayOfMonth: 1,
            notes: null,
            accountId: 'foreign-account',
            categoryId: null,
            memberProfileId: 'profile-1',
          },
        ]),
      },
      transaction: { upsert },
    };
    const service = new RecurringService(prisma as never);

    await expect(service.materializeOwnProfile(context, new Date('2026-07-01T00:00:00.000Z'))).rejects.toThrow(
      'Conta inválida',
    );
    expect(prisma.account.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-account', memberProfileId: 'profile-1' },
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
