import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { TenantContext } from '../../../shared/tenant-context';
import { InvoicesService } from '../invoices.service';

describe('InvoicesService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'member@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  } satisfies AuthenticatedUser);

  function listTenantScope(profileIds: string[] = ['profile-1', 'inactive-profile']) {
    return {
      resolveProfileIds: vi.fn().mockResolvedValue(profileIds),
      byFamilyProfiles: vi.fn().mockReturnValue({ memberProfile: { familyId: 'family-1' } }),
      consistentInvoiceRelations: vi.fn().mockReturnValue({ account: { memberProfile: { familyId: 'family-1' } } }),
      consistentTransactionRelations: vi.fn().mockReturnValue({
        AND: Array.from({ length: 5 }, (_, index) => ({ relation: index })),
      }),
    };
  }

  it('pagina faturas e mantém todos os ramos de transações no escopo familiar autenticado', async () => {
    const invoices = Array.from({ length: 13 }, (_, index) => ({ id: `invoice-${index + 1}` }));
    const findMany = vi.fn().mockResolvedValue(invoices);
    const tenantScope = listTenantScope();
    const service = new InvoicesService({ invoice: { findMany } } as never, tenantScope as never);

    const result = await service.list(context);

    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      memberProfileId: { in: ['profile-1', 'inactive-profile'] },
      memberProfile: { familyId: 'family-1' },
      account: { memberProfile: { familyId: 'family-1' } },
    });
    expect(query.include.transactions.where).toMatchObject({
      memberProfileId: { in: ['profile-1', 'inactive-profile'] },
      memberProfile: { familyId: 'family-1' },
    });
    expect(query.include.transactions.where.AND).toHaveLength(5);
    expect(query.include.transactions.include.installmentPlan.include.transactions.where).toMatchObject({
      memberProfileId: { in: ['profile-1', 'inactive-profile'] },
      memberProfile: { familyId: 'family-1' },
    });
    expect(query.include.transactions.include.installmentPlan.include.transactions.where.AND).toHaveLength(5);
    expect(query.orderBy).toEqual([
      { referenceMonth: 'desc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(query.take).toBe(13);
    expect(result).toEqual({
      items: invoices.slice(0, 12),
      pageInfo: { hasNextPage: true, nextCursor: 'invoice-12' },
    });
  });

  it('uses the exact selected profile in invoices and every nested transaction branch', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tenantScope = listTenantScope(['inactive-profile']);
    const service = new InvoicesService({ invoice: { findMany } } as never, tenantScope as never);

    await service.list(context, { limit: 12, profileId: 'inactive-profile' });

    expect(tenantScope.resolveProfileIds).toHaveBeenCalledWith(context, {
      family: true,
      profileId: 'inactive-profile',
    });
    const query = findMany.mock.calls[0][0];
    expect(query.where.memberProfileId).toEqual({ in: ['inactive-profile'] });
    expect(query.include.transactions.where.memberProfileId).toEqual({ in: ['inactive-profile'] });
    expect(
      query.include.transactions.include.installmentPlan.include.transactions.where.memberProfileId,
    ).toEqual({ in: ['inactive-profile'] });
  });

  it('rejects a pending or foreign profile before querying invoices', async () => {
    const findFirst = vi.fn();
    const findMany = vi.fn();
    const tenantScope = listTenantScope();
    tenantScope.resolveProfileIds.mockRejectedValue(new Error('Perfil inválido'));
    const service = new InvoicesService({ invoice: { findFirst, findMany } } as never, tenantScope as never);

    await expect(service.list(context, { limit: 12, profileId: 'pending-profile' })).rejects.toThrow(
      'Perfil inválido',
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('continua a paginação a partir de um cursor válido do mesmo escopo familiar', async () => {
    const cursor = '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85';
    const findFirst = vi.fn().mockResolvedValue({ id: cursor });
    const findMany = vi.fn().mockResolvedValue([{ id: 'invoice-next' }]);
    const service = new InvoicesService(
      { invoice: { findFirst, findMany } } as never,
      listTenantScope() as never,
    );

    const result = await service.list(context, { cursor, limit: 5 });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: cursor,
        memberProfileId: { in: ['profile-1', 'inactive-profile'] },
        memberProfile: { familyId: 'family-1' },
        account: { memberProfile: { familyId: 'family-1' } },
      },
      select: { id: true },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: cursor },
        skip: 1,
        take: 6,
        orderBy: [
          { referenceMonth: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      }),
    );
    expect(result.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
  });

  it('mantém o cursor dentro do mês de referência solicitado', async () => {
    const cursor = '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85';
    const findFirst = vi.fn().mockResolvedValue({ id: cursor });
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new InvoicesService(
      { invoice: { findFirst, findMany } } as never,
      listTenantScope() as never,
    );

    await service.list(context, { cursor, limit: 12, referenceMonth: '2026-07' });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: cursor,
        memberProfileId: { in: ['profile-1', 'inactive-profile'] },
        memberProfile: { familyId: 'family-1' },
        account: { memberProfile: { familyId: 'family-1' } },
        referenceMonth: {
          gte: new Date('2026-07-01T00:00:00.000Z'),
          lte: new Date('2026-07-31T23:59:59.999Z'),
        },
      },
      select: { id: true },
    });
  });

  it('rejeita cursor inexistente ou pertencente a outra família', async () => {
    const cursor = '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85';
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const service = new InvoicesService(
      { invoice: { findFirst, findMany } } as never,
      listTenantScope() as never,
    );

    await expect(service.list(context, { cursor, limit: 12 })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Cursor inválido' }),
    });

    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a credit card id outside the author profile', async () => {
    const accountFindFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn();
    const service = new InvoicesService({
      account: { findFirst: accountFindFirst },
      invoice: { create },
    } as never);

    await expect(
      service.create(context, { accountId: 'foreign-card', referenceMonth: '2026-07-01' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ message: 'Cartão inválido' }) });

    expect(accountFindFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-card', memberProfileId: 'profile-1', type: 'credit_card' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('closes an invoice using only author transactions and keeps author scope in the final update', async () => {
    const invoiceFindFirst = vi.fn().mockResolvedValue({
      id: 'invoice-1',
      accountId: 'card-1',
      referenceMonth: new Date('2026-07-01T00:00:00.000Z'),
      status: 'open',
    });
    const accountFindFirst = vi.fn().mockResolvedValue({ id: 'card-1', type: 'credit_card' });
    const transactionFindMany = vi.fn().mockResolvedValue([
      { amountCents: 12500, invoiceAmountCents: null, isInvoiceAdjustment: false },
    ]);
    const update = vi.fn().mockResolvedValue({ id: 'invoice-1' });
    const service = new InvoicesService({
      account: { findFirst: accountFindFirst },
      invoice: { findFirst: invoiceFindFirst, update },
      transaction: { findMany: transactionFindMany },
    } as never);

    await service.update(context, 'invoice-1', { status: 'closed' });

    expect(transactionFindMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        invoiceId: 'invoice-1',
        memberProfileId: 'profile-1',
        isInvoicePayment: false,
        AND: expect.any(Array),
      }),
      select: { amountCents: true, invoiceAmountCents: true, isInvoiceAdjustment: true },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invoice-1', memberProfileId: 'profile-1' },
        data: expect.objectContaining({ totalCents: 12500 }),
      }),
    );
  });

  it('blocks foreign invoice ids and keeps author scope in the final delete', async () => {
    const remove = vi.fn().mockResolvedValue({ id: 'invoice-1' });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'invoice-1', memberProfileId: 'profile-1' });
    const service = new InvoicesService({ invoice: { findFirst, delete: remove } } as never);

    await expect(service.remove(context, 'foreign-invoice')).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Fatura não encontrada' }),
    });
    expect(remove).not.toHaveBeenCalled();

    await service.remove(context, 'invoice-1');
    expect(remove).toHaveBeenCalledWith({ where: { id: 'invoice-1', memberProfileId: 'profile-1' } });
  });
});
