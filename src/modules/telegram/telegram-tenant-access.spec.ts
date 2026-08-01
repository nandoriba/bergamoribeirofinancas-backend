import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { SubscriptionAccessPolicy } from '../payments/subscription-access.policy';
import { TelegramService } from './telegram.service';

function createService(dependencies: {
  prisma: unknown;
  telegram?: unknown;
  aiProvider?: unknown;
  transactionsService?: unknown;
  installmentsService?: unknown;
  subscriptionAccessPolicy?: unknown;
}) {
  return new TelegramService(
    { get: vi.fn() } as never,
    dependencies.prisma as never,
    (dependencies.telegram ?? { sendMessage: vi.fn() }) as never,
    (dependencies.aiProvider ?? { parseFinancialMessage: vi.fn() }) as never,
    (dependencies.transactionsService ?? {}) as never,
    (dependencies.installmentsService ?? {}) as never,
    (dependencies.subscriptionAccessPolicy ?? new SubscriptionAccessPolicy()) as never,
    {
      consistentTransactionRelations: vi.fn().mockReturnValue({}),
    } as never,
  );
}

function activeSubscription() {
  const now = Date.now();
  return {
    providerStatus: 'ACTIVE',
    lastProviderEvent: 'subscription.renewed',
    providerUpdatedAt: new Date(now - 60_000),
    lastSuccessfulPaymentAt: new Date(now - 60_000),
    accessPaidThrough: new Date(now + 24 * 60 * 60_000),
    paymentFailedAt: null,
    graceUntil: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    cancelledDueTo: null,
    lastInstallmentNumber: 1,
    entitlementContractVersion: 'monthly-card-v1',
    billingCycle: 'MONTHLY',
    paymentMethod: 'CARD',
  };
}

function pastDueSubscription() {
  const now = Date.now();
  return {
    ...activeSubscription(),
    lastProviderEvent: 'subscription.payment_failed',
    providerUpdatedAt: new Date(now - 60 * 60_000),
    lastSuccessfulPaymentAt: new Date(now - 32 * 24 * 60 * 60_000),
    accessPaidThrough: new Date(now - 24 * 60 * 60_000),
    paymentFailedAt: new Date(now - 60 * 60_000),
    graceUntil: new Date(now + 24 * 60 * 60_000),
  };
}

function group(currentSubscription: unknown, familyId = 'family-a', chatId = 'chat-a') {
  return {
    chatId,
    familyId,
    revokedAt: null,
    family: {
      ownerUserId: 'owner-a',
      currentSubscription,
    },
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-a',
    tgUserId: 'tg-a',
    chatId: 'chat-a',
    familyId: 'family-a',
    memberProfileId: 'profile-a',
    revokedAt: null,
    memberProfile: {
      id: 'profile-a',
      familyId: 'family-a',
      status: 'active',
      user: {
        id: 'member-a',
        email: 'member-a@example.test',
        platformRole: 'user',
        familyId: 'family-a',
        isActive: true,
      },
    },
    ...overrides,
  };
}

function financialMessage() {
  return {
    update_id: 11,
    message: {
      message_id: 101,
      chat: { id: 'chat-a', type: 'group' as const },
      from: { id: 'tg-a' },
      text: 'gastei 25 reais no mercado',
    },
  };
}

function parsedExpense() {
  return {
    raw: { intent: 'EXPENSE' },
    model: 'fake-model',
    tokensIn: 10,
    tokensOut: 5,
    parsed: {
      intent: 'EXPENSE',
      confidence: 1,
      amount: { value: 25, currency: 'BRL' },
      date: '2026-08-01',
      description: 'Mercado',
      accountHint: null,
      categoryHint: null,
      installments: null,
      missingFields: [],
    },
  };
}

describe('policy compartilhada no Telegram', () => {
  it('serializa pelo lock da família, usa leitura atual e repete conflito transitório', async () => {
    const lockFamily = vi.fn().mockResolvedValue([{ id: 'family-a' }]);
    const operation = vi.fn().mockResolvedValue('committed');
    const tx = { $queryRaw: lockFamily };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((callback: (client: typeof tx) => unknown) => callback(tx));
    const service = createService({ prisma: { $transaction: transaction } });

    await expect(
      (
        service as unknown as {
          withLockedFamilyTransaction<T>(
            familyId: string,
            operation: (client: unknown) => Promise<T>,
          ): Promise<T>;
        }
      ).withLockedFamilyTransaction('family-a', operation),
    ).resolves.toBe('committed');

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(lockFamily).toHaveBeenCalledOnce();
    expect(lockFamily.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
  });

  it('não cria nem envia confirmação quando o vínculo foi revogado antes do lock', async () => {
    const pendingCreate = vi.fn();
    const sendMessage = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(group(activeSubscription())) },
      telegramUserLink: {
        findUnique: vi.fn().mockResolvedValue(link({ revokedAt: new Date() })),
      },
      telegramPendingConfirmation: { create: pendingCreate },
    };
    const transaction = vi.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const service = createService({
      prisma: {
        $transaction: transaction,
        telegramPendingConfirmation: { update: vi.fn() },
      },
      telegram: { sendMessage },
    });
    const tenant = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member-a@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    await expect(
      (
        service as unknown as {
          createPendingConfirmation(
            context: unknown,
            payload: unknown,
            text: string,
          ): Promise<boolean>;
        }
      ).createPendingConfirmation(
        {
          chatId: 'chat-a',
          tgUserId: 'tg-a',
          memberProfileId: 'profile-a',
          familyId: 'family-a',
          tenant,
        },
        { kind: 'UNDO_OPERATION', operationId: '00000000-0000-4000-8000-000000000001' },
        'Confirma?',
      ),
    ).resolves.toBe(false);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(pendingCreate).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['active', activeSubscription()],
    ['past_due', pastDueSubscription()],
  ])('libera o contexto quando a policy HTTP deriva %s', async (_status, subscription) => {
    const prisma = {
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(group(subscription)) },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
    };
    const service = createService({ prisma });

    const context = await (
      service as unknown as {
        resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
      }
    ).resolveLinkedContextFromIds('chat-a', 'tg-a');

    expect(context).toMatchObject({
      chatId: 'chat-a',
      tgUserId: 'tg-a',
      familyId: 'family-a',
      memberProfileId: 'profile-a',
    });
  });

  it('nega fail-closed uma assinatura ausente depois de validar grupo e remetente', async () => {
    const prisma = {
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(group(null)) },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
    };
    const service = createService({ prisma });

    await expect(
      (
        service as unknown as {
          resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
        }
      ).resolveLinkedContextFromIds('chat-a', 'tg-a'),
    ).rejects.toThrow('Assinatura sem acesso ao Telegram');
  });

  it.each([
    ['grupo incorreto', null, link()],
    ['remetente não vinculado', group(activeSubscription()), null],
    [
      'membro inativo',
      group(activeSubscription()),
      link({
        memberProfile: {
          id: 'profile-a',
          familyId: 'family-a',
          status: 'inactive',
          user: {
            id: 'member-a',
            email: 'member-a@example.test',
            platformRole: 'user',
            familyId: 'family-a',
            isActive: false,
          },
        },
      }),
    ],
  ])('rejeita %s sem revelar o estado da assinatura', async (_label, authorizedGroup, userLink) => {
    const evaluate = vi.fn();
    const prisma = {
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(authorizedGroup) },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(userLink) },
    };
    const service = createService({
      prisma,
      subscriptionAccessPolicy: { evaluate, allows: vi.fn() },
    });

    await expect(
      (
        service as unknown as {
          resolveLinkedContextFromIds(chatId: string, tgUserId: string): Promise<unknown>;
        }
      ).resolveLinkedContextFromIds('chat-a', 'tg-a'),
    ).resolves.toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('não chama IA quando o tenant ficou bloqueado enquanto o update aguardava na fila', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const parseFinancialMessage = vi.fn();
    const prisma = {
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(group(null)) },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
    };
    const service = createService({
      prisma,
      telegram: { sendMessage },
      aiProvider: { parseFinancialMessage },
    });

    await expect(
      (
        service as unknown as {
          processPayload(updateId: string, payload: unknown): Promise<boolean>;
        }
      ).processPayload('update-queued', financialMessage()),
    ).resolves.toBe(false);

    expect(parseFinancialMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'chat-a',
      expect.stringContaining('Configurações > Assinatura'),
    );
  });

  it('reavalia imediatamente antes da IA', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const parseFinancialMessage = vi.fn();
    const groupFindUnique = vi
      .fn()
      .mockResolvedValueOnce(group(activeSubscription()))
      .mockResolvedValueOnce(group(null));
    const messageLogCreate = vi.fn();
    const prisma = {
      telegramAuthorizedGroup: { findUnique: groupFindUnique },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
      account: { findMany: vi.fn().mockResolvedValue([]) },
      category: { findMany: vi.fn().mockResolvedValue([]) },
      telegramMessageLog: { create: messageLogCreate },
    };
    const service = createService({
      prisma,
      telegram: { sendMessage },
      aiProvider: { parseFinancialMessage },
    });

    await (
      service as unknown as {
        processPayload(updateId: string, payload: unknown): Promise<boolean>;
      }
    ).processPayload('update-before-ai', financialMessage());

    expect(parseFinancialMessage).not.toHaveBeenCalled();
    expect(messageLogCreate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat-a', expect.stringContaining('restabelecer o acesso'));
  });

  it('reavalia dentro da transação e não grava depois de cancelamento ocorrido após a IA', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const parseFinancialMessage = vi.fn().mockResolvedValue(parsedExpense());
    const createTransaction = vi.fn();
    const groupFindUnique = vi
      .fn()
      .mockResolvedValueOnce(group(activeSubscription()))
      .mockResolvedValueOnce(group(activeSubscription()))
      .mockResolvedValueOnce(group(activeSubscription()))
      .mockResolvedValueOnce(group(null));
    const prisma: Record<string, unknown> = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthorizedGroup: { findUnique: groupFindUnique },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
      account: { findMany: vi.fn().mockResolvedValue([]) },
      category: { findMany: vi.fn().mockResolvedValue([]) },
      telegramMessageLog: { create: vi.fn().mockResolvedValue({}) },
      telegramFinancialOperation: { findUnique: vi.fn() },
    };
    prisma.$transaction = vi.fn((callback: (tx: unknown) => unknown) => callback(prisma));
    const service = createService({
      prisma,
      telegram: { sendMessage },
      aiProvider: { parseFinancialMessage },
      transactionsService: { createInTransaction: createTransaction },
      installmentsService: { createInTransaction: vi.fn() },
    });

    await (
      service as unknown as {
        processPayload(updateId: string, payload: unknown): Promise<boolean>;
      }
    ).processPayload('update-before-write', financialMessage());

    expect(parseFinancialMessage).toHaveBeenCalledOnce();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat-a', expect.stringContaining('restabelecer o acesso'));
  });

  it('reavalia dentro da transação antes de desfazer', async () => {
    const groupFindUnique = vi
      .fn()
      .mockResolvedValueOnce(group(activeSubscription()))
      .mockResolvedValueOnce(group(null));
    const deleteMany = vi.fn();
    const prisma: Record<string, unknown> = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthorizedGroup: { findUnique: groupFindUnique },
      telegramUserLink: { findUnique: vi.fn().mockResolvedValue(link()) },
      telegramFinancialOperation: { findFirst: vi.fn(), update: vi.fn() },
      telegramPendingConfirmation: { update: vi.fn() },
      telegramUpdate: { update: vi.fn() },
      transaction: { deleteMany },
    };
    prisma.$transaction = vi.fn((callback: (tx: unknown) => unknown) => callback(prisma));
    const service = createService({ prisma });

    await expect(
      (
        service as unknown as {
          confirmUndo(updateId: string, callback: unknown, pendingId: string, payload: unknown): Promise<void>;
        }
      ).confirmUndo(
        'update-undo',
        { id: 'callback-a', from: { id: 'tg-a' }, message: { chat: { id: 'chat-a' }, message_id: 7 } },
        'pending-a',
        { kind: 'UNDO_OPERATION', operationId: '00000000-0000-4000-8000-000000000001' },
      ),
    ).rejects.toThrow('Assinatura sem acesso ao Telegram');
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('autorização, vínculo e status do grupo familiar', () => {
  it('não gera código pessoal antes de existir grupo autorizado', async () => {
    const prisma = {
      memberProfile: { findFirst: vi.fn().mockResolvedValue({ id: 'profile-a' }) },
      telegramAuthorizedGroup: { findFirst: vi.fn().mockResolvedValue(null) },
      telegramAuthCode: { create: vi.fn() },
    };
    const service = createService({ prisma });
    const context = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member-a@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    await expect(service.createMemberAuthCode(context)).rejects.toThrow(
      'O owner precisa autorizar o grupo da família antes do vínculo.',
    );
    expect(prisma.telegramAuthCode.create).not.toHaveBeenCalled();
  });

  it('não consome código de grupo emitido antes do bloqueio', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const upsert = vi.fn();
    const claimCode = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'code-a',
          kind: 'GROUP',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          user: {
            id: 'owner-a',
            familyId: 'family-a',
            isActive: true,
            family: { ownerUserId: 'owner-a', currentSubscription: null },
          },
        }),
        updateMany: claimCode,
      },
      telegramAuthorizedGroup: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        updateMany: vi.fn(),
        upsert,
      },
      telegramUserLink: { updateMany: vi.fn() },
      telegramPendingConfirmation: { updateMany: vi.fn() },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({
      prisma: { $transaction: vi.fn((callback) => callback(tx)) },
      telegram: { sendMessage },
    });

    await (
      service as unknown as {
        authorizeGroup(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).authorizeGroup(
      'update-group',
      { chat: { id: 'chat-a', type: 'group' }, message_id: 1, from: { id: 'tg-owner' } },
      'GROUP-CODE',
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(claimCode).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat-a', expect.stringContaining('Configurações > Assinatura'));
  });

  it('não consome código de membro emitido antes do bloqueio', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const upsert = vi.fn();
    const claimCode = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthorizedGroup: { findUnique: vi.fn().mockResolvedValue(group(null)) },
      telegramAuthCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'member-code-a',
          kind: 'MEMBER',
          userId: 'member-a',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          memberProfile: {
            id: 'profile-a',
            userId: 'member-a',
            familyId: 'family-a',
            status: 'active',
            user: { id: 'member-a', familyId: 'family-a', isActive: true },
          },
        }),
        updateMany: claimCode,
      },
      telegramUserLink: { updateMany: vi.fn(), upsert },
      telegramPendingConfirmation: { updateMany: vi.fn() },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({
      prisma: { $transaction: vi.fn((callback) => callback(tx)) },
      telegram: { sendMessage },
    });

    await (
      service as unknown as {
        linkMember(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).linkMember(
      'update-link',
      { chat: { id: 'chat-a', type: 'group' }, message_id: 2, from: { id: 'tg-a' } },
      'MEMBER-CODE',
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(claimCode).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat-a', expect.stringContaining('restabelecer o acesso'));
  });

  it('substitui o único grupo e revoga vínculos e confirmações anteriores atomicamente', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const groupUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const linkUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const pendingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'code-a',
          kind: 'GROUP',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          user: {
            id: 'owner-a',
            familyId: 'family-a',
            isActive: true,
            family: { ownerUserId: 'owner-a', currentSubscription: activeSubscription() },
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      telegramAuthorizedGroup: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ chatId: 'chat-old' }]),
        updateMany: groupUpdateMany,
        upsert,
      },
      telegramUserLink: { updateMany: linkUpdateMany },
      telegramPendingConfirmation: { updateMany: pendingUpdateMany },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
    };
    const transaction = vi.fn((callback) => callback(tx));
    const service = createService({ prisma: { $transaction: transaction }, telegram: { sendMessage } });

    await (
      service as unknown as {
        authorizeGroup(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).authorizeGroup(
      'update-replace',
      { chat: { id: 'chat-new', type: 'supergroup' }, message_id: 3, from: { id: 'tg-owner' } },
      'GROUP-CODE',
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(linkUpdateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-a', chatId: { in: ['chat-old'] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(pendingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: { in: ['chat-old'] }, status: 'PENDING' }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ chatId: 'chat-new', familyId: 'family-a' }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('chat-new', 'Grupo autorizado para lançamentos financeiros.');
  });

  it('persiste familyId ao vincular o remetente ao próprio perfil', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const upsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-a' }]),
      telegramAuthorizedGroup: {
        findUnique: vi.fn().mockResolvedValue(group(activeSubscription())),
      },
      telegramAuthCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'member-code-a',
          kind: 'MEMBER',
          userId: 'member-a',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          memberProfile: {
            id: 'profile-a',
            userId: 'member-a',
            familyId: 'family-a',
            status: 'active',
            user: { id: 'member-a', familyId: 'family-a', isActive: true },
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      telegramUserLink: { updateMany: vi.fn(), upsert },
      telegramPendingConfirmation: { updateMany: vi.fn() },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({
      prisma: { $transaction: vi.fn((callback) => callback(tx)) },
      telegram: { sendMessage },
    });

    await (
      service as unknown as {
        linkMember(updateId: string, message: unknown, code: string): Promise<void>;
      }
    ).linkMember(
      'update-link',
      { chat: { id: 'chat-a', type: 'group' }, message_id: 4, from: { id: 'tg-a' } },
      'MEMBER-CODE',
    );

    expect(upsert).toHaveBeenCalledWith({
      where: { tgUserId_chatId: { tgUserId: 'tg-a', chatId: 'chat-a' } },
      update: { familyId: 'family-a', memberProfileId: 'profile-a', revokedAt: null },
      create: {
        tgUserId: 'tg-a',
        chatId: 'chat-a',
        familyId: 'family-a',
        memberProfileId: 'profile-a',
      },
    });
  });

  it('expõe apenas status booleano do grupo e do vínculo atual', async () => {
    const prisma = {
      telegramAuthorizedGroup: { findFirst: vi.fn().mockResolvedValue({ chatId: 'secret-chat-id' }) },
      telegramUserLink: { findFirst: vi.fn().mockResolvedValue({ id: 'secret-link-id' }) },
    };
    const service = createService({ prisma });
    const context = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member-a@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    const status = await service.getStatus(context);

    expect(status).toEqual({ group: { authorized: true }, member: { linked: true } });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(prisma.telegramUserLink.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'secret-chat-id',
        familyId: 'family-a',
        memberProfileId: 'profile-a',
        revokedAt: null,
      },
      select: { id: true },
    });
  });

  it('retorna status fail-closed sem consultar vínculo quando não há grupo ativo', async () => {
    const findLink = vi.fn();
    const service = createService({
      prisma: {
        telegramAuthorizedGroup: { findFirst: vi.fn().mockResolvedValue(null) },
        telegramUserLink: { findFirst: findLink },
      },
    });
    const context = TenantContext.fromAuthenticatedUser({
      id: 'member-a',
      email: 'member-a@example.test',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-a',
      profileId: 'profile-a',
    });

    await expect(service.getStatus(context)).resolves.toEqual({
      group: { authorized: false },
      member: { linked: false },
    });
    expect(findLink).not.toHaveBeenCalled();
  });
});
