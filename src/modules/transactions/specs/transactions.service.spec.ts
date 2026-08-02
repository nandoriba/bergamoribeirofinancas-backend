import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../shared/tenant-context';
import { TransactionsService } from '../transactions.service';

describe('TransactionsService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forces manual transactions with application date up to today as confirmed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const create = vi.fn(async (args) => args.data);
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TransactionsService({ transaction: { create, findMany } } as never);

    await service.create(context, {
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

    await service.create(context, {
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
      service.create(context, {
        applicationDate: '2026-06-08',
        referenceMonth: '2026-06-01',
        description: 'Farmácia',
        amountCents: 100_00,
        type: 'expense',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FALSE_DUPLICATE' }),
    });

    await service.create(context, {
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

    await service.create(context, {
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
    const invoiceUpsert = vi.fn().mockResolvedValue({
      id: 'invoice-july',
      accountId: 'card-1',
      memberProfileId: 'profile-1',
    });
    const service = new TransactionsService({
      account: { findFirst: accountFindFirst },
      invoice: { upsert: invoiceUpsert },
      transaction: { create, findMany },
    } as never);

    await service.create(context, {
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
      service.create(context, {
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
    const service = new TransactionsService({
      memberProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'profile-1' }]) },
      transaction: { findMany },
    } as never);

    const transactions = await service.list(context, { referenceMonth: '2026-06' });

    expect(transactions.items).toEqual([
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
    expect(transactions.pageInfo).toEqual({ nextCursor: null, hasNextPage: false });
  });

  it('fails closed when the unique invoice for an author account belongs to another profile', async () => {
    const create = vi.fn();
    const service = new TransactionsService({
      account: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'card-1',
          type: 'credit_card',
          closingDay: 25,
          dueDay: 2,
        }),
      },
      invoice: {
        upsert: vi.fn().mockResolvedValue({
          id: 'inconsistent-invoice',
          accountId: 'card-1',
          memberProfileId: 'foreign-profile',
        }),
      },
      transaction: { create, findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    await expect(
      service.create(context, {
        applicationDate: '2026-06-26',
        description: 'Compra no cartão',
        amountCents: 100_00,
        type: 'expense',
        accountId: 'card-1',
      }),
    ).rejects.toThrow('Fatura inconsistente');

    expect(create).not.toHaveBeenCalled();
  });

  it('returns a stable cursor page using limit plus one', async () => {
    const firstId = '10000000-0000-4000-8000-000000000001';
    const secondId = '10000000-0000-4000-8000-000000000002';
    const extraId = '10000000-0000-4000-8000-000000000003';
    const findMany = vi.fn().mockResolvedValue([
      listedTransaction(firstId),
      listedTransaction(secondId),
      listedTransaction(extraId),
    ]);
    const service = new TransactionsService({
      memberProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'profile-1' }]) },
      transaction: { findMany },
    } as never);

    const result = await service.list(context, { referenceMonth: '2026-06', limit: 2 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ applicationDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(result.items.map((transaction) => transaction.id)).toEqual([firstId, secondId]);
    expect(result.pageInfo).toEqual({ nextCursor: secondId, hasNextPage: true });
  });

  it('validates a cursor with the same tenant-aware where before continuing', async () => {
    const cursorId = '20000000-0000-4000-8000-000000000001';
    const cursorFindFirst = vi.fn().mockResolvedValue({ id: cursorId });
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TransactionsService({
      memberProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'profile-1' }]) },
      transaction: { findFirst: cursorFindFirst, findMany },
    } as never);

    await service.list(context, { referenceMonth: '2026-06', cursor: cursorId, limit: 25 });

    const cursorWhere = cursorFindFirst.mock.calls[0][0].where;
    const pageWhere = findMany.mock.calls[0][0].where;
    expect(cursorWhere).toEqual({ ...pageWhere, id: cursorId });
    expect(cursorWhere).toEqual(
      expect.objectContaining({
        id: cursorId,
        memberProfileId: { in: ['profile-1'] },
        referenceMonth: expect.any(Object),
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: cursorId }, skip: 1, take: 26 }),
    );
  });

  it('rejects a cursor outside the scoped month or tenant before listing', async () => {
    const cursorId = '30000000-0000-4000-8000-000000000001';
    const findMany = vi.fn();
    const service = new TransactionsService({
      memberProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'profile-1' }]) },
      transaction: { findFirst: vi.fn().mockResolvedValue(null), findMany },
    } as never);

    await expect(
      service.list(context, { referenceMonth: '2026-06', cursor: cursorId }),
    ).rejects.toThrow('Cursor inválido');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('blocks updates outside the logged profile', async () => {
    const update = vi.fn();
    const service = new TransactionsService({
      transaction: {
        findFirst: vi.fn().mockResolvedValue(null),
        update,
      },
    } as never);

    await expect(service.update(context, 'transaction-from-other-profile', { description: 'Alterado' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Lançamento não encontrado' }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a profile filter from another tenant before reading transactions', async () => {
    const transactionFindMany = vi.fn();
    const profileFindFirst = vi.fn().mockResolvedValue(null);
    const service = new TransactionsService({
      memberProfile: { findFirst: profileFindFirst },
      transaction: { findMany: transactionFindMany },
    } as never);

    await expect(
      service.list(context, { referenceMonth: '2026-06', profileId: 'foreign-profile' }),
    ).rejects.toThrow('Perfil inválido');
    expect(profileFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-profile',
        familyId: 'family-1',
        status: { in: ['active', 'inactive'] },
      },
      select: { id: true },
    });
    expect(transactionFindMany).not.toHaveBeenCalled();
  });

  it('keeps the author profile in the final update predicate', async () => {
    const update = vi.fn(async (args) => ({
      ...args.data,
      account: null,
      category: null,
      invoice: null,
      installmentPlan: null,
      memberProfile: { id: 'profile-1', displayName: 'Membro' },
      isInvoiceAdjustment: false,
      isInvoicePayment: false,
      type: 'expense',
    }));
    const service = new TransactionsService({
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          applicationDate: new Date('2026-06-08T00:00:00.000Z'),
          accountId: null,
          categoryId: null,
          invoiceId: null,
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T12:00:00.000Z'),
        }),
        update,
      },
    } as never);

    await service.update(context, 'transaction-1', { description: 'Alterado' });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T12:00:00.000Z'),
        }),
      }),
    );
    expect(update.mock.calls[0][0].where.AND).toEqual([expect.objectContaining({ AND: expect.any(Array) })]);
  });

  it('reports a conflict when a transaction changes before the guarded update', async () => {
    const update = vi.fn().mockRejectedValue({ code: 'P2025' });
    const service = new TransactionsService({
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          applicationDate: new Date('2026-06-08T00:00:00.000Z'),
          accountId: null,
          categoryId: null,
          invoiceId: null,
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T12:00:00.000Z'),
        }),
        update,
      },
    } as never);

    await expect(service.update(context, 'transaction-1', { description: 'Alterado' })).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'O lançamento foi alterado; atualize os dados e tente novamente.',
      }),
    });
  });

  it('blocks structural edits on a transaction linked to an installment plan', async () => {
    const update = vi.fn();
    const service = new TransactionsService({
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          installmentPlanId: 'plan-1',
        }),
        update,
      },
    } as never);

    await expect(service.update(context, 'transaction-1', { amountCents: 200_00 })).rejects.toThrow(
      'Altere os dados estruturais pelo parcelamento vinculado.',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('does not allow removing an account while retaining an invoice', async () => {
    const update = vi.fn();
    const service = new TransactionsService({
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'invoice-1',
          accountId: 'card-1',
          memberProfileId: 'profile-1',
        }),
      },
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          applicationDate: new Date('2026-06-08T00:00:00.000Z'),
          accountId: 'card-1',
          categoryId: null,
          invoiceId: 'invoice-1',
        }),
        update,
      },
    } as never);

    await expect(
      service.update(context, 'transaction-1', { accountId: null } as never),
    ).rejects.toThrow('Informe a conta da fatura');
    expect(update).not.toHaveBeenCalled();
  });

  it('scopes Telegram side effects and the final delete to the author', async () => {
    const operationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const remove = vi.fn().mockResolvedValue({ id: 'transaction-1' });
    const tx = {
      telegramFinancialOperation: { updateMany: operationUpdateMany },
      transaction: { delete: remove },
    };
    const service = new TransactionsService({
      $transaction: vi.fn((callback) => callback(tx)),
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T12:00:00.000Z'),
        }),
      },
    } as never);

    await service.remove(context, 'transaction-1');

    expect(operationUpdateMany).toHaveBeenCalledWith({
      where: {
        transactionId: 'transaction-1',
        memberProfileId: 'profile-1',
        status: 'CREATED',
      },
      data: { status: 'UNDONE', undoneAt: expect.any(Date) },
    });
    expect(remove).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'transaction-1',
        memberProfileId: 'profile-1',
        installmentPlanId: null,
        updatedAt: new Date('2026-06-08T12:00:00.000Z'),
      }),
    });
  });

  it('reports a conflict when a transaction changes before the guarded delete', async () => {
    const tx = {
      telegramFinancialOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      transaction: { delete: vi.fn().mockRejectedValue({ code: 'P2025' }) },
    };
    const service = new TransactionsService({
      $transaction: vi.fn((callback) => callback(tx)),
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T12:00:00.000Z'),
        }),
      },
    } as never);

    await expect(service.remove(context, 'transaction-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'O lançamento foi alterado; atualize os dados e tente novamente.',
      }),
    });
  });

  it('blocks direct deletion of a transaction linked to an installment plan', async () => {
    const runTransaction = vi.fn();
    const service = new TransactionsService({
      $transaction: runTransaction,
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transaction-1',
          memberProfileId: 'profile-1',
          installmentPlanId: 'plan-1',
        }),
      },
    } as never);

    await expect(service.remove(context, 'transaction-1')).rejects.toThrow(
      'Remova o parcelamento vinculado em vez deste lançamento.',
    );
    expect(runTransaction).not.toHaveBeenCalled();
  });
});

function listedTransaction(id: string) {
  return {
    id,
    type: 'expense',
    description: 'Compra',
    isInvoiceAdjustment: false,
    isInvoicePayment: false,
    account: null,
    category: null,
    invoice: null,
    installmentPlan: null,
    memberProfile: { id: 'profile-1', displayName: 'Membro' },
  };
}
