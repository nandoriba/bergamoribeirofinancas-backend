import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { DashboardService } from './dashboard.service';

const REFERENCE_MONTH = new Date('2026-06-01T00:00:00.000Z');

describe('DashboardService profile projections', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects a selected sibling recurring template without writing or changing confirmed totals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'));

    const recurringTemplate = buildRecurringTemplate({
      id: 'recurring-b',
      memberProfileId: 'profile-b',
      amountCents: 125_00,
    });
    const harness = createHarness({
      profileIds: ['profile-b'],
      recurringTemplates: [recurringTemplate],
    });

    const data = await harness.service.getDashboard(context(), {
      referenceMonth: '2026-06',
      profileId: 'profile-b',
      family: true,
    });

    expect(data.saldoAtual).toBe(0);
    expect(data.despesaAtual).toBe(0);
    expect(data.saldoFuturo).toBe(-125_00);
    expect(data.despesaFuturo).toBe(125_00);
    expect(data.despesaDiariaAtualSpark[14]).toBe(0);
    expect(data.despesaDiariaProjetadaSpark[14]).toBe(125_00);
    expect(data.saldoMensal.at(-1)?.v).toBe(-125_00);
    expect(data.donutSlices).toEqual([expect.objectContaining({ name: 'Mercado', value: 125_00 })]);
    expect(data.transactions).toEqual([]);
    expect(harness.recurringService.materializeOwnProfile).not.toHaveBeenCalled();
    expect(harness.prisma.transaction.create).not.toHaveBeenCalled();
    expect(harness.prisma.transaction.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.recurringTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memberProfileId: { in: ['profile-b'] } }),
      }),
    );
  });

  it('deduplicates a materialized occurrence from consolidated projected totals', async () => {
    const recurringTemplate = buildRecurringTemplate({
      id: 'recurring-b',
      memberProfileId: 'profile-b',
      amountCents: 125_00,
    });
    const materialized = {
      id: 'transaction-b',
      date: new Date('2026-06-15T00:00:00.000Z'),
      applicationDate: new Date('2026-06-15T00:00:00.000Z'),
      referenceMonth: REFERENCE_MONTH,
      description: recurringTemplate.description,
      amountCents: recurringTemplate.amountCents,
      type: 'expense',
      status: 'pending',
      recurrenceType: 'monthly',
      source: 'recurring',
      externalId: 'recurring:recurring-b:2026-06',
      recurringTemplateId: recurringTemplate.id,
      isInvoicePayment: false,
      isInvoiceAdjustment: false,
      installmentNumber: null,
      account: { name: 'Conta B', type: 'checking' },
      category: { name: 'Mercado', color: '#123456' },
      memberProfile: { id: 'profile-b', displayName: 'Perfil B' },
    };
    const harness = createHarness({
      profileIds: ['profile-a', 'profile-b'],
      recurringTemplates: [recurringTemplate],
      monthTransactions: [materialized],
    });

    const data = await harness.service.getDashboard(context(), {
      referenceMonth: '2026-06',
      family: true,
    });

    expect(data.despesaFuturo).toBe(125_00);
    expect(data.donutSlices).toEqual([expect.objectContaining({ name: 'Mercado', value: 125_00 })]);
    expect(data.transactions).toHaveLength(1);
    expect(harness.recurringService.materializeOwnProfile).not.toHaveBeenCalled();
  });

  it('keeps the credit-card balance impact stable after a projected occurrence is materialized', async () => {
    const recurringTemplate = buildRecurringTemplate({
      id: 'recurring-card',
      memberProfileId: 'profile-b',
      amountCents: 125_00,
    });
    const materialized = {
      id: 'transaction-card',
      date: new Date('2026-06-15T00:00:00.000Z'),
      applicationDate: new Date('2026-06-15T00:00:00.000Z'),
      referenceMonth: REFERENCE_MONTH,
      description: recurringTemplate.description,
      amountCents: recurringTemplate.amountCents,
      type: 'expense',
      status: 'pending',
      recurrenceType: 'monthly',
      source: 'recurring',
      externalId: 'recurring:recurring-card:2026-06',
      recurringTemplateId: recurringTemplate.id,
      isInvoicePayment: false,
      isInvoiceAdjustment: false,
      installmentNumber: null,
      account: { name: 'Cartão B', type: 'credit_card' },
      category: { name: 'Mercado', color: '#123456' },
      memberProfile: { id: 'profile-b', displayName: 'Perfil B' },
    };
    const projectedHarness = createHarness({
      profileIds: ['profile-b'],
      recurringTemplates: [recurringTemplate],
      recurringAccountType: 'credit_card',
    });
    const materializedHarness = createHarness({
      profileIds: ['profile-b'],
      recurringTemplates: [recurringTemplate],
      recurringAccountType: 'credit_card',
      monthTransactions: [materialized],
      monthlyBalanceTransactions: [materialized],
    });

    const projected = await projectedHarness.service.getDashboard(context(), {
      referenceMonth: '2026-06',
      profileId: 'profile-b',
      family: true,
    });
    const persisted = await materializedHarness.service.getDashboard(context(), {
      referenceMonth: '2026-06',
      profileId: 'profile-b',
      family: true,
    });

    expect(projected.saldoMensal.at(-1)?.v).toBe(125_00);
    expect(persisted.saldoMensal.at(-1)?.v).toBe(125_00);
    expect(materializedHarness.prisma.transaction.findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ include: { account: true } }),
    );
  });

  it('does not project an occurrence outside the recurring template interval', async () => {
    const startsAfterOccurrence = {
      ...buildRecurringTemplate({ id: 'starts-after', memberProfileId: 'profile-b', amountCents: 100_00 }),
      startsAt: new Date('2026-06-20T00:00:00.000Z'),
    };
    const endsBeforeOccurrence = {
      ...buildRecurringTemplate({ id: 'ends-before', memberProfileId: 'profile-b', amountCents: 200_00 }),
      endsAt: new Date('2026-06-10T00:00:00.000Z'),
    };
    const harness = createHarness({
      profileIds: ['profile-b'],
      recurringTemplates: [startsAfterOccurrence, endsBeforeOccurrence],
    });

    const data = await harness.service.getDashboard(context(), {
      referenceMonth: '2026-06',
      profileId: 'profile-b',
      family: true,
    });

    expect(data.despesaFuturo).toBe(0);
    expect(data.saldoFuturo).toBe(0);
    expect(data.saldoMensal.at(-1)?.v).toBe(0);
    expect(data.avisos).toEqual([]);
  });
});

function createHarness(input: {
  profileIds: string[];
  recurringTemplates: Array<ReturnType<typeof buildRecurringTemplate>>;
  monthTransactions?: unknown[];
  monthlyBalanceTransactions?: unknown[];
  recurringAccountType?: 'checking' | 'credit_card';
}) {
  const recurringAccounts = input.recurringTemplates.map((template) => ({
    id: template.accountId,
    name: template.memberProfileId === 'profile-a' ? 'Conta A' : 'Conta B',
    type: input.recurringAccountType ?? 'checking',
  }));
  const transactionFindMany = vi
    .fn()
    .mockResolvedValueOnce(input.monthTransactions ?? [])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(input.monthlyBalanceTransactions ?? [])
    .mockResolvedValueOnce([]);
  const accountFindMany = vi
    .fn()
    .mockResolvedValueOnce(recurringAccounts)
    .mockResolvedValueOnce(
      input.profileIds.map((memberProfileId) => ({ memberProfileId, initialBalanceCents: 0 })),
    );
  const prisma = {
    account: { findMany: accountFindMany },
    importBatch: { findFirst: vi.fn().mockResolvedValue(null) },
    importRow: { findMany: vi.fn() },
    installmentPlan: { findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    monthlyOpening: { findMany: vi.fn().mockResolvedValue([]) },
    recurringTemplate: { findMany: vi.fn().mockResolvedValue(input.recurringTemplates) },
    transaction: {
      create: vi.fn(),
      findMany: transactionFindMany,
      upsert: vi.fn(),
    },
  };
  const recurringService = { materializeOwnProfile: vi.fn() };
  const tenantScope = {
    consistentInvoiceRelations: vi.fn().mockReturnValue({}),
    consistentRecurringRelations: vi.fn().mockReturnValue({}),
    consistentTransactionRelations: vi.fn().mockReturnValue({}),
    resolveProfileIds: vi.fn().mockResolvedValue(input.profileIds),
  };

  return {
    prisma,
    recurringService,
    service: new DashboardService(prisma as never, recurringService as never, tenantScope as never),
  };
}

function buildRecurringTemplate(input: { id: string; memberProfileId: string; amountCents: number }) {
  return {
    id: input.id,
    description: `Recorrência ${input.memberProfileId}`,
    amountCents: input.amountCents,
    type: 'expense',
    dayOfMonth: 15,
    startsAt: REFERENCE_MONTH,
    endsAt: null as Date | null,
    notes: null,
    status: 'active',
    memberProfileId: input.memberProfileId,
    accountId: input.memberProfileId === 'profile-a' ? 'account-a' : 'account-b',
    categoryId: 'category-family',
    category: { id: 'category-family', name: 'Mercado', color: '#123456' },
    deletedAt: null,
    createdAt: REFERENCE_MONTH,
    updatedAt: REFERENCE_MONTH,
  };
}

function context() {
  return TenantContext.fromAuthenticatedUser({
    id: 'user-a',
    email: 'a@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-a',
    profileId: 'profile-a',
  });
}
