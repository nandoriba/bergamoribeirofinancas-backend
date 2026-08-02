import { UnauthorizedException } from '@nestjs/common';
import { AiUsageEventStatus, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../shared/tenant-context';
import { AiProviderError } from '../ai-provider';
import {
  AiUsageService,
  estimateCostUsd,
  nextUtcMonth,
  parseUtcMonth,
  utcMonthStart,
} from '../ai-usage.service';

const NOW = new Date('2026-08-31T23:59:59.999Z');

function createService(prisma: unknown, overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AI_PROVIDER: 'openai',
    OPENAI_MODEL: 'gpt-4o-mini',
    OPENAI_PRICING_VERSION: 'pricing-v1',
    OPENAI_INPUT_USD_PER_MILLION_TOKENS: '0.15',
    OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: '0.60',
    TELEGRAM_AI_PLAN_CODE: 'monthly-card-v1',
    TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT: 2,
    TELEGRAM_AI_WARNING_PERCENT: 80,
    TELEGRAM_UPDATE_RECOVERY_MINUTES: 5,
    ...overrides,
  };
  return new AiUsageService(
    { get: vi.fn((key: string) => values[key]) } as never,
    prisma as never,
  );
}

function identity(overrides: Record<string, string> = {}) {
  return {
    familyId: 'family-a',
    memberProfileId: 'profile-a',
    chatId: 'chat-a',
    tgUserId: 'tg-a',
    ...overrides,
  };
}

function tenantUsage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-usage-a',
    familyId: 'family-a',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    planCode: 'monthly-card-v1',
    messageLimit: 2,
    nearLimitMessageCount: 2,
    messages: 0,
    blockedMessages: 0,
    tokensIn: 0n,
    tokensOut: 0n,
    estimatedCostUsd: new Prisma.Decimal(0),
    measurementIncompleteCount: 0,
    financialOperations: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function memberUsage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-usage-a',
    tenantUsageId: 'tenant-usage-a',
    familyId: 'family-a',
    memberProfileId: 'profile-a',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    messages: 0,
    blockedMessages: 0,
    tokensIn: 0n,
    tokensOut: 0n,
    estimatedCostUsd: new Prisma.Decimal(0),
    measurementIncompleteCount: 0,
    financialOperations: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reservationTx(overrides: Record<string, unknown> = {}) {
  return {
    aiUsageEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'event-a' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    aiTenantMonthlyUsage: {
      upsert: vi.fn().mockResolvedValue(tenantUsage()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    aiMemberMonthlyUsage: {
      upsert: vi.fn().mockResolvedValue(memberUsage()),
      update: vi.fn().mockResolvedValue({}),
    },
    aiUsageAlert: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe('período e custo de uso da IA', () => {
  it('usa meses civis UTC inclusive na borda da virada', () => {
    expect(utcMonthStart(NOW).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(nextUtcMonth(NOW).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(utcMonthStart(new Date('2026-09-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(parseUtcMonth('2028-02').toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(() => parseUtcMonth('2028-13')).toThrow('INVALID_USAGE_MONTH');
    expect(() => parseUtcMonth('0000-01')).toThrow('INVALID_USAGE_MONTH');
  });

  it('calcula preço decimal sem ponto flutuante e arredonda em microusd', () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, '0.15', '0.60').toFixed(6)).toBe('0.750000');
    expect(estimateCostUsd(10, 5, '0.15', '0.60').toFixed(6)).toBe('0.000005');
  });
});

describe('reserva mensal da IA', () => {
  it('consome uma unidade e cria ledger antes da chamada externa', async () => {
    const tx = reservationTx();
    const service = createService({});

    const result = await service.reserveInTransaction(
      tx as never,
      identity(),
      'update-a',
      101,
      NOW,
    );

    expect(result).toEqual({ kind: 'reserved', eventId: 'event-a', alerts: [] });
    expect(tx.aiTenantMonthlyUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-usage-a', messages: { lt: 2 } },
        data: {
          messages: { increment: 1 },
          measurementIncompleteCount: { increment: 1 },
        },
      }),
    );
    expect(tx.aiTenantMonthlyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          messageLimit: 2,
          nearLimitMessageCount: 1,
        }),
      }),
    );
    expect(tx.aiUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceUpdateId: 'update-a',
        sourceMessageId: 101,
        familyId: 'family-a',
        memberProfileId: 'profile-a',
        pricingVersion: 'pricing-v1',
      }),
    });
  });

  it('audita rejeição sem incrementar mensagens quando a cota está cheia', async () => {
    const tx = reservationTx({
      aiTenantMonthlyUsage: {
        upsert: vi.fn().mockResolvedValue(tenantUsage({ messages: 2, measurementIncompleteCount: 1 })),
        updateMany: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      aiUsageAlert: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = createService({});

    const result = await service.reserveInTransaction(
      tx as never,
      identity(),
      'update-blocked',
      102,
      NOW,
    );

    expect(result).toMatchObject({
      kind: 'quota_exceeded',
      eventId: 'event-a',
      messageLimit: 2,
      messageCount: 2,
    });
    expect(tx.aiTenantMonthlyUsage.updateMany).not.toHaveBeenCalled();
    expect(tx.aiUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: AiUsageEventStatus.BLOCKED_QUOTA,
        failureCode: 'monthly_quota_exhausted',
      }),
    });
    expect(tx.aiTenantMonthlyUsage.update).toHaveBeenCalledWith({
      where: { id: 'tenant-usage-a' },
      data: { blockedMessages: { increment: 1 } },
    });
  });

  it('não reaproveita um sourceUpdateId de outro tenant', async () => {
    const tx = reservationTx({
      aiUsageEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'event-a',
          ...identity(),
          status: AiUsageEventStatus.SUCCEEDED,
          startedAt: NOW,
          requestedModel: 'gpt-4o-mini',
          usedModel: 'gpt-4o-mini',
          providerRequestId: null,
          tenantUsage: tenantUsage(),
          messageLog: null,
        }),
        updateMany: vi.fn(),
      },
    });
    const service = createService({});

    await expect(
      service.reserveInTransaction(
        tx as never,
        identity({ familyId: 'family-b' }),
        'update-a',
        101,
        NOW,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('marca reserva abandonada como ambígua e nunca concede nova chamada', async () => {
    const tx = reservationTx({
      aiUsageEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'event-a',
          ...identity(),
          status: AiUsageEventStatus.IN_FLIGHT,
          startedAt: new Date('2026-08-31T23:50:00.000Z'),
          requestedModel: 'gpt-4o-mini',
          usedModel: null,
          providerRequestId: null,
          tenantUsage: tenantUsage({ messages: 1, measurementIncompleteCount: 1 }),
          messageLog: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const service = createService({});

    const result = await service.reserveInTransaction(
      tx as never,
      identity(),
      'update-a',
      101,
      NOW,
    );

    expect(result).toMatchObject({ kind: 'replay', status: AiUsageEventStatus.AMBIGUOUS });
    expect(tx.aiUsageEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'event-a', status: AiUsageEventStatus.IN_FLIGHT },
        data: expect.objectContaining({ failureCode: 'worker_recovery_ambiguous' }),
      }),
    );
  });
});

describe('finalização e leitura do consumo', () => {
  it('aplica tokens/custo e log exatamente uma vez por CAS', async () => {
    const event = {
      id: 'event-a',
      status: AiUsageEventStatus.IN_FLIGHT,
      tenantUsageId: 'tenant-usage-a',
      memberUsageId: 'member-usage-a',
      inputUsdPerMillionTokens: new Prisma.Decimal('0.15'),
      outputUsdPerMillionTokens: new Prisma.Decimal('0.60'),
      estimatedCostUsd: null,
    };
    const tx = {
      aiUsageEvent: {
        findUnique: vi.fn().mockResolvedValue(event),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      aiTenantMonthlyUsage: { update: vi.fn().mockResolvedValue({}) },
      aiMemberMonthlyUsage: { update: vi.fn().mockResolvedValue({}) },
      telegramMessageLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const service = createService(prisma);

    const result = await service.complete(
      'event-a',
      {
        parsed: financialResponse(),
        raw: financialResponse(),
        model: 'gpt-4o-mini-2024-07-18',
        requestId: 'req-a',
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
      },
      {
        chatId: 'chat-a',
        tgUserId: 'tg-a',
        messageId: 101,
        memberProfileId: 'profile-a',
        textRaw: 'gastei 10',
      },
      NOW,
    );

    expect(result.applied).toBe(true);
    expect(result.estimatedCostUsd?.toFixed(6)).toBe('0.750000');
    expect(tx.aiUsageEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'event-a', status: AiUsageEventStatus.IN_FLIGHT },
        data: expect.objectContaining({
          status: AiUsageEventStatus.SUCCEEDED,
          measurementComplete: true,
        }),
      }),
    );
    expect(tx.aiTenantMonthlyUsage.update).toHaveBeenCalledWith({
      where: { id: 'tenant-usage-a' },
      data: expect.objectContaining({
        tokensIn: { increment: 1_000_000n },
        tokensOut: { increment: 1_000_000n },
        measurementIncompleteCount: { decrement: 1 },
      }),
    });
    expect(tx.telegramMessageLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aiUsageEventId: 'event-a',
        costUsd: expect.any(Prisma.Decimal),
      }),
    });
  });

  it('preserva usage disponível em resposta inválida e usa categoria sanitizada', async () => {
    const tx = {
      aiUsageEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'event-a',
          status: AiUsageEventStatus.IN_FLIGHT,
          tenantUsageId: 'tenant-usage-a',
          memberUsageId: 'member-usage-a',
          inputUsdPerMillionTokens: new Prisma.Decimal('0.15'),
          outputUsdPerMillionTokens: new Prisma.Decimal('0.60'),
          estimatedCostUsd: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      aiTenantMonthlyUsage: { update: vi.fn().mockResolvedValue({}) },
      aiMemberMonthlyUsage: { update: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({ $transaction: vi.fn((callback) => callback(tx)) });

    await service.fail(
      'event-a',
      new AiProviderError('RESPONSE_INVALID', {
        model: 'gpt-4o-mini',
        requestId: 'req-a',
        tokensIn: 10,
        tokensOut: 5,
      }),
      NOW,
    );

    expect(tx.aiUsageEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AiUsageEventStatus.RESPONSE_INVALID,
          failureCode: 'provider_response_invalid',
          measurementComplete: true,
        }),
      }),
    );
  });

  it('expõe somente agregado familiar e do perfil autenticado, com custo decimal', async () => {
    const prisma = {
      aiTenantMonthlyUsage: {
        findUnique: vi.fn().mockResolvedValue({
          ...tenantUsage({
            messages: 2,
            tokensIn: 3_000_000_000n,
            tokensOut: 2_500_000_000n,
            estimatedCostUsd: new Prisma.Decimal('0.000039'),
            measurementIncompleteCount: 1,
            financialOperations: 1,
          }),
          memberUsages: [
            memberUsage({
              messages: 1,
              tokensIn: 2_200_000_000n,
              tokensOut: 2_300_000_000n,
              estimatedCostUsd: new Prisma.Decimal('0.000021'),
              measurementIncompleteCount: 0,
              financialOperations: 1,
            }),
          ],
        }),
      },
    };
    const service = createService(prisma);
    const context = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    const usage = await service.getCurrentUsage(context, NOW);

    expect(usage).toMatchObject({
      periodStart: '2026-08-01T00:00:00.000Z',
      resetAt: '2026-09-01T00:00:00.000Z',
      status: 'exhausted',
      messageLimit: 2,
      messageCount: 2,
      remaining: 0,
      measurementComplete: false,
      tenant: {
        messages: 2,
        inputTokens: 3_000_000_000,
        outputTokens: 2_500_000_000,
        estimatedCostUsd: '0.000039',
        financialOperationsCompleted: 1,
      },
      currentMember: {
        messages: 1,
        inputTokens: 2_200_000_000,
        outputTokens: 2_300_000_000,
        estimatedCostUsd: '0.000021',
        financialOperationsCompleted: 1,
      },
    });
    expect(prisma.aiTenantMonthlyUsage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          familyId_periodStart: {
            familyId: 'family-a',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
          },
        },
        include: {
          memberUsages: { where: { memberProfileId: 'profile-a' }, take: 1 },
        },
      }),
    );
  });

  it('recusa serializar total BigInt fora da faixa inteira segura do contrato HTTP', async () => {
    const prisma = {
      aiTenantMonthlyUsage: {
        findUnique: vi.fn().mockResolvedValue({
          ...tenantUsage({ tokensIn: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
          memberUsages: [],
        }),
      },
    };
    const service = createService(prisma);
    const context = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    await expect(service.getCurrentUsage(context, NOW)).rejects.toThrow(
      'AI_USAGE_TOKEN_TOTAL_OUT_OF_SAFE_RANGE',
    );
  });
});

describe('recuperação, alertas e retenção do ledger', () => {
  it('reconcilia eventos IN_FLIGHT abandonados sem depender do status do update', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const service = createService({ aiUsageEvent: { updateMany } });

    await expect(service.reconcileStaleEvents(NOW)).resolves.toEqual({ count: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: AiUsageEventStatus.IN_FLIGHT,
        startedAt: { lte: new Date('2026-08-31T23:54:59.999Z') },
      },
      data: {
        status: AiUsageEventStatus.AMBIGUOUS,
        failureCode: 'worker_recovery_ambiguous',
        finishedAt: NOW,
      },
    });
  });

  it('faz claim concorrente e conclui EXHAUSTED com supressão de NEAR_LIMIT na mesma transação', async () => {
    const claimUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const completionUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      aiUsageAlert: {
        findUnique: vi.fn().mockResolvedValue({
          tenantUsageId: 'tenant-usage-a',
          kind: 'EXHAUSTED',
          status: 'PENDING',
        }),
        updateMany: completionUpdate,
      },
    };
    const service = createService({
      aiUsageAlert: { updateMany: claimUpdate },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    await expect(service.claimAlertDelivery('alert-a', NOW)).resolves.toBe(true);
    expect(claimUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'alert-a',
          status: 'PENDING',
          OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date('2026-08-31T23:54:59.999Z') } }],
        }),
      }),
    );

    await service.markAlertDelivery('alert-a', true, NOW);
    expect(completionUpdate).toHaveBeenCalledTimes(2);
    expect(completionUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'alert-a', status: 'PENDING' },
        data: expect.objectContaining({ status: 'SENT', sentAt: NOW }),
      }),
    );
    expect(completionUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantUsageId: 'tenant-usage-a',
          kind: 'NEAR_LIMIT',
          status: 'PENDING',
        }),
        data: { status: 'SUPERSEDED', lastAttemptAt: NOW },
      }),
    );
  });

  it('redige o webhook terminal e remove o log bruto no mesmo ciclo de retenção', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      telegramMessageLog: { deleteMany },
      $executeRaw: vi.fn().mockResolvedValue(2),
    };
    const service = createService({
      $transaction: vi.fn((callback) => callback(tx)),
    });

    await expect(service.deleteExpiredMessageLogs(NOW)).resolves.toEqual({
      count: 1,
      redactedUpdates: 2,
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-08-01T23:59:59.999Z') } },
    });
  });

  it('contabiliza a operação no mês UTC do createdAt recebido', async () => {
    const tx = reservationTx({
      aiUsageEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: 'event-a' }),
      },
    });
    const service = createService({});
    const occurredAt = new Date('2026-09-01T00:00:00.000Z');

    await service.recordFinancialOperationInTransaction(
      tx as never,
      'event-a',
      identity(),
      occurredAt,
    );

    expect(tx.aiTenantMonthlyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          familyId_periodStart: {
            familyId: 'family-a',
            periodStart: occurredAt,
          },
        },
      }),
    );
  });
});

function financialResponse() {
  return {
    intent: 'EXPENSE' as const,
    confidence: 1,
    amount: { value: 10, currency: 'BRL' as const },
    date: '2026-08-31',
    description: 'Mercado',
    accountHint: null,
    categoryHint: null,
    installments: null,
    missingFields: [],
  };
}
