import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AiUsageAlertKind,
  AiUsageEventStatus,
  Prisma,
  PrismaClient,
  TelegramFinancialOperationKind,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AiUsageService,
  type AiUsageIdentity,
} from '../../src/modules/telegram/ai-usage.service';
import { TelegramAuthCodesController } from '../../src/modules/telegram/telegram-auth-codes.controller';
import { TelegramService } from '../../src/modules/telegram/telegram.service';
import { TransactionsService } from '../../src/modules/transactions/transactions.service';
import { TenantContext } from '../../src/shared/tenant-context';
import { TenantOwnerGuard } from '../../src/shared/tenant-owner.guard';

const usageHttpPrincipals = new Map<string, Record<string, unknown>>();

class FixtureCookieTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      cookies?: Record<string, string>;
      user?: Record<string, unknown>;
    }>();
    const session = request.cookies?.usage_session;
    const principal = session ? usageHttpPrincipals.get(session) : undefined;
    if (!principal) throw new UnauthorizedException('Sessão de teste inválida');
    request.user = principal;
    return true;
  }
}

describe('quota de IA com PostgreSQL real', () => {
  let prisma: PrismaClient;
  let concurrentPrisma: PrismaClient;

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }
    prisma = new PrismaClient();
    concurrentPrisma = new PrismaClient();
  });

  afterAll(async () => {
    await Promise.all([prisma?.$disconnect(), concurrentPrisma?.$disconnect()]);
  });

  it('concede exatamente a última vaga e mantém tenants isolados sob concorrência', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createUsageTenant(prisma, 'quota-a'),
      createUsageTenant(prisma, 'quota-b'),
    ]);
    const [updateA1, updateA2, updateB] = await Promise.all([
      createUpdate(prisma),
      createUpdate(prisma),
      createUpdate(prisma),
    ]);
    const serviceA = createUsageService(prisma, 1);
    const serviceAConcurrent = createUsageService(concurrentPrisma, 1);
    const serviceB = createUsageService(prisma, 1);

    const [resultA1, resultA2, resultB] = await Promise.all([
      reserveWithLock(prisma, serviceA, tenantA, updateA1),
      reserveWithLock(concurrentPrisma, serviceAConcurrent, tenantA, updateA2),
      reserveWithLock(prisma, serviceB, tenantB, updateB),
    ]);

    expect([resultA1.kind, resultA2.kind].sort()).toEqual(['quota_exceeded', 'reserved']);
    expect(resultB.kind).toBe('reserved');

    const [usageA, usageB, eventsA, eventsB] = await Promise.all([
      prisma.aiTenantMonthlyUsage.findFirstOrThrow({ where: { familyId: tenantA.familyId } }),
      prisma.aiTenantMonthlyUsage.findFirstOrThrow({ where: { familyId: tenantB.familyId } }),
      prisma.aiUsageEvent.findMany({ where: { familyId: tenantA.familyId } }),
      prisma.aiUsageEvent.findMany({ where: { familyId: tenantB.familyId } }),
    ]);
    expect(usageA).toMatchObject({ messages: 1, blockedMessages: 1, messageLimit: 1 });
    expect(usageB).toMatchObject({ messages: 1, blockedMessages: 0, messageLimit: 1 });
    expect(eventsA.map((event) => event.status).sort()).toEqual(['BLOCKED_QUOTA', 'IN_FLIGHT']);
    expect(eventsB.map((event) => event.status)).toEqual(['IN_FLIGHT']);
  });

  it('serializa o mesmo update em uma única reserva e recusa replay cross-tenant', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createUsageTenant(prisma, 'replay-a'),
      createUsageTenant(prisma, 'replay-b'),
    ]);
    const updateId = await createUpdate(prisma);
    const serviceA = createUsageService(prisma, 2);
    const serviceConcurrent = createUsageService(concurrentPrisma, 2);

    const [first, second] = await Promise.all([
      reserveWithLock(prisma, serviceA, tenantA, updateId),
      reserveWithLock(concurrentPrisma, serviceConcurrent, tenantA, updateId),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(['replay', 'reserved']);
    await expect(
      reserveWithLock(prisma, serviceA, tenantB, updateId),
    ).rejects.toThrow('Update de IA pertence a outro contexto');

    await expect(
      prisma.aiUsageEvent.count({ where: { sourceUpdateId: updateId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.aiTenantMonthlyUsage.findFirstOrThrow({ where: { familyId: tenantA.familyId } }),
    ).resolves.toMatchObject({ messages: 1, blockedMessages: 0 });
    await expect(
      prisma.aiTenantMonthlyUsage.findFirst({ where: { familyId: tenantB.familyId } }),
    ).resolves.toBeNull();
  });

  it('finaliza o mesmo evento uma vez sob concorrência e agrega somente o vencedor', async () => {
    const tenant = await createUsageTenant(prisma, 'completion-race');
    const updateId = await createUpdate(prisma);
    const serviceA = createUsageService(prisma, 2);
    const serviceB = createUsageService(concurrentPrisma, 2);
    const reservation = await reserveWithLock(prisma, serviceA, tenant, updateId);
    if (reservation.kind !== 'reserved') throw new Error('EXPECTED_RESERVED_EVENT');
    const aggregateBaseline = 2_147_483_645n;
    await Promise.all([
      prisma.aiTenantMonthlyUsage.updateMany({
        where: { familyId: tenant.familyId },
        data: { tokensIn: aggregateBaseline, tokensOut: aggregateBaseline },
      }),
      prisma.aiMemberMonthlyUsage.updateMany({
        where: { familyId: tenant.familyId },
        data: { tokensIn: aggregateBaseline, tokensOut: aggregateBaseline },
      }),
    ]);
    const resultA = aiResult(10, 5, 'A');
    const resultB = aiResult(20, 7, 'B');
    const message = {
      chatId: tenant.chatId,
      tgUserId: tenant.tgUserId,
      messageId: 101,
      memberProfileId: tenant.memberProfileId,
      textRaw: 'corrida de conclusão',
    };

    const completed = await Promise.all([
      serviceA.complete(reservation.eventId, resultA, message),
      serviceB.complete(reservation.eventId, resultB, message),
    ]);
    expect(completed.map((item) => item.applied).sort()).toEqual([false, true]);

    const [event, tenantUsage, memberUsage, logs] = await Promise.all([
      prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: reservation.eventId } }),
      prisma.aiTenantMonthlyUsage.findFirstOrThrow({ where: { familyId: tenant.familyId } }),
      prisma.aiMemberMonthlyUsage.findFirstOrThrow({ where: { familyId: tenant.familyId } }),
      prisma.telegramMessageLog.findMany({ where: { aiUsageEventId: reservation.eventId } }),
    ]);
    expect(logs).toHaveLength(1);
    expect([10, 20]).toContain(event.tokensIn);
    expect([5, 7]).toContain(event.tokensOut);
    expect(tenantUsage.tokensIn).toBe(aggregateBaseline + BigInt(event.tokensIn ?? 0));
    expect(memberUsage.tokensIn).toBe(aggregateBaseline + BigInt(event.tokensIn ?? 0));
    expect(logs[0].tokensIn).toBe(event.tokensIn);
    expect(tenantUsage.tokensOut).toBe(aggregateBaseline + BigInt(event.tokensOut ?? 0));
    expect(memberUsage.tokensOut).toBe(aggregateBaseline + BigInt(event.tokensOut ?? 0));
    expect(tenantUsage.estimatedCostUsd.toFixed(6)).toBe(event.estimatedCostUsd?.toFixed(6));
    expect(memberUsage.estimatedCostUsd.toFixed(6)).toBe(event.estimatedCostUsd?.toFixed(6));
    expect(tenantUsage.measurementIncompleteCount).toBe(0);
    expect(memberUsage.measurementIncompleteCount).toBe(0);
  });

  it('contabiliza uma operação financeira uma única vez no replay do evento concluído', async () => {
    const tenant = await createUsageTenant(prisma, 'operation-replay');
    const updateId = await createUpdate(prisma);
    const usageService = createUsageService(prisma, 3);
    const reservation = await reserveWithLock(prisma, usageService, tenant, updateId);
    if (reservation.kind !== 'reserved') throw new Error('EXPECTED_RESERVED_EVENT');

    await usageService.complete(reservation.eventId, aiResult(12, 4, 'operation'), {
      chatId: tenant.chatId,
      tgUserId: tenant.tgUserId,
      messageId: 101,
      memberProfileId: tenant.memberProfileId,
      textRaw: 'operação idempotente',
    });

    const linkedContext = {
      chatId: tenant.chatId,
      tgUserId: tenant.tgUserId,
      memberProfileId: tenant.memberProfileId,
      familyId: tenant.familyId,
      tenant: tenantContext(tenant),
    };
    const telegramService = new TelegramService(
      {} as never,
      prisma as never,
      { sendMessage: vi.fn() } as never,
      { parseFinancialMessage: vi.fn() } as never,
      new TransactionsService(prisma as never),
      { createInTransaction: vi.fn(), removeTelegramCreatedPlanInTransaction: vi.fn() } as never,
      {} as never,
      {} as never,
      usageService,
    );
    const internalService = telegramService as unknown as {
      resolveLinkedContextFromIds: unknown;
      tryCreateFinancialOperation(
        updateId: string,
        context: unknown,
        draft: unknown,
        idempotencyKey: string,
        pendingConfirmationId?: string,
        aiUsageEventId?: string,
      ): Promise<{
        duplicate: boolean;
        alreadyExisted: boolean;
        operation: { id: string; createdAt: Date } | null;
      }>;
    };
    internalService.resolveLinkedContextFromIds = vi.fn().mockResolvedValue(linkedContext);

    const idempotencyKey = `tg:msg:${tenant.chatId}:101`;
    const draft = {
      action: 'TRANSACTION',
      transactionType: 'expense',
      amountCents: 1_250,
      applicationDate: '2026-08-01',
      referenceMonth: '2026-08-01',
      description: 'Operação contabilizada uma vez',
      sourceMessageId: 101,
    };
    const first = await internalService.tryCreateFinancialOperation(
      updateId,
      linkedContext,
      draft,
      idempotencyKey,
      undefined,
      reservation.eventId,
    );
    const replay = await internalService.tryCreateFinancialOperation(
      updateId,
      linkedContext,
      draft,
      idempotencyKey,
      undefined,
      reservation.eventId,
    );

    expect(first).toMatchObject({ duplicate: false, alreadyExisted: false });
    expect(replay).toMatchObject({ duplicate: false, alreadyExisted: true });
    expect(replay.operation?.id).toBe(first.operation?.id);
    if (!first.operation) throw new Error('EXPECTED_FINANCIAL_OPERATION');

    const periodStart = new Date(
      Date.UTC(first.operation.createdAt.getUTCFullYear(), first.operation.createdAt.getUTCMonth(), 1),
    );
    const [tenantUsage, memberUsage, operations, transactions] = await Promise.all([
      prisma.aiTenantMonthlyUsage.findUniqueOrThrow({
        where: { familyId_periodStart: { familyId: tenant.familyId, periodStart } },
      }),
      prisma.aiMemberMonthlyUsage.findUniqueOrThrow({
        where: {
          familyId_memberProfileId_periodStart: {
            familyId: tenant.familyId,
            memberProfileId: tenant.memberProfileId,
            periodStart,
          },
        },
      }),
      prisma.telegramFinancialOperation.findMany({
        where: { aiUsageEventId: reservation.eventId },
      }),
      prisma.transaction.findMany({ where: { externalId: idempotencyKey } }),
    ]);
    expect(operations).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(tenantUsage.financialOperations).toBe(1);
    expect(memberUsage.financialOperations).toBe(1);
  });

  it('expõe status e breakdown isolados para dois tenants', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createUsageTenant(prisma, 'status-a'),
      createUsageTenant(prisma, 'status-b'),
    ]);
    const [updateA, updateB] = await Promise.all([
      createUpdate(prisma),
      createUpdate(prisma),
    ]);
    const service = createUsageService(prisma, 4);
    await reserveWithLock(prisma, service, tenantA, updateA);
    await reserveWithLock(prisma, service, tenantB, updateB);

    const [statusA, statusB, membersA, membersB] = await Promise.all([
      service.getCurrentUsage(tenantContext(tenantA)),
      service.getCurrentUsage(tenantContext(tenantB)),
      service.getMemberBreakdown(tenantContext(tenantA)),
      service.getMemberBreakdown(tenantContext(tenantB)),
    ]);

    expect(statusA).toMatchObject({ messageCount: 1, currentMember: { messages: 1 } });
    expect(statusB).toMatchObject({ messageCount: 1, currentMember: { messages: 1 } });
    expect(membersA.members.map((member) => member.displayName)).toEqual(['status-a']);
    expect(membersB.members.map((member) => member.displayName)).toEqual(['status-b']);
    expect(membersA.members).not.toEqual(membersB.members);
  });

  it('aplica isolamento, owner guard e validação nas rotas HTTP de uso', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createUsageTenant(prisma, 'http-a'),
      createUsageTenant(prisma, 'http-b'),
    ]);
    const [updateA1, updateA2, updateB] = await Promise.all([
      createUpdate(prisma),
      createUpdate(prisma),
      createUpdate(prisma),
    ]);
    const usageService = createUsageService(prisma, 5);
    await reserveWithLock(prisma, usageService, tenantA, updateA1);
    await reserveWithLock(prisma, usageService, tenantA, updateA2);
    await reserveWithLock(prisma, usageService, tenantB, updateB);

    const ownerAToken = randomUUID();
    const memberAToken = randomUUID();
    const ownerBToken = randomUUID();
    usageHttpPrincipals.set(ownerAToken, httpPrincipal(tenantA, 'owner'));
    usageHttpPrincipals.set(memberAToken, httpPrincipal(tenantA, 'member'));
    usageHttpPrincipals.set(ownerBToken, httpPrincipal(tenantB, 'owner'));

    const telegramFacade = {
      getStatus: async (context: TenantContext) => ({
        group: { authorized: false },
        member: { linked: false },
        usage: await usageService.getCurrentUsage(context),
      }),
      getMemberUsage: (context: TenantContext, month?: string) =>
        usageService.getMemberBreakdown(context, month),
    };
    const module = await Test.createTestingModule({
      controllers: [TelegramAuthCodesController],
      providers: [
        TenantOwnerGuard,
        { provide: TelegramService, useValue: telegramFacade },
        { provide: APP_GUARD, useClass: FixtureCookieTenantGuard },
      ],
    }).compile();
    const controller = module.get(TelegramAuthCodesController);
    (
      controller as unknown as {
        telegramService: typeof telegramFacade;
      }
    ).telegramService = telegramFacade;
    const app: INestApplication = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const [statusAResponse, statusBResponse] = await Promise.all([
        fetchWithUsageCookie(`${baseUrl}/telegram/status`, ownerAToken),
        fetchWithUsageCookie(`${baseUrl}/telegram/status`, ownerBToken),
      ]);
      expect(statusAResponse.status).toBe(200);
      expect(statusBResponse.status).toBe(200);
      const statusA = await statusAResponse.json();
      const statusB = await statusBResponse.json();
      expect(statusA.usage).toMatchObject({ messageCount: 2, currentMember: { messages: 2 } });
      expect(statusB.usage).toMatchObject({ messageCount: 1, currentMember: { messages: 1 } });

      const membersAResponse = await fetchWithUsageCookie(
        `${baseUrl}/telegram/usage/members`,
        ownerAToken,
      );
      expect(membersAResponse.status).toBe(200);
      const membersA = await membersAResponse.json();
      expect(membersA.members.map((member: { displayName: string }) => member.displayName)).toEqual([
        'http-a',
      ]);
      expect(JSON.stringify(membersA)).not.toContain('http-b');

      const membersBResponse = await fetchWithUsageCookie(
        `${baseUrl}/telegram/usage/members`,
        ownerBToken,
      );
      expect(membersBResponse.status).toBe(200);
      const membersB = await membersBResponse.json();
      expect(membersB.members.map((member: { displayName: string }) => member.displayName)).toEqual([
        'http-b',
      ]);
      expect(JSON.stringify(membersB)).not.toContain('http-a');

      const memberDenied = await fetchWithUsageCookie(
        `${baseUrl}/telegram/usage/members`,
        memberAToken,
      );
      expect(memberDenied.status).toBe(403);

      const invalidMonth = await fetchWithUsageCookie(
        `${baseUrl}/telegram/usage/members?month=0000-01`,
        ownerAToken,
      );
      expect(invalidMonth.status).toBe(400);
    } finally {
      usageHttpPrincipals.clear();
      await app.close();
    }
  });

  it('rejeita cross-month, cross-member e links operacionais cross-tenant no banco', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createUsageTenant(prisma, 'constraints-a'),
      createUsageTenant(prisma, 'constraints-b'),
    ]);
    const secondProfileId = await createAdditionalProfile(prisma, tenantA, 'constraints-a-2');
    const august = new Date('2026-08-01T00:00:00.000Z');
    const september = new Date('2026-09-01T00:00:00.000Z');
    const augustUsage = await prisma.aiTenantMonthlyUsage.create({
      data: usagePeriodData(tenantA.familyId, august),
    });
    const septemberUsage = await prisma.aiTenantMonthlyUsage.create({
      data: usagePeriodData(tenantA.familyId, september),
    });

    await expect(
      prisma.aiMemberMonthlyUsage.create({
        data: {
          tenantUsageId: septemberUsage.id,
          familyId: tenantA.familyId,
          memberProfileId: tenantA.memberProfileId,
          periodStart: august,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    const memberUsage = await prisma.aiMemberMonthlyUsage.create({
      data: {
        tenantUsageId: augustUsage.id,
        familyId: tenantA.familyId,
        memberProfileId: tenantA.memberProfileId,
        periodStart: august,
      },
    });
    const updateId = await createUpdate(prisma);
    const eventData = usageEventData(
      tenantA,
      updateId,
      augustUsage.id,
      memberUsage.id,
    );

    await expect(
      prisma.aiUsageEvent.create({
        data: { ...eventData, memberProfileId: secondProfileId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    const event = await prisma.aiUsageEvent.create({ data: eventData });
    await expect(
      prisma.telegramFinancialOperation.create({
        data: {
          idempotencyKey: randomUUID(),
          kind: TelegramFinancialOperationKind.TRANSACTION,
          status: 'UNDONE',
          memberProfileId: tenantB.memberProfileId,
          tgUserId: tenantB.tgUserId,
          chatId: tenantB.chatId,
          aiUsageEventId: event.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('torna identidade, preço e estado terminal do evento imutáveis', async () => {
    const tenant = await createUsageTenant(prisma, 'immutable');
    const updateId = await createUpdate(prisma);
    const { event } = await createUsageGraph(prisma, tenant, updateId);

    await createUsageService(prisma, 200).complete(
      event.id,
      {
        parsed: testFinancialResponse(),
        raw: testFinancialResponse(),
        model: 'gpt-4o-mini',
        tokensIn: 10,
        tokensOut: 5,
      },
      {
        chatId: tenant.chatId,
        tgUserId: tenant.tgUserId,
        messageId: 101,
        memberProfileId: tenant.memberProfileId,
        textRaw: 'imutável',
      },
    );
    await expect(
      prisma.aiUsageEvent.update({
        where: { id: event.id },
        data: { status: AiUsageEventStatus.PROVIDER_FAILED },
      }),
    ).rejects.toThrow(/AI_USAGE_EVENT_TERMINAL_IMMUTABLE/u);
    await expect(
      prisma.aiUsageEvent.update({
        where: { id: event.id },
        data: { pricingVersion: 'rewritten-price' },
      }),
    ).rejects.toThrow(/AI_USAGE_EVENT_IDENTITY_IMMUTABLE|AI_USAGE_EVENT_TERMINAL_IMMUTABLE/u);
  });

  it('entrega um alerta uma vez sob concorrência e suprime proximidade ao esgotar', async () => {
    const tenant = await createUsageTenant(prisma, 'alert-race');
    const updateId = await createUpdate(prisma);
    const { tenantUsage } = await createUsageGraph(prisma, tenant, updateId);
    const near = await prisma.aiUsageAlert.create({
      data: {
        tenantUsageId: tenantUsage.id,
        familyId: tenant.familyId,
        kind: AiUsageAlertKind.NEAR_LIMIT,
      },
    });
    const exhausted = await prisma.aiUsageAlert.create({
      data: {
        tenantUsageId: tenantUsage.id,
        familyId: tenant.familyId,
        kind: AiUsageAlertKind.EXHAUSTED,
      },
    });
    const serviceA = createUsageService(prisma, 2);
    const serviceB = createUsageService(concurrentPrisma, 2);

    const claims = await Promise.all([
      serviceA.claimAlertDelivery(exhausted.id),
      serviceB.claimAlertDelivery(exhausted.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await serviceA.markAlertDelivery(exhausted.id, true);

    const [persistedNear, persistedExhausted] = await Promise.all([
      prisma.aiUsageAlert.findUniqueOrThrow({ where: { id: near.id } }),
      prisma.aiUsageAlert.findUniqueOrThrow({ where: { id: exhausted.id } }),
    ]);
    expect(persistedNear.status).toBe('SUPERSEDED');
    expect(persistedExhausted.status).toBe('SENT');

    await prisma.aiTenantMonthlyUsage.update({
      where: { id: tenantUsage.id },
      data: { messages: tenantUsage.messageLimit },
    });
    const blockedUpdate = await createUpdate(prisma);
    await expect(
      reserveWithLock(prisma, serviceA, tenant, blockedUpdate),
    ).resolves.toMatchObject({ kind: 'quota_exceeded' });
  });

  it('remove texto bruto de webhook novo e legado no TTL sem apagar o ledger', async () => {
    const tenant = await createUsageTenant(prisma, 'redaction');
    const now = new Date('2026-08-01T12:00:00.000Z');
    const old = new Date('2026-06-01T12:00:00.000Z');
    const newUpdateId = await createUpdate(prisma, telegramPayload(tenant, 101, 'segredo novo'));
    const legacyUpdateId = await createUpdate(prisma, telegramPayload(tenant, 102, 'segredo legado'));
    const { event } = await createUsageGraph(
      prisma,
      tenant,
      newUpdateId,
      old,
      AiUsageEventStatus.SUCCEEDED,
    );
    await Promise.all([
      prisma.telegramUpdate.update({
        where: { updateId: newUpdateId },
        data: { status: 'succeeded', receivedAt: old, processedAt: old },
      }),
      prisma.telegramUpdate.update({
        where: { updateId: legacyUpdateId },
        data: { status: 'succeeded', receivedAt: old, processedAt: old },
      }),
    ]);
    await Promise.all([
      prisma.telegramMessageLog.create({
        data: {
          chatId: tenant.chatId,
          tgUserId: tenant.tgUserId,
          messageId: 101,
          memberProfileId: tenant.memberProfileId,
          textRaw: 'segredo novo',
          aiUsageEventId: event.id,
          createdAt: old,
        },
      }),
      prisma.telegramMessageLog.create({
        data: {
          chatId: tenant.chatId,
          tgUserId: tenant.tgUserId,
          messageId: 102,
          memberProfileId: tenant.memberProfileId,
          textRaw: 'segredo legado',
          createdAt: old,
        },
      }),
    ]);
    const service = createUsageService(prisma, 2);

    await expect(service.deleteExpiredMessageLogs(now)).resolves.toEqual({
      count: 2,
      redactedUpdates: 2,
    });
    await expect(service.deleteExpiredMessageLogs(now)).resolves.toEqual({
      count: 0,
      redactedUpdates: 0,
    });

    const [newUpdate, legacyUpdate, eventStillPresent] = await Promise.all([
      prisma.telegramUpdate.findUniqueOrThrow({ where: { updateId: newUpdateId } }),
      prisma.telegramUpdate.findUniqueOrThrow({ where: { updateId: legacyUpdateId } }),
      prisma.aiUsageEvent.findUnique({ where: { id: event.id } }),
    ]);
    for (const update of [newUpdate, legacyUpdate]) {
      const serialized = JSON.stringify(update.payload);
      expect(serialized).toContain('telegram_payload_retention_expired');
      expect(serialized).not.toMatch(/segredo|username-privado/iu);
    }
    expect(eventStillPresent).not.toBeNull();
  });
});

interface UsageTenant extends AiUsageIdentity {
  userId: string;
  label: string;
}

async function createUsageTenant(prisma: PrismaClient, label: string): Promise<UsageTenant> {
  const suffix = randomUUID();
  const familyId = randomUUID();
  const userId = randomUUID();
  const memberProfileId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.family.create({ data: { id: familyId, name: `${label}-${suffix}` } });
    await tx.user.create({
      data: {
        id: userId,
        email: `${label}-${suffix}@example.test`,
        name: label,
        familyId,
      },
    });
    await tx.memberProfile.create({
      data: {
        id: memberProfileId,
        displayName: label,
        userId,
        familyId,
      },
    });
    await tx.family.update({ where: { id: familyId }, data: { ownerUserId: userId } });
  });
  return {
    familyId,
    userId,
    memberProfileId,
    chatId: `chat-${suffix}`,
    tgUserId: `tg-${suffix}`,
    label,
  };
}

async function createUpdate(prisma: PrismaClient, payload?: Prisma.InputJsonValue) {
  const updateId = randomUUID();
  await prisma.telegramUpdate.create({
    data: { updateId, payload: payload ?? { update_id: updateId } },
  });
  return updateId;
}

function tenantContext(tenant: UsageTenant) {
  return TenantContext.fromAuthenticatedUser({
    id: tenant.userId,
    email: `${tenant.label}@example.test`,
    platformRole: 'user',
    tenantRole: 'owner',
    familyId: tenant.familyId,
    profileId: tenant.memberProfileId,
  });
}

function httpPrincipal(tenant: UsageTenant, tenantRole: 'owner' | 'member') {
  return {
    id: tenant.userId,
    email: `${tenant.label}@example.test`,
    platformRole: 'user',
    tenantRole,
    familyId: tenant.familyId,
    profileId: tenant.memberProfileId,
    requiredAction: null,
    subscriptionAccess: {
      effectiveStatus: 'active',
      accessAllowed: true,
      reason: 'PAID_ACCESS',
    },
  };
}

function fetchWithUsageCookie(url: string, session: string) {
  return fetch(url, { headers: { cookie: `usage_session=${session}` } });
}

async function createAdditionalProfile(
  prisma: PrismaClient,
  tenant: UsageTenant,
  label: string,
) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.test`,
      name: label,
      familyId: tenant.familyId,
    },
  });
  const profile = await prisma.memberProfile.create({
    data: {
      displayName: label,
      userId: user.id,
      familyId: tenant.familyId,
    },
  });
  return profile.id;
}

function usagePeriodData(familyId: string, periodStart: Date) {
  return {
    familyId,
    periodStart,
    planCode: 'integration-v1',
    messageLimit: 200,
    nearLimitMessageCount: 160,
  };
}

function usageEventData(
  tenant: UsageTenant,
  sourceUpdateId: string,
  tenantUsageId: string,
  memberUsageId: string,
) {
  return {
    sourceUpdateId,
    sourceMessageId: 101,
    familyId: tenant.familyId,
    tenantUsageId,
    memberUsageId,
    memberProfileId: tenant.memberProfileId,
    chatId: tenant.chatId,
    tgUserId: tenant.tgUserId,
    provider: 'openai',
    requestedModel: 'gpt-4o-mini',
    pricingVersion: 'integration-v1',
    inputUsdPerMillionTokens: '0.150000',
    outputUsdPerMillionTokens: '0.600000',
  };
}

async function createUsageGraph(
  prisma: PrismaClient,
  tenant: UsageTenant,
  sourceUpdateId: string,
  startedAt = new Date(),
  status: AiUsageEventStatus = AiUsageEventStatus.IN_FLIGHT,
) {
  const periodStart = new Date(
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), 1),
  );
  return prisma.$transaction(async (tx) => {
    const tenantUsage = await tx.aiTenantMonthlyUsage.create({
      data: {
        ...usagePeriodData(tenant.familyId, periodStart),
        messages: 1,
        measurementIncompleteCount: 1,
      },
    });
    const memberUsage = await tx.aiMemberMonthlyUsage.create({
      data: {
        tenantUsageId: tenantUsage.id,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
        periodStart,
        messages: 1,
        measurementIncompleteCount: 1,
      },
    });
    const event = await tx.aiUsageEvent.create({
      data: {
        ...usageEventData(tenant, sourceUpdateId, tenantUsage.id, memberUsage.id),
        status,
        startedAt,
        finishedAt: status === AiUsageEventStatus.IN_FLIGHT ? null : startedAt,
      },
    });
    return { tenantUsage, memberUsage, event };
  });
}

function telegramPayload(tenant: UsageTenant, messageId: number, text: string) {
  return {
    update_id: randomUUID(),
    message: {
      message_id: messageId,
      chat: { id: tenant.chatId },
      from: { id: tenant.tgUserId, username: 'username-privado' },
      text,
    },
  };
}

function testFinancialResponse() {
  return {
    intent: 'EXPENSE' as const,
    confidence: 1,
    amount: { value: 10, currency: 'BRL' as const },
    date: '2026-08-01',
    description: 'Teste',
    accountHint: null,
    categoryHint: null,
    installments: null,
    missingFields: [],
  };
}

function aiResult(tokensIn: number, tokensOut: number, label: string) {
  const parsed = { ...testFinancialResponse(), description: `Teste ${label}` };
  return {
    parsed,
    raw: parsed,
    model: 'gpt-4o-mini',
    requestId: `request-${label}`,
    tokensIn,
    tokensOut,
  };
}

function createUsageService(prisma: PrismaClient, limit: number) {
  const config = {
    get: vi.fn((key: string) => {
      const values: Record<string, unknown> = {
        AI_PROVIDER: 'openai',
        OPENAI_MODEL: 'gpt-4o-mini',
        OPENAI_PRICING_VERSION: 'integration-pricing-v1',
        OPENAI_INPUT_USD_PER_MILLION_TOKENS: '0.15',
        OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: '0.60',
        TELEGRAM_AI_PLAN_CODE: 'monthly-card-v1',
        TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT: limit,
        TELEGRAM_AI_WARNING_PERCENT: 80,
        TELEGRAM_UPDATE_RECOVERY_MINUTES: 5,
      };
      return values[key];
    }),
  };
  return new AiUsageService(config as never, prisma as never);
}

function reserveWithLock(
  prisma: PrismaClient,
  service: AiUsageService,
  identity: AiUsageIdentity,
  updateId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${identity.familyId} FOR UPDATE
      `;
      if (locked.length !== 1) throw new Error('FAMILY_NOT_FOUND');
      return service.reserveInTransaction(tx, identity, updateId, 101);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
