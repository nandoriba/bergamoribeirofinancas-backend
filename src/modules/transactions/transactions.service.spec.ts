import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  const user: AuthenticatedUser = {
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
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

  it('does not compare manual duplicates across opposite transaction types', async () => {
    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn(async (args) => {
      if (args.where.type === 'income') return [];
      return [
        {
          id: 'transaction-1',
          applicationDate: new Date('2026-04-03T00:00:00.000Z'),
          amountCents: 106_97,
          description: 'Compra no débito via NuPay - iFood',
        },
      ];
    });
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await service.create(user, {
      applicationDate: '2026-04-03',
      referenceMonth: '2026-04-01',
      description: 'Estorno - Compra no débito via NuPay - iFood',
      amountCents: 106_97,
      type: 'income',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amountCents: 106_97, type: 'income' }),
      }),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates credit card invoice from closing day when reference month is omitted', async () => {
    const create = vi.fn(async (args) => ({
      ...args.data,
      account: { type: 'credit_card' },
      category: null,
      invoice: null,
      installmentPlan: null,
    }));
    const findMany = vi.fn().mockResolvedValue([]);
    const accountFindFirst = vi.fn().mockResolvedValue({
      id: 'card-1',
      type: 'credit_card',
      closingDay: 25,
      dueDay: 2,
    });
    const invoiceUpsert = vi.fn().mockResolvedValue({ id: 'invoice-july' });
    const service = new TransactionsService({
      account: { findFirst: accountFindFirst },
      invoice: { upsert: invoiceUpsert },
      transaction: { create, findMany },
    } as never);

    await service.create(user, {
      applicationDate: '2026-06-26',
      description: 'Compra no cartão',
      amountCents: 100_00,
      type: 'expense',
      accountId: 'card-1',
    });

    const julyReference = new Date('2026-07-01T00:00:00.000Z');
    expect(invoiceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_referenceMonth: {
            accountId: 'card-1',
            referenceMonth: julyReference,
          },
        },
        create: expect.objectContaining({
          referenceMonth: julyReference,
          closingDate: new Date('2026-07-25T00:00:00.000Z'),
          dueDate: new Date('2026-07-02T00:00:00.000Z'),
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceMonth: julyReference,
          invoiceId: 'invoice-july',
        }),
      }),
    );
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

  it('maps operational categories for credit card purchases and invoice payments', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'card-transaction',
        type: 'expense',
        description: 'Compra no cartão',
        isInvoicePayment: false,
        account: { type: 'credit_card' },
        category: { id: 'category-outros', name: 'Outros', color: '#3d6cb0' },
      },
      {
        id: 'invoice-payment',
        type: 'expense',
        description: 'Pagamento de fatura',
        isInvoicePayment: false,
        account: null,
        category: { id: 'category-card', name: 'Cartão', color: '#d99090' },
      },
    ]);
    const service = new TransactionsService({ transaction: { findMany } } as never);

    const transactions = await service.list(user, { referenceMonth: '2026-06' });

    expect(transactions).toEqual([
      expect.objectContaining({
        id: 'card-transaction',
        operationalCategory: {
          key: 'system:credit_card',
          name: 'Cartão',
          color: '#d99090',
        },
      }),
      expect.objectContaining({
        id: 'invoice-payment',
        operationalCategory: {
          key: 'system:invoice_payment',
          name: 'Pagamento de fatura',
          color: '#d99090',
        },
      }),
    ]);
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
