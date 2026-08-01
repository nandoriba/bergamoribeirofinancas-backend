import {
  PlatformRole,
  Prisma,
  PrismaClient,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
  TelegramAuthCodeKind,
  TelegramPendingStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SubscriptionAccessPolicy } from '../../src/modules/payments/subscription-access.policy';
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from '../../src/modules/payments/subscription-access.projection';
import { TelegramService } from '../../src/modules/telegram/telegram.service';

interface TenantFixture {
  familyId: string;
  subscriptionId: string;
  ownerId: string;
  ownerProfileId: string;
  memberId: string;
  memberProfileId: string;
}

describe('Telegram multi-tenant com PostgreSQL real', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('mantém dois tenants em grupos distintos e recusa vínculos cross-tenant no banco', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createTenant(prisma, 'Telegram A'),
      createTenant(prisma, 'Telegram B'),
    ]);
    const [groupA, groupB] = await Promise.all([
      prisma.telegramAuthorizedGroup.create({
        data: {
          chatId: `chat-a-${randomUUID()}`,
          familyId: tenantA.familyId,
          authorizedByUserId: tenantA.ownerId,
        },
      }),
      prisma.telegramAuthorizedGroup.create({
        data: {
          chatId: `chat-b-${randomUUID()}`,
          familyId: tenantB.familyId,
          authorizedByUserId: tenantB.ownerId,
        },
      }),
    ]);
    await Promise.all([
      prisma.telegramUserLink.create({
        data: {
          tgUserId: `tg-a-${randomUUID()}`,
          chatId: groupA.chatId,
          familyId: tenantA.familyId,
          memberProfileId: tenantA.memberProfileId,
        },
      }),
      prisma.telegramUserLink.create({
        data: {
          tgUserId: `tg-b-${randomUUID()}`,
          chatId: groupB.chatId,
          familyId: tenantB.familyId,
          memberProfileId: tenantB.memberProfileId,
        },
      }),
    ]);

    await expect(
      prisma.telegramUserLink.create({
        data: {
          tgUserId: `cross-${randomUUID()}`,
          chatId: groupA.chatId,
          familyId: tenantA.familyId,
          memberProfileId: tenantB.memberProfileId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await expect(
      prisma.telegramAuthorizedGroup.create({
        data: {
          chatId: `second-a-${randomUUID()}`,
          familyId: tenantA.familyId,
          authorizedByUserId: tenantA.ownerId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      prisma.telegramAuthorizedGroup.create({
        data: {
          chatId: groupA.chatId,
          familyId: tenantB.familyId,
          authorizedByUserId: tenantB.ownerId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('substitui grupo, vínculos e confirmações no mesmo commit', async () => {
    const tenant = await createTenant(prisma, 'Replace commit');
    const oldGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `old-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const oldLink = await prisma.telegramUserLink.create({
      data: {
        tgUserId: `tg-${randomUUID()}`,
        chatId: oldGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const pending = await prisma.telegramPendingConfirmation.create({
      data: {
        id: randomUUID(),
        chatId: oldGroup.chatId,
        memberProfileId: tenant.memberProfileId,
        tgUserId: oldLink.tgUserId,
        payload: {
          kind: 'UNDO_OPERATION',
          operationId: '00000000-0000-4000-8000-000000000001',
        },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const updateId = `replace-${randomUUID()}`;
    await prisma.telegramUpdate.create({ data: { updateId, payload: { update_id: updateId } } });
    const code = await prisma.telegramAuthCode.create({
      data: {
        code: `GROUP-${randomUUID()}`,
        kind: TelegramAuthCodeKind.GROUP,
        userId: tenant.ownerId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const telegram = { sendMessage: vi.fn().mockResolvedValue({}) };
    const service = createService(prisma, telegram);
    const newChatId = `new-${randomUUID()}`;

    await (
      service as unknown as {
        authorizeGroup(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).authorizeGroup(
      updateId,
      { chat: { id: newChatId, type: 'supergroup' }, message_id: 2, from: { id: 10 } },
      code.code,
    );

    const [persistedOldGroup, persistedOldLink, persistedPending, persistedCode, newGroup] = await Promise.all([
      prisma.telegramAuthorizedGroup.findUniqueOrThrow({ where: { id: oldGroup.id } }),
      prisma.telegramUserLink.findUniqueOrThrow({ where: { id: oldLink.id } }),
      prisma.telegramPendingConfirmation.findUniqueOrThrow({ where: { id: pending.id } }),
      prisma.telegramAuthCode.findUniqueOrThrow({ where: { id: code.id } }),
      prisma.telegramAuthorizedGroup.findUniqueOrThrow({ where: { chatId: newChatId } }),
    ]);
    expect(persistedOldGroup.revokedAt).toBeInstanceOf(Date);
    expect(persistedOldLink.revokedAt).toBeInstanceOf(Date);
    expect(persistedPending.status).toBe(TelegramPendingStatus.CANCELLED);
    expect(persistedCode.consumedAt).toBeInstanceOf(Date);
    expect(newGroup.familyId).toBe(tenant.familyId);
  });

  it('revoga o vínculo Telegram anterior ao religar o mesmo perfil com outro usuário', async () => {
    const tenant = await createTenant(prisma, 'Member relink');
    const authorizedGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `relink-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const oldTgUserId = String(Math.floor(100_000_000 + Math.random() * 400_000_000));
    const newTgUserNumericId = Math.floor(600_000_000 + Math.random() * 300_000_000);
    const newTgUserId = String(newTgUserNumericId);
    const oldLink = await prisma.telegramUserLink.create({
      data: {
        tgUserId: oldTgUserId,
        chatId: authorizedGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const oldPending = await prisma.telegramPendingConfirmation.create({
      data: {
        id: randomUUID(),
        chatId: authorizedGroup.chatId,
        memberProfileId: tenant.memberProfileId,
        tgUserId: oldTgUserId,
        payload: { kind: 'TRANSACTION', description: 'Confirmação da identidade antiga' },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const updateId = `relink-${randomUUID()}`;
    await prisma.telegramUpdate.create({ data: { updateId, payload: { update_id: updateId } } });
    const code = await prisma.telegramAuthCode.create({
      data: {
        code: `MEMBER-${randomUUID()}`,
        kind: TelegramAuthCodeKind.MEMBER,
        userId: tenant.memberId,
        memberProfileId: tenant.memberProfileId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const service = createService(prisma, { sendMessage: vi.fn().mockResolvedValue({}) });

    await (
      service as unknown as {
        linkMember(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).linkMember(
      updateId,
      {
        chat: { id: authorizedGroup.chatId, type: 'supergroup' },
        message_id: 5,
        from: { id: newTgUserNumericId },
      },
      code.code,
    );

    const [persistedOldLink, persistedOldPending, activeLinks] = await Promise.all([
      prisma.telegramUserLink.findUniqueOrThrow({ where: { id: oldLink.id } }),
      prisma.telegramPendingConfirmation.findUniqueOrThrow({ where: { id: oldPending.id } }),
      prisma.telegramUserLink.findMany({
        where: {
          chatId: authorizedGroup.chatId,
          memberProfileId: tenant.memberProfileId,
          revokedAt: null,
        },
        select: { tgUserId: true },
      }),
    ]);
    expect(persistedOldLink.revokedAt).toBeInstanceOf(Date);
    expect(persistedOldPending.status).toBe(TelegramPendingStatus.CANCELLED);
    expect(persistedOldPending.resolvedAt).toBeInstanceOf(Date);
    expect(activeLinks).toEqual([{ tgUserId: newTgUserId }]);

    await expect(
      prisma.telegramUserLink.create({
        data: {
          tgUserId: `duplicate-${randomUUID()}`,
          chatId: authorizedGroup.chatId,
          familyId: tenant.familyId,
          memberProfileId: tenant.memberProfileId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const contextResolver = service as unknown as {
      resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
    };
    await expect(contextResolver.resolveLinkedContextFromIds(authorizedGroup.chatId, oldTgUserId)).resolves.toBeNull();
    await expect(
      contextResolver.resolveLinkedContextFromIds(authorizedGroup.chatId, newTgUserId),
    ).resolves.toMatchObject({
      familyId: tenant.familyId,
      memberProfileId: tenant.memberProfileId,
    });
  });

  it('reverte toda a substituição quando a criação do novo grupo falha', async () => {
    const tenant = await createTenant(prisma, 'Replace rollback');
    const oldGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `rollback-old-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const oldLink = await prisma.telegramUserLink.create({
      data: {
        tgUserId: `rollback-tg-${randomUUID()}`,
        chatId: oldGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const updateId = `rollback-${randomUUID()}`;
    await prisma.telegramUpdate.create({ data: { updateId, payload: { update_id: updateId } } });
    const code = await prisma.telegramAuthCode.create({
      data: {
        code: `ROLLBACK-${randomUUID()}`,
        kind: TelegramAuthCodeKind.GROUP,
        userId: tenant.ownerId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const rejectedChatId = `forced-failure-${randomUUID()}`;

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "fatia11_reject_group"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."chatId" = '${rejectedChatId}' THEN
          RAISE EXCEPTION 'FATIA11_FORCED_GROUP_FAILURE';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "fatia11_reject_group_insert"
      BEFORE INSERT ON "TelegramAuthorizedGroup"
      FOR EACH ROW EXECUTE FUNCTION "fatia11_reject_group"()
    `);

    try {
      const service = createService(prisma, { sendMessage: vi.fn() });
      await expect(
        (
          service as unknown as {
            authorizeGroup(updateId: string, message: unknown, code: string): Promise<void>;
          }
        ).authorizeGroup(
          updateId,
          { chat: { id: rejectedChatId, type: 'group' }, message_id: 3, from: { id: 11 } },
          code.code,
        ),
      ).rejects.toThrow('FATIA11_FORCED_GROUP_FAILURE');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "fatia11_reject_group_insert" ON "TelegramAuthorizedGroup"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "fatia11_reject_group"()');
    }

    const [persistedGroup, persistedLink, persistedCode, rejectedGroup] = await Promise.all([
      prisma.telegramAuthorizedGroup.findUniqueOrThrow({ where: { id: oldGroup.id } }),
      prisma.telegramUserLink.findUniqueOrThrow({ where: { id: oldLink.id } }),
      prisma.telegramAuthCode.findUniqueOrThrow({ where: { id: code.id } }),
      prisma.telegramAuthorizedGroup.findUnique({ where: { chatId: rejectedChatId } }),
    ]);
    expect(persistedGroup.revokedAt).toBeNull();
    expect(persistedLink.revokedAt).toBeNull();
    expect(persistedCode.consumedAt).toBeNull();
    expect(rejectedGroup).toBeNull();
  });

  it('reavalia a policy depois da fila e não chama IA quando a assinatura foi cancelada', async () => {
    const tenant = await createTenant(prisma, 'Queued cancellation');
    const authorizedGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `queued-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const tgUserNumericId = Math.floor(100_000_000 + Math.random() * 900_000_000);
    const tgUserId = String(tgUserNumericId);
    await prisma.telegramUserLink.create({
      data: {
        tgUserId,
        chatId: authorizedGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const parseFinancialMessage = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({});
    const service = createService(prisma, { sendMessage }, parseFinancialMessage);
    let releaseQueue: (() => void) | undefined;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    (service as unknown as { queue: Promise<void> }).queue = queueGate;
    const numericUpdateId = Math.floor(Math.random() * 1_000_000_000);

    await service.receiveWebhook(
      {
        update_id: numericUpdateId,
        message: {
          message_id: numericUpdateId,
          chat: { id: authorizedGroup.chatId, type: 'group' },
          from: { id: tgUserNumericId },
          text: 'gastei 20 reais no mercado',
        },
      },
      'integration-telegram-secret',
    );

    const beforeCancellation = await prisma.subscription.findUniqueOrThrow({
      where: { id: tenant.subscriptionId },
      select: SUBSCRIPTION_ACCESS_SELECT,
    });
    expect(evaluateSubscriptionProjection(beforeCancellation).accessAllowed).toBe(true);

    const cancelledAt = new Date();
    await prisma.subscription.update({
      where: { id: tenant.subscriptionId },
      data: {
        providerStatus: 'CANCELLED',
        lastProviderEvent: 'subscription.cancelled',
        providerUpdatedAt: cancelledAt,
        cancelledAt,
        cancelledDueTo: 'provider_cancelled',
      },
    });
    releaseQueue?.();
    await waitForUpdate(prisma, String(numericUpdateId));

    const afterCancellation = await prisma.subscription.findUniqueOrThrow({
      where: { id: tenant.subscriptionId },
      select: SUBSCRIPTION_ACCESS_SELECT,
    });
    expect(evaluateSubscriptionProjection(afterCancellation)).toMatchObject({
      effectiveStatus: 'cancelled',
      accessAllowed: false,
    });
    expect(parseFinancialMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      authorizedGroup.chatId,
      expect.stringContaining('Configurações > Assinatura'),
    );
  });

  it('não cria confirmação da identidade antiga quando o relink vence o lock da família', async () => {
    const tenant = await createTenant(prisma, 'Pending relink race');
    const authorizedGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `pending-race-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const oldTgUserId = String(Math.floor(100_000_000 + Math.random() * 400_000_000));
    const newTgUserId = String(Math.floor(600_000_000 + Math.random() * 300_000_000));
    await prisma.telegramUserLink.create({
      data: {
        tgUserId: oldTgUserId,
        chatId: authorizedGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const contextService = createService(prisma, { sendMessage: vi.fn().mockResolvedValue({}) });
    const context = await (
      contextService as unknown as {
        resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
      }
    ).resolveLinkedContextFromIds(authorizedGroup.chatId, oldTgUserId);
    expect(context).not.toBeNull();

    const relinkClient = new PrismaClient();
    const pendingClient = new PrismaClient();
    const relinkHasFamilyLock = deferred<void>();
    const releaseRelink = deferred<void>();
    const pendingTransactionStarted = deferred<void>();
    let pendingPromise: Promise<unknown> | undefined;
    const pendingPrisma = {
      $transaction: <T>(
        callback: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: InteractiveTransactionOptions,
      ) =>
        pendingClient.$transaction(async (tx) => {
          pendingTransactionStarted.resolve();
          return callback(tx);
        }, options),
      telegramPendingConfirmation: pendingClient.telegramPendingConfirmation,
    };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 50 });
    const pendingService = createService(pendingPrisma, { sendMessage });
    const relinkPromise = relinkClient.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${tenant.familyId} FOR UPDATE
      `;
      relinkHasFamilyLock.resolve();
      await releaseRelink.promise;

      const now = new Date();
      await tx.telegramUserLink.updateMany({
        where: {
          chatId: authorizedGroup.chatId,
          familyId: tenant.familyId,
          memberProfileId: tenant.memberProfileId,
          revokedAt: null,
          NOT: { tgUserId: newTgUserId },
        },
        data: { revokedAt: now },
      });
      await tx.telegramPendingConfirmation.updateMany({
        where: {
          chatId: authorizedGroup.chatId,
          memberProfileId: tenant.memberProfileId,
          status: TelegramPendingStatus.PENDING,
          NOT: { tgUserId: newTgUserId },
        },
        data: { status: TelegramPendingStatus.CANCELLED, resolvedAt: now },
      });
      await tx.telegramUserLink.upsert({
        where: {
          tgUserId_chatId: { tgUserId: newTgUserId, chatId: authorizedGroup.chatId },
        },
        update: {
          familyId: tenant.familyId,
          memberProfileId: tenant.memberProfileId,
          revokedAt: null,
        },
        create: {
          tgUserId: newTgUserId,
          chatId: authorizedGroup.chatId,
          familyId: tenant.familyId,
          memberProfileId: tenant.memberProfileId,
        },
      });
    });

    try {
      await relinkHasFamilyLock.promise;
      pendingPromise = (
        pendingService as unknown as {
          createPendingConfirmation(
            context: unknown,
            payload: unknown,
            text: string,
          ): Promise<boolean>;
        }
      ).createPendingConfirmation(
        context,
        { kind: 'UNDO_OPERATION', operationId: '00000000-0000-4000-8000-000000000001' },
        'Confirmação obsoleta',
      );
      await pendingTransactionStarted.promise;

      releaseRelink.resolve();
      await relinkPromise;
      await expect(pendingPromise).resolves.toBe(false);

      const [oldIdentityPending, activeLinks] = await Promise.all([
        prisma.telegramPendingConfirmation.findMany({
          where: { chatId: authorizedGroup.chatId, tgUserId: oldTgUserId },
        }),
        prisma.telegramUserLink.findMany({
          where: {
            chatId: authorizedGroup.chatId,
            memberProfileId: tenant.memberProfileId,
            revokedAt: null,
          },
          select: { tgUserId: true },
        }),
      ]);
      expect(oldIdentityPending).toEqual([]);
      expect(activeLinks).toEqual([{ tgUserId: newTgUserId }]);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      releaseRelink.resolve();
      await Promise.allSettled([relinkPromise, pendingPromise ?? Promise.resolve()]);
      await Promise.all([relinkClient.$disconnect(), pendingClient.$disconnect()]);
    }
  });

  it('serializa troca de grupo pelo lock da família e impede mutação iniciada antes do commit', async () => {
    const tenant = await createTenant(prisma, 'Family lock race');
    const oldGroup = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId: `race-old-${randomUUID()}`,
        familyId: tenant.familyId,
        authorizedByUserId: tenant.ownerId,
      },
    });
    const tgUserId = String(Math.floor(100_000_000 + Math.random() * 800_000_000));
    await prisma.telegramUserLink.create({
      data: {
        tgUserId,
        chatId: oldGroup.chatId,
        familyId: tenant.familyId,
        memberProfileId: tenant.memberProfileId,
      },
    });
    const mutationUpdateId = `race-mutate-${randomUUID()}`;
    const idempotencyKey = `tg:race:${randomUUID()}`;
    await prisma.telegramUpdate.create({
      data: { updateId: mutationUpdateId, payload: { update_id: mutationUpdateId } },
    });
    const contextService = createService(prisma, { sendMessage: vi.fn().mockResolvedValue({}) });
    const context = await (
      contextService as unknown as {
        resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
      }
    ).resolveLinkedContextFromIds(oldGroup.chatId, tgUserId);
    expect(context).not.toBeNull();

    const revokerClient = new PrismaClient();
    const mutationClient = new PrismaClient();
    const revokerHasFamilyLock = deferred<void>();
    const releaseRevoker = deferred<void>();
    const mutationTransactionStarted = deferred<void>();
    let mutationPromise: Promise<unknown> | undefined;
    const mutationPrisma = {
      $transaction: <T>(
        callback: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: InteractiveTransactionOptions,
      ) =>
        mutationClient.$transaction(async (tx) => {
          mutationTransactionStarted.resolve();
          return callback(tx);
        }, options),
      telegramUpdate: mutationClient.telegramUpdate,
    };
    const createFinancialTransaction = vi.fn(
      async (tx: Prisma.TransactionClient, tenantContext: { authorProfileId: string }, input: FinancialInput) =>
        tx.transaction.create({
          data: {
            date: new Date(input.applicationDate),
            applicationDate: new Date(input.applicationDate),
            referenceMonth: new Date(input.referenceMonth ?? input.applicationDate),
            description: input.description,
            amountCents: input.amountCents,
            type: input.type,
            source: input.source,
            externalId: input.externalId,
            memberProfileId: tenantContext.authorProfileId,
          },
        }),
    );
    const mutationService = createService(
      mutationPrisma,
      { sendMessage: vi.fn().mockResolvedValue({}) },
      vi.fn(),
      { createInTransaction: createFinancialTransaction },
    );
    const newChatId = `race-new-${randomUUID()}`;
    const replacementPromise = revokerClient.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Family" WHERE "id" = ${tenant.familyId} FOR UPDATE
      `;
      revokerHasFamilyLock.resolve();
      await releaseRevoker.promise;

      const revokedAt = new Date();
      await tx.telegramAuthorizedGroup.update({
        where: { id: oldGroup.id },
        data: { revokedAt },
      });
      await tx.telegramUserLink.updateMany({
        where: {
          familyId: tenant.familyId,
          chatId: oldGroup.chatId,
          revokedAt: null,
        },
        data: { revokedAt },
      });
      await tx.telegramAuthorizedGroup.create({
        data: {
          chatId: newChatId,
          familyId: tenant.familyId,
          authorizedByUserId: tenant.ownerId,
        },
      });
    });

    try {
      await revokerHasFamilyLock.promise;
      mutationPromise = (
        mutationService as unknown as {
          tryCreateFinancialOperation(
            updateId: string,
            context: unknown,
            draft: unknown,
            idempotencyKey: string,
          ): Promise<unknown>;
        }
      ).tryCreateFinancialOperation(
        mutationUpdateId,
        context,
        {
          action: 'TRANSACTION',
          transactionType: 'expense',
          amountCents: 2_500,
          applicationDate: '2026-08-01',
          referenceMonth: '2026-08-01',
          description: 'Mutação concorrente bloqueada',
          sourceMessageId: 7,
        },
        idempotencyKey,
      );
      const mutationMustFail = expect(mutationPromise).rejects.toThrow('Vínculo Telegram não está mais ativo');
      await mutationTransactionStarted.promise;

      releaseRevoker.resolve();
      await replacementPromise;
      await mutationMustFail;

      const [operation, financialTransaction, persistedOldGroup, persistedNewGroup] = await Promise.all([
        prisma.telegramFinancialOperation.findUnique({ where: { idempotencyKey } }),
        prisma.transaction.findFirst({ where: { externalId: idempotencyKey } }),
        prisma.telegramAuthorizedGroup.findUniqueOrThrow({ where: { id: oldGroup.id } }),
        prisma.telegramAuthorizedGroup.findUniqueOrThrow({ where: { chatId: newChatId } }),
      ]);
      expect(operation).toBeNull();
      expect(financialTransaction).toBeNull();
      expect(persistedOldGroup.revokedAt).toBeInstanceOf(Date);
      expect(persistedNewGroup.revokedAt).toBeNull();
      expect(createFinancialTransaction).not.toHaveBeenCalled();
    } finally {
      releaseRevoker.resolve();
      await Promise.allSettled([replacementPromise, mutationPromise ?? Promise.resolve()]);
      await Promise.all([revokerClient.$disconnect(), mutationClient.$disconnect()]);
    }
  });
});

interface FinancialInput {
  applicationDate: string;
  referenceMonth?: string | null;
  description: string;
  amountCents: number;
  type: 'income' | 'expense';
  source?: string;
  externalId?: string;
}

interface InteractiveTransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createService(
  prisma: PrismaClient | object,
  telegram: { sendMessage: ReturnType<typeof vi.fn> },
  parseFinancialMessage: ReturnType<typeof vi.fn> = vi.fn(),
  transactionsService: object = { createInTransaction: vi.fn() },
) {
  return new TelegramService(
    {
      get: vi.fn((key: string) => {
        if (key === 'TELEGRAM_WEBHOOK_SECRET') return 'integration-telegram-secret';
        return undefined;
      }),
    } as never,
    prisma as never,
    telegram as never,
    { parseFinancialMessage } as never,
    transactionsService as never,
    { createInTransaction: vi.fn(), removeTelegramCreatedPlanInTransaction: vi.fn() } as never,
    new SubscriptionAccessPolicy(),
    { consistentTransactionRelations: vi.fn().mockReturnValue({}) } as never,
  );
}

async function createTenant(prisma: PrismaClient, label: string): Promise<TenantFixture> {
  const suffix = randomUUID();
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: { id: randomUUID(), name: `${label} ${suffix}` },
    });
    const owner = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `owner-${suffix}@example.test`,
        name: `${label} Owner`,
        platformRole: PlatformRole.user,
        familyId: family.id,
        emailVerifiedAt: now,
      },
    });
    const ownerProfile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: `${label} Owner`,
        userId: owner.id,
        familyId: family.id,
      },
    });
    const member = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `member-${suffix}@example.test`,
        name: `${label} Member`,
        platformRole: PlatformRole.user,
        familyId: family.id,
        emailVerifiedAt: now,
      },
    });
    const memberProfile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: `${label} Member`,
        userId: member.id,
        familyId: family.id,
      },
    });
    const paidAt = new Date(now.getTime() - 60_000);
    const subscription = await tx.subscription.create({
      data: {
        familyId: family.id,
        externalId: `telegram_${randomUUID()}`,
        providerSubscriptionId: `subs_${randomUUID()}`,
        providerProductId: 'prod_integration_monthly',
        providerStatus: 'ACTIVE',
        lastProviderEvent: 'subscription.renewed',
        providerUpdatedAt: paidAt,
        lastSuccessfulPaymentAt: paidAt,
        accessPaidThrough: new Date(now.getTime() + 31 * 24 * 60 * 60_000),
        lastInstallmentNumber: 1,
        entitlementContractVersion: 'integration-contract-v1',
        amountCents: 2_990,
        paymentMethod: SubscriptionPaymentMethod.CARD,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: { ownerUserId: owner.id, currentSubscriptionId: subscription.id },
    });

    return {
      familyId: family.id,
      subscriptionId: subscription.id,
      ownerId: owner.id,
      ownerProfileId: ownerProfile.id,
      memberId: member.id,
      memberProfileId: memberProfile.id,
    };
  });
}

async function waitForUpdate(prisma: PrismaClient, updateId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const update = await prisma.telegramUpdate.findUnique({ where: { updateId } });
    if (update?.status === 'succeeded') return;
    if (update?.status === 'failed') {
      throw new Error(`Update Telegram falhou: ${update.lastError ?? 'erro desconhecido'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Update Telegram não concluiu dentro do prazo do teste');
}
