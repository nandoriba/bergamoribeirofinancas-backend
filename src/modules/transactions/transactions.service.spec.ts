import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
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

  it('forces manual transactions with application date up to today as confirmed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await service.create(user, {
      applicationDate: '2026-06-08',
      referenceMonth: '2026-06-01',
      description: 'Compra manual',
      amountCents: 100_00,
      type: 'expense',
      status: 'pending',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          date: expect.any(Date),
          applicationDate: new Date('2026-06-08T00:00:00.000Z'),
          status: 'confirmed',
        }),
      }),
    );
  });

  it('keeps selected status for future manual transactions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await service.create(user, {
      applicationDate: '2026-06-20',
      referenceMonth: '2026-06-01',
      description: 'Previsão manual',
      amountCents: 100_00,
      type: 'expense',
      status: 'pending',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationDate: new Date('2026-06-20T00:00:00.000Z'),
          status: 'pending',
        }),
      }),
    );
  });

  it('warns on manual false duplicates by amount and application date', async () => {
    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'transaction-1',
        applicationDate: new Date('2026-06-08T00:00:00.000Z'),
        amountCents: 100_00,
        description: 'Mercado',
      },
    ]);
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await expect(
      service.create(user, {
        applicationDate: '2026-06-08',
        referenceMonth: '2026-06-01',
        description: 'Farmácia',
        amountCents: 100_00,
        type: 'expense',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FALSE_DUPLICATE' }),
    });

    await service.create(user, {
      applicationDate: '2026-06-08',
      referenceMonth: '2026-06-01',
      description: 'Farmácia',
      amountCents: 100_00,
      type: 'expense',
      allowDuplicate: true,
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('blocks manual strong duplicates by amount, application date and description', async () => {
    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'transaction-1',
        applicationDate: new Date('2026-06-08T00:00:00.000Z'),
        amountCents: 100_00,
        description: 'Mercado',
      },
    ]);
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await expect(
      service.create(user, {
        applicationDate: '2026-06-08',
        referenceMonth: '2026-06-01',
        description: ' mercado ',
        amountCents: 100_00,
        type: 'expense',
        allowDuplicate: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STRONG_DUPLICATE' }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks updates outside the logged profile', async () => {
    const update = vi.fn();
    const service = new TransactionsService({
      transaction: {
        findFirst: vi.fn().mockResolvedValue(null),
        update,
      },
    } as never);

    await expect(service.update(user, 'transaction-from-other-profile', { description: 'Alterado' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Lançamento não encontrado' }),
    });
    expect(update).not.toHaveBeenCalled();
  });
});
