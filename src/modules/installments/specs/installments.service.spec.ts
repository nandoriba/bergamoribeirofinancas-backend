import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../shared/tenant-context';
import { InstallmentsService } from '../installments.service';

describe('InstallmentsService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  });

  function listTenantScope(profileIds: string[] = ['profile-1', 'inactive-profile']) {
    return {
      resolveProfileIds: vi.fn().mockResolvedValue(profileIds),
      byFamilyProfiles: vi.fn().mockReturnValue({ memberProfile: { familyId: 'family-1' } }),
      consistentTransactionRelations: vi.fn().mockReturnValue({ AND: [{ relations: 'consistent' }] }),
    };
  }

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
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async (args) => {
          transactionCreates.push(args.data);
          return args.data;
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new InstallmentsService(prisma as never);

    await service.create(context, {
      description: 'Farmamed -',
      totalInstallments: 3,
      firstInstallmentNumber: 2,
      monthlyAmountCents: 100_00,
      totalAmountCents: 999_00,
      startsAt: '2026-06-08T12:00:00.000Z',
      firstApplicationDate: '2026-06-05',
      firstReferenceMonth: '2026-06-01',
    });

    expect(tx.installmentPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'Farmamed',
          totalAmountCents: 300_00,
        }),
      }),
    );
    expect(transactionCreates).toEqual([
      expect.objectContaining({
        description: 'Farmamed - Parcela 1/3',
        referenceMonth: new Date('2026-05-01T00:00:00.000Z'),
        applicationDate: new Date('2026-05-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
      expect.objectContaining({
        description: 'Farmamed - Parcela 2/3',
        referenceMonth: new Date('2026-06-01T00:00:00.000Z'),
        applicationDate: new Date('2026-06-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
      expect.objectContaining({
        description: 'Farmamed - Parcela 3/3',
        referenceMonth: new Date('2026-07-01T00:00:00.000Z'),
        applicationDate: new Date('2026-07-05T00:00:00.000Z'),
        status: 'confirmed',
      }),
    ]);
  });

  it('rejects current installment number above total installments before writing', async () => {
    const prisma = {
      $transaction: vi.fn(),
      transaction: { findFirst: vi.fn() },
    };
    const service = new InstallmentsService(prisma as never);

    await expect(
      service.create(context, {
        description: 'Compra',
        totalInstallments: 3,
        firstInstallmentNumber: 4,
        monthlyAmountCents: 100_00,
        totalAmountCents: 300_00,
        startsAt: '2026-06-08T12:00:00.000Z',
        firstApplicationDate: '2026-06-05',
        firstReferenceMonth: '2026-06-01',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Parcela atual não pode ser maior que o total de parcelas',
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the historical list scoped to every profile in the authenticated family', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new InstallmentsService(
      {
        $queryRaw: vi.fn().mockResolvedValue([
          { totalPurchaseCents: 0n, totalInstallments: 0n, totalAmountToPayCents: 0n },
        ]),
        installmentPlan: { findMany },
      } as never,
      listTenantScope() as never,
    );

    await expect(service.list(context)).resolves.toEqual({
      items: [],
      summary: { totalPurchaseCents: 0, totalInstallments: 0, totalAmountToPayCents: 0 },
      pageInfo: { hasNextPage: false, nextCursor: null },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberProfileId: { in: ['profile-1', 'inactive-profile'] },
          memberProfile: { familyId: 'family-1' },
        },
        include: expect.objectContaining({
          transactions: expect.objectContaining({
            where: expect.objectContaining({
              memberProfileId: { in: ['profile-1', 'inactive-profile'] },
            }),
          }),
        }),
      }),
    );
  });

  it('paginates plans while keeping the summary over the complete family scope', async () => {
    const plans = Array.from({ length: 13 }, (_, index) => ({
      id: `plan-${index + 1}`,
      totalAmountCents: 1_000,
      totalInstallments: 2,
      paidInstallments: 1,
      monthlyAmountCents: 500,
      transactions: [],
    }));
    const findMany = vi.fn().mockResolvedValue(plans);
    const queryRaw = vi.fn().mockResolvedValue([
      { totalPurchaseCents: 13_000n, totalInstallments: 26n, totalAmountToPayCents: 6_500n },
    ]);
    const service = new InstallmentsService(
      { $queryRaw: queryRaw, installmentPlan: { findMany } } as never,
      listTenantScope() as never,
    );

    const result = await service.list(context, { limit: 12 });

    expect(result.items).toHaveLength(12);
    expect(result.summary).toEqual({
      totalPurchaseCents: 13_000,
      totalInstallments: 26,
      totalAmountToPayCents: 6_500,
    });
    expect(result.pageInfo).toEqual({ hasNextPage: true, nextCursor: 'plan-12' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberProfileId: { in: ['profile-1', 'inactive-profile'] },
          memberProfile: { familyId: 'family-1' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 13,
      }),
    );
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('uses one exact profile for plans, nested transactions and the aggregate summary', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const queryRaw = vi.fn().mockResolvedValue([
      { totalPurchaseCents: 0n, totalInstallments: 0n, totalAmountToPayCents: 0n },
    ]);
    const tenantScope = listTenantScope(['inactive-profile']);
    const service = new InstallmentsService(
      { $queryRaw: queryRaw, installmentPlan: { findMany } } as never,
      tenantScope as never,
    );

    await service.list(context, { limit: 12, profileId: 'inactive-profile' });

    expect(tenantScope.resolveProfileIds).toHaveBeenCalledWith(context, {
      family: true,
      profileId: 'inactive-profile',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberProfileId: { in: ['inactive-profile'] },
          memberProfile: { familyId: 'family-1' },
        },
        include: expect.objectContaining({
          transactions: expect.objectContaining({
            where: expect.objectContaining({ memberProfileId: { in: ['inactive-profile'] } }),
          }),
        }),
      }),
    );
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][0].values).toEqual(['family-1', 'inactive-profile']);
  });

  it('rejects a pending or foreign profile before querying plans or summaries', async () => {
    const findFirst = vi.fn();
    const findMany = vi.fn();
    const queryRaw = vi.fn();
    const tenantScope = listTenantScope();
    tenantScope.resolveProfileIds.mockRejectedValue(new Error('Perfil inválido'));
    const service = new InstallmentsService(
      { $queryRaw: queryRaw, installmentPlan: { findFirst, findMany } } as never,
      tenantScope as never,
    );

    await expect(
      service.list(context, { limit: 12, profileId: 'pending-profile' }),
    ).rejects.toThrow('Perfil inválido');
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a cursor outside the authenticated family scope', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const service = new InstallmentsService(
      { installmentPlan: { findFirst, findMany } } as never,
      listTenantScope() as never,
    );

    await expect(
      service.list(context, { limit: 12, cursor: '00000000-0000-4000-8000-000000000002' }),
    ).rejects.toThrow('Cursor inválido');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: '00000000-0000-4000-8000-000000000002',
        memberProfileId: { in: ['profile-1', 'inactive-profile'] },
        memberProfile: { familyId: 'family-1' },
      },
      select: { id: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not update an installment owned by another profile', async () => {
    const update = vi.fn();
    const tx = {
      installmentPlan: { findFirst: vi.fn().mockResolvedValue(null), update },
    };
    const service = new InstallmentsService({
      $transaction: vi.fn((callback) => callback(tx)),
    } as never);

    await expect(service.update(context, 'foreign-plan', { description: 'Alterado' })).rejects.toThrow(
      'Parcelamento não encontrado',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('updates the plan description and generated transaction descriptions atomically', async () => {
    const transactionUpdate = vi.fn().mockResolvedValue({});
    const planUpdate = vi.fn().mockResolvedValue({
      id: 'plan-1',
      totalInstallments: 2,
      paidInstallments: 0,
      monthlyAmountCents: 1_000,
      transactions: [],
    });
    const tx = {
      installmentPlan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-1',
          description: 'Antigo',
          totalInstallments: 2,
          memberProfileId: 'profile-1',
        }),
        update: planUpdate,
      },
      transaction: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'transaction-1', installmentNumber: 1 },
          { id: 'transaction-2', installmentNumber: 2 },
        ]),
        update: transactionUpdate,
      },
    };
    const service = new InstallmentsService({ $transaction: vi.fn((callback) => callback(tx)) } as never);

    await service.update(context, 'plan-1', { description: 'Novo' });

    expect(transactionUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'transaction-1', memberProfileId: 'profile-1' },
      data: { description: 'Novo - Parcela 1/2' },
    });
    expect(transactionUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 'transaction-2', memberProfileId: 'profile-1' },
      data: { description: 'Novo - Parcela 2/2' },
    });
    expect(planUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'plan-1', memberProfileId: 'profile-1' },
        data: { description: 'Novo', paidInstallments: undefined },
      }),
    );
  });

  it('removes a plan and unlinks only author transactions in one transaction', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const deletePlan = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const tx = {
      installmentPlan: {
        findFirst: vi.fn().mockResolvedValue({ id: 'plan-1', memberProfileId: 'profile-1' }),
        delete: deletePlan,
      },
      transaction: { updateMany },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const service = new InstallmentsService(prisma as never);

    await service.remove(context, 'plan-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { installmentPlanId: 'plan-1', memberProfileId: 'profile-1' },
      data: { installmentPlanId: null, installmentNumber: null },
    });
    expect(deletePlan).toHaveBeenCalledWith({ where: { id: 'plan-1', memberProfileId: 'profile-1' } });
  });

  it('fails closed when a scoped link candidate changes concurrently', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      installmentPlan: { create: vi.fn().mockResolvedValue({ id: 'plan-1' }) },
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'candidate-1',
          description: 'Compra',
          amountCents: 100_00,
          updatedAt: new Date('2026-06-08T13:00:00.000Z'),
        }),
        updateMany,
        create: vi.fn(),
      },
    };
    const service = new InstallmentsService({ $transaction: vi.fn((callback) => callback(tx)) } as never);

    await expect(
      service.create(context, {
        description: 'Compra',
        totalInstallments: 1,
        firstInstallmentNumber: 1,
        monthlyAmountCents: 100_00,
        totalAmountCents: 100_00,
        startsAt: '2026-06-08T12:00:00.000Z',
        firstApplicationDate: '2026-06-05',
        firstReferenceMonth: '2026-06-01',
        confirmExistingLinks: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'installment_link_candidate_changed' }),
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'candidate-1',
          memberProfileId: 'profile-1',
          installmentPlanId: null,
          updatedAt: new Date('2026-06-08T13:00:00.000Z'),
          referenceMonth: new Date('2026-06-01T00:00:00.000Z'),
          amountCents: 100_00,
          type: 'expense',
          accountId: null,
          categoryId: null,
        }),
      }),
    );
    expect(tx.transaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountId: null,
          categoryId: null,
          memberProfileId: 'profile-1',
        }),
      }),
    );
  });
});
