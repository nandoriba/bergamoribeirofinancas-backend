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
      ];
      if (start === '2026-06' && end === '2026-06') return transactions;
      if (start === '2025-07' && end === '2026-06') return transactions;
      return [];
    });

    const prisma = {
      account: {
        findMany: vi.fn().mockResolvedValue([{ memberProfileId: 'profile-1', initialBalanceCents: 1_000_00 }]),
      },
      importRow: { findMany: vi.fn().mockResolvedValue([]) },
      installmentPlan: { findMany: vi.fn().mockResolvedValue([]) },
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
      role: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    };

    const data = await service.getDashboard(user, { referenceMonth: '2026-06', family: true });

    expect(data.saldoAtual).toBe(530_00);
    expect(data.saldoFuturo).toBe(620_00);
    expect(data.saldoAtualTotal).toBe(600_00);
    expect(data.saldoProjetadoTotal).toBe(690_00);
    expect(data.despesaAtual).toBe(170_00);
    expect(data.despesaFuturo).toBe(260_00);
    expect(data.cartaoAtual).toBe(100_00);
    expect(data.cartaoFuturo).toBe(190_00);
    expect(data.parcelasConfirmadasQuantidade).toBe(1);
    expect(data.parcelasConfirmadasValorCents).toBe(100_00);
    expect(data.parcelasProjetadasQuantidade).toBe(2);
    expect(data.parcelasProjetadasValorCents).toBe(150_00);
    expect(data.saldoDiarioAtual[19]).toBe(530_00);
    expect(data.saldoDiarioProjetado[19]).toBe(620_00);
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
});
