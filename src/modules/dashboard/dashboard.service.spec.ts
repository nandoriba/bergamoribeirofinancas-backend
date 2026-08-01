import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('summarizes current and projected cards by reference month, application date and status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00.000Z'));

    const referenceMonth = new Date('2026-06-01T00:00:00.000Z');
    const confirmedIncome = {
      id: 'confirmed-income',
      date: new Date('2026-07-01T00:00:00.000Z'),
      applicationDate: new Date('2026-06-04T00:00:00.000Z'),
      referenceMonth,
      description: 'Receita confirmada da referência',
      amountCents: 500_00,
      type: 'income',
      status: 'confirmed',
      account: { name: 'Conta', type: 'checking' },
      category: { name: 'Receitas', color: '#3d6cb0' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };
    const confirmedExpense = {
      id: 'confirmed-expense',
      date: new Date('2026-07-20T00:00:00.000Z'),
      applicationDate: new Date('2026-06-05T00:00:00.000Z'),
      referenceMonth,
      description: 'Parcela confirmada com escrituração futura',
      amountCents: 100_00,
      type: 'expense',
      status: 'confirmed',
      installmentNumber: 2,
      account: { name: 'Cartão', type: 'credit_card' },
      category: { name: 'Mercado', color: '#3d6cb0' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };
    const futureConfirmedExpense = {
      id: 'future-confirmed-expense',
      date: new Date('2026-05-20T00:00:00.000Z'),
      applicationDate: new Date('2026-06-20T00:00:00.000Z'),
      referenceMonth,
      description: 'Parcela futura confirmada',
      amountCents: 50_00,
      type: 'expense',
      status: 'confirmed',
      installmentNumber: 3,
      account: { name: 'Cartão', type: 'credit_card' },
      category: { name: 'Mercado', color: '#3d6cb0' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };
    const confirmedCheckingExpense = {
      id: 'confirmed-checking-expense',
      date: new Date('2026-06-05T00:00:00.000Z'),
      applicationDate: new Date('2026-06-07T00:00:00.000Z'),
      referenceMonth,
      description: 'Débito em conta confirmado',
      amountCents: 70_00,
      type: 'expense',
      status: 'confirmed',
      installmentNumber: null,
      account: { name: 'Conta', type: 'checking' },
      category: { name: 'Mercado', color: '#3d6cb0' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };
    const pendingExpense = {
      id: 'pending-expense',
      date: new Date('2026-05-10T00:00:00.000Z'),
      applicationDate: new Date('2026-06-06T00:00:00.000Z'),
      referenceMonth,
      description: 'Compra pendente da referência',
      amountCents: 40_00,
      type: 'expense',
      status: 'pending',
      account: { name: 'Cartão', type: 'credit_card' },
      category: { name: 'Mercado', color: '#3d6cb0' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };
    const invoicePayment = {
      id: 'invoice-payment',
      date: new Date('2026-06-07T00:00:00.000Z'),
      applicationDate: new Date('2026-06-07T00:00:00.000Z'),
      referenceMonth,
      description: 'Pagamento de fatura',
      amountCents: 200_00,
      type: 'expense',
      status: 'confirmed',
      installmentNumber: null,
      isInvoicePayment: false,
      account: null,
      category: { name: 'Cartão', color: '#d99090' },
      memberProfile: { id: 'profile-1', displayName: 'Fernando' },
    };

    const transactionFindMany = vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where as {
        referenceMonth?: { gte?: Date; lte?: Date; lt?: Date };
        status?: string;
      } | undefined;

      if (where?.status === 'confirmed' || where?.referenceMonth?.lt) return [];

      const start = where?.referenceMonth?.gte?.toISOString().slice(0, 7);
      const end = where?.referenceMonth?.lte?.toISOString().slice(0, 7);

      const transactions = [
        confirmedIncome,
        confirmedExpense,
        futureConfirmedExpense,
        confirmedCheckingExpense,
        pendingExpense,
        invoicePayment,
      ];
      if (start === '2026-06' && end === '2026-06') return transactions;
      if (start === '2025-07' && end === '2026-06') return transactions;
      return [];
    });
    const openInstallments = Array.from({ length: 6 }, (_, index) => ({
      id: `open-installment-${index + 1}`,
      description: `Parcelamento aberto ${index + 1}`,
      paidInstallments: index,
      totalInstallments: index + 2,
      monthlyAmountCents: 10_00 + index,
    }));

    const prisma = {
      account: {
        findMany: vi.fn().mockResolvedValue([{ memberProfileId: 'profile-1', initialBalanceCents: 1_000_00 }]),
      },
      importRow: { findMany: vi.fn().mockResolvedValue([]) },
      installmentPlan: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'closed-installment',
            description: 'Parcelamento quitado',
            paidInstallments: 3,
            totalInstallments: 3,
            monthlyAmountCents: 99_00,
          },
          ...openInstallments,
        ]),
      },
      invoice: { findMany: vi.fn().mockResolvedValue([]) },
      memberProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'profile-1' }]) },
      monthlyOpening: { findMany: vi.fn().mockResolvedValue([]) },
      recurringTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      transaction: { findMany: transactionFindMany },
    };
    const recurringService = { materializeForProfiles: vi.fn().mockResolvedValue([]) };
    const service = new DashboardService(prisma as never, recurringService as never);

    const user: AuthenticatedUser = {
      id: 'user-1',
      email: 'fernando@example.com',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    };

    const data = await service.getDashboard(user, { referenceMonth: '2026-06', family: true });

    expect(data.saldoAtual).toBe(330_00);
    expect(data.saldoFuturo).toBe(240_00);
    expect(data.saldoAtualTotal).toBe(500_00);
    expect(data.saldoProjetadoTotal).toBe(500_00);
    expect(data.despesaAtual).toBe(170_00);
    expect(data.despesaFuturo).toBe(260_00);
    expect(data.despesaTotalMes).toBe(260_00);
    expect(data.saldoComposicaoConfirmada).toMatchObject({
      title: 'Composição confirmada',
      totalLabel: 'CONFIRMADO',
      totalValue: 670_00,
      slices: [
        { name: 'Saldo total confirmado sem despesa', value: 500_00 },
        { name: 'Despesa confirmada', value: 70_00 },
        { name: 'Cartão confirmado', value: 100_00 },
      ],
    });
    expect(data.saldoComposicaoProjetada).toMatchObject({
      title: 'Composição projetada',
      totalLabel: 'PROJETADO',
      totalValue: 760_00,
      slices: [
        { name: 'Saldo projetado total', value: 500_00 },
        { name: 'Despesa projetada', value: 70_00 },
        { name: 'Cartão projetado', value: 190_00 },
      ],
    });
    expect(data.donutSlices).toEqual([
      expect.objectContaining({ name: 'Cartão', value: 190_00 }),
      expect.objectContaining({ name: 'Mercado', value: 70_00 }),
    ]);
    expect(data.cartaoAtual).toBe(100_00);
    expect(data.cartaoFuturo).toBe(190_00);
    expect(data.parcelasConfirmadasQuantidade).toBe(1);
    expect(data.parcelasConfirmadasValorCents).toBe(100_00);
    expect(data.parcelasProjetadasQuantidade).toBe(2);
    expect(data.parcelasProjetadasValorCents).toBe(150_00);
    expect(data.parcelas).toHaveLength(6);
    expect(data.parcelas).toEqual(
      openInstallments.map((plan) => ({
        id: plan.id,
        name: plan.description,
        pago: plan.paidInstallments,
        total: plan.totalInstallments,
        mensal: plan.monthlyAmountCents,
        restante: (plan.totalInstallments - plan.paidInstallments) * plan.monthlyAmountCents,
      })),
    );
    expect(data.saldoDiarioAtual[19]).toBe(330_00);
    expect(data.saldoDiarioProjetado[19]).toBe(240_00);
    expect(data.despesaDiariaAtualSpark[19]).toBe(0);
    expect(data.despesaDiariaProjetadaSpark[19]).toBe(50_00);
    expect(data.cartaoDiariaAtualSpark[19]).toBe(0);
    expect(data.cartaoDiariaProjetadaSpark[19]).toBe(50_00);
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          referenceMonth: expect.objectContaining({
            gte: referenceMonth,
          }),
        }),
      }),
    );
  });

  it('rebuilds possible duplicate candidates when preview rows have no stored evidence', async () => {
    const prisma = {
      importRow: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'preview-row-1',
            description: 'Compra parecida',
            date: new Date('2026-08-02T00:00:00.000Z'),
            amountCents: 1990,
          },
        ]),
      },
      transaction: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'transaction-1',
            description: 'Compra existente',
            applicationDate: new Date('2026-08-02T00:00:00.000Z'),
            amountCents: 1990,
            type: 'expense',
            account: { name: 'Nubank Cartão' },
          },
        ]),
      },
    };
    const service = new DashboardService(prisma as never, {} as never);
    const candidates = await (
      service as unknown as {
        resolveImportDuplicateCandidates(row: unknown): Promise<unknown[]>;
      }
    ).resolveImportDuplicateCandidates({
      id: 'preview-row-2',
      importBatchId: 'batch-1',
      importBatch: { memberProfileId: 'profile-1', type: 'nubank_credit_card' },
      status: 'duplicate',
      falseDuplicate: true,
      date: new Date('2026-08-02T00:00:00.000Z'),
      description: 'Passei Direto - Parcela 12/12',
      amountCents: 1990,
      duplicateCandidates: null,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        description: 'Compra existente',
        applicationDate: '2026-08-02',
        amountCents: -1990,
        source: 'Sistema',
        accountName: 'Nubank Cartão',
      }),
      expect.objectContaining({
        description: 'Compra parecida',
        applicationDate: '2026-08-02',
        amountCents: -1990,
        source: 'Prévia atual',
      }),
    ]);
  });

  it('rebuilds strong duplicate candidates for decision in the import review', async () => {
    const prisma = {
      importRow: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'preview-row-1',
            description: 'Mercado',
            date: new Date('2026-06-08T00:00:00.000Z'),
            amountCents: -10000,
          },
        ]),
      },
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new DashboardService(prisma as never, {} as never);
    const candidates = await (
      service as unknown as {
        resolveImportDuplicateCandidates(row: unknown): Promise<unknown[]>;
      }
    ).resolveImportDuplicateCandidates({
      id: 'preview-row-2',
      importBatchId: 'batch-1',
      importBatch: { memberProfileId: 'profile-1', type: 'nubank_account' },
      status: 'duplicate',
      falseDuplicate: false,
      date: new Date('2026-06-08T00:00:00.000Z'),
      description: ' mercado ',
      amountCents: -10000,
      duplicateCandidates: null,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        description: 'Mercado',
        applicationDate: '2026-06-08',
        amountCents: -10000,
        source: 'Prévia atual',
      }),
    ]);
  });

  it('ignores stale persisted duplicate candidates with the opposite sign', async () => {
    const transactionFindMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      importRow: { findMany: vi.fn().mockResolvedValue([]) },
      transaction: { findMany: transactionFindMany },
    };
    const service = new DashboardService(prisma as never, {} as never);
    const candidates = await (
      service as unknown as {
        resolveImportDuplicateCandidates(row: unknown): Promise<unknown[]>;
      }
    ).resolveImportDuplicateCandidates({
      id: 'preview-row-1',
      importBatchId: 'batch-1',
      importBatch: { memberProfileId: 'profile-1', type: 'nubank_account' },
      status: 'duplicate',
      falseDuplicate: true,
      date: new Date('2026-04-22T00:00:00.000Z'),
      description: 'Transferência enviada pelo Pix',
      amountCents: -8000,
      duplicateCandidates: [
        {
          description: 'Transferência recebida pelo Pix',
          applicationDate: '2026-04-22',
          amountCents: 8000,
          source: 'Prévia atual',
        },
      ],
    });

    expect(candidates).toEqual([]);
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          amountCents: 8000,
          type: 'expense',
        }),
      }),
    );
  });
});
