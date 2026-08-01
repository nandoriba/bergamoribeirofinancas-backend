import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { TelegramService } from './telegram.service';

function createService(dependencies: {
  config?: unknown;
  prisma?: unknown;
  telegram?: unknown;
  transactionsService?: unknown;
  installmentsService?: unknown;
  tenantScope?: unknown;
} = {}) {
  return new TelegramService(
    (dependencies.config ?? { get: vi.fn() }) as never,
    (dependencies.prisma ?? {}) as never,
    (dependencies.telegram ?? {}) as never,
    {} as never,
    (dependencies.transactionsService ?? {}) as never,
    (dependencies.installmentsService ?? {}) as never,
    dependencies.tenantScope as never,
  );
}

describe('autenticação do webhook no TelegramService', () => {
  function createSecretAssertion(expectedSecret?: string) {
    const service = new TelegramService(
      { get: vi.fn().mockReturnValue(expectedSecret) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return (service as unknown as { assertWebhookSecret(secretToken?: string): void }).assertWebhookSecret.bind(
      service,
    );
  }

  it('aceita somente o secret configurado', () => {
    const assertWebhookSecret = createSecretAssertion('telegram-webhook-secret');

    expect(() => assertWebhookSecret('telegram-webhook-secret')).not.toThrow();
  });

  it.each([
    ['configuração ausente', undefined, 'telegram-webhook-secret'],
    ['header ausente', 'telegram-webhook-secret', undefined],
    ['valor diferente', 'telegram-webhook-secret', 'telegram-webhook-secrex'],
    ['comprimento diferente', 'telegram-webhook-secret', 'short'],
  ])('rejeita %s', (_label, expectedSecret, receivedSecret) => {
    const assertWebhookSecret = createSecretAssertion(expectedSecret);

    expect(() => assertWebhookSecret(receivedSecret)).toThrow(UnauthorizedException);
  });
});

describe('isolamento de tenant no TelegramService', () => {
  it.each(['private', 'channel'] as const)('recusa autorização de grupo em chat do tipo %s', async (chatType) => {
    const transaction = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const sendMessage = vi.fn().mockResolvedValue({});
    const service = createService({
      prisma: {
        $transaction: transaction,
        telegramUpdate: { update },
      },
      telegram: { sendMessage },
    });

    await (
      service as unknown as {
        authorizeGroup(updateId: string, message: unknown, code?: string): Promise<void>;
      }
    ).authorizeGroup(
      'update-1',
      { chat: { id: 'chat-1', type: chatType }, message_id: 1, from: { id: 10 } },
      'GROUP-CODE',
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'A autorização só pode ser feita em um grupo ou supergrupo.');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { updateId: 'update-1' },
        data: expect.objectContaining({ status: 'succeeded' }),
      }),
    );
  });

  it('nunca transfere um chat que já pertence a outra família', async () => {
    const upsert = vi.fn();
    const findMany = vi.fn();
    const groupUpdateMany = vi.fn();
    const linkUpdateMany = vi.fn();
    const claimCode = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      telegramAuthCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'code-id',
          kind: 'GROUP',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          user: {
            id: 'owner-b',
            familyId: 'family-b',
            isActive: true,
            family: { ownerUserId: 'owner-b' },
          },
        }),
        updateMany: claimCode,
      },
      telegramAuthorizedGroup: {
        findUnique: vi.fn().mockResolvedValue({ familyId: 'family-a' }),
        findMany,
        updateMany: groupUpdateMany,
        upsert,
      },
      telegramUserLink: { updateMany: linkUpdateMany },
      telegramUpdate: { update },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const sendMessage = vi.fn().mockResolvedValue({});
    const service = createService({
      prisma: { $transaction: transaction },
      telegram: { sendMessage },
    });

    await (
      service as unknown as {
        authorizeGroup(updateId: string, message: unknown, code?: string): Promise<void>;
      }
    ).authorizeGroup(
      'update-2',
      { chat: { id: 'shared-chat', type: 'group' }, message_id: 2, from: { id: 20 } },
      'GROUP-CODE',
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(groupUpdateMany).not.toHaveBeenCalled();
    expect(linkUpdateMany).not.toHaveBeenCalled();
    expect(claimCode).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('shared-chat', 'Este grupo já pertence a outra família.');
  });

  it('revalida vínculo revogado dentro da transação antes de criar operação financeira', async () => {
    const tx = {
      telegramAuthorizedGroup: {
        findUnique: vi.fn().mockResolvedValue({
          chatId: 'chat-1',
          familyId: 'family-1',
          revokedAt: null,
          family: { ownerUserId: 'owner-1' },
        }),
      },
      telegramUserLink: {
        findUnique: vi.fn().mockResolvedValue({
          memberProfileId: 'profile-1',
          revokedAt: new Date(),
          memberProfile: {
            id: 'profile-1',
            familyId: 'family-1',
            status: 'active',
            user: {
              id: 'user-1',
              email: 'membro@example.com',
              platformRole: 'user',
              familyId: 'family-1',
              isActive: true,
            },
          },
        }),
      },
      telegramFinancialOperation: { findUnique: vi.fn() },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const createTransaction = vi.fn();
    const createInstallment = vi.fn();
    const service = createService({
      prisma: { $transaction: transaction },
      transactionsService: { createInTransaction: createTransaction },
      installmentsService: { createInTransaction: createInstallment },
    });
    const tenant = TenantContext.fromAuthenticatedUser({
      id: 'user-1',
      email: 'membro@example.com',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    });

    await expect(
      (
        service as unknown as {
          tryCreateFinancialOperation(
            updateId: string,
            context: unknown,
            draft: unknown,
            idempotencyKey: string,
          ): Promise<unknown>;
        }
      ).tryCreateFinancialOperation(
        'update-3',
        {
          chatId: 'chat-1',
          tgUserId: 'telegram-user-1',
          memberProfileId: 'profile-1',
          familyId: 'family-1',
          tenant,
        },
        {
          action: 'TRANSACTION',
          transactionType: 'expense',
          amountCents: 1_000,
          applicationDate: '2026-07-31',
          description: 'Compra',
          sourceMessageId: 3,
        },
        'tg:msg:chat-1:3',
      ),
    ).rejects.toThrow('Vínculo Telegram não está mais ativo');

    expect(tx.telegramAuthorizedGroup.findUnique).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      include: { family: { select: { ownerUserId: true } } },
    });
    expect(tx.telegramUserLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tgUserId_chatId: { tgUserId: 'telegram-user-1', chatId: 'chat-1' } } }),
    );
    expect(tx.telegramFinancialOperation.findUnique).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(createInstallment).not.toHaveBeenCalled();
  });

  it('aplica o escopo financeiro fail-closed ao resumo de saldo', async () => {
    const transactionFindMany = vi.fn().mockResolvedValue([]);
    const sendMessage = vi.fn().mockResolvedValue({});
    const tenant = TenantContext.fromAuthenticatedUser({
      id: 'user-1',
      email: 'membro@example.com',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    });
    const service = createService({
      prisma: {
        account: { findMany: vi.fn().mockResolvedValue([]) },
        transaction: { findMany: transactionFindMany },
      },
      telegram: { sendMessage },
      tenantScope: {
        consistentTransactionRelations: vi.fn().mockReturnValue({ AND: [{ id: { not: 'inconsistent' } }] }),
      },
    });
    (service as unknown as { resolveLinkedContext: () => Promise<unknown> }).resolveLinkedContext = vi
      .fn()
      .mockResolvedValue({
        chatId: 'chat-1',
        tgUserId: 'tg-1',
        memberProfileId: 'profile-1',
        familyId: 'family-1',
        tenant,
      });

    await (
      service as unknown as { sendBalanceSummary(message: unknown): Promise<void> }
    ).sendBalanceSummary({ chat: { id: 'chat-1' }, from: { id: 1 } });

    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberProfileId: 'profile-1',
          AND: [{ id: { not: 'inconsistent' } }],
        }),
      }),
    );
  });

  it('revalida a janela de desfazer dentro da transação de confirmação', async () => {
    const operationFindFirst = vi.fn().mockResolvedValue(null);
    const pendingUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      telegramFinancialOperation: { findFirst: operationFindFirst },
      telegramPendingConfirmation: { update: pendingUpdate },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
    };
    const tenant = TenantContext.fromAuthenticatedUser({
      id: 'user-1',
      email: 'membro@example.com',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    });
    const linked = {
      chatId: 'chat-1',
      tgUserId: 'tg-1',
      memberProfileId: 'profile-1',
      familyId: 'family-1',
      tenant,
    };
    const service = createService({
      config: { get: vi.fn((key: string) => (key === 'TELEGRAM_UNDO_WINDOW_MINUTES' ? 10 : undefined)) },
      prisma: { $transaction: vi.fn((callback) => callback(tx)) },
    });
    (service as unknown as { resolveLinkedContextFromIds: () => Promise<unknown> }).resolveLinkedContextFromIds = vi
      .fn()
      .mockResolvedValue(linked);
    const answer = vi.fn().mockResolvedValue(undefined);
    const replace = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { safeAnswerCallbackQuery: typeof answer }).safeAnswerCallbackQuery = answer;
    (service as unknown as { safeReplaceMessage: typeof replace }).safeReplaceMessage = replace;

    const before = Date.now();
    await (
      service as unknown as {
        confirmUndo(updateId: string, callback: unknown, pendingId: string, payload: unknown): Promise<void>;
      }
    ).confirmUndo(
      'update-undo',
      { id: 'callback-1', from: { id: 'tg-1' }, message: { chat: { id: 'chat-1' }, message_id: 7 } },
      'pending-1',
      { kind: 'UNDO_OPERATION', operationId: 'operation-1' },
    );

    const cutoff = operationFindFirst.mock.calls[0][0].where.createdAt.gte as Date;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 10 * 60_000);
    expect(operationFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'operation-1',
      memberProfileId: 'profile-1',
      tgUserId: 'tg-1',
      chatId: 'chat-1',
      status: 'CREATED',
    });
    expect(pendingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(answer).toHaveBeenCalledWith('callback-1', 'A janela para desfazer expirou.');
  });

  it('não desfaz um lançamento que passou a pertencer a um parcelamento', async () => {
    const operationUpdate = vi.fn();
    const pendingUpdate = vi.fn().mockResolvedValue({});
    const transactionDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      telegramFinancialOperation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'operation-1',
          transactionId: 'transaction-1',
          installmentPlanId: null,
        }),
        update: operationUpdate,
      },
      telegramPendingConfirmation: { update: pendingUpdate },
      telegramUpdate: { update: vi.fn().mockResolvedValue({}) },
      transaction: { deleteMany: transactionDeleteMany },
    };
    const tenant = TenantContext.fromAuthenticatedUser({
      id: 'user-1',
      email: 'membro@example.com',
      platformRole: 'user',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    });
    const linked = {
      chatId: 'chat-1',
      tgUserId: 'tg-1',
      memberProfileId: 'profile-1',
      familyId: 'family-1',
      tenant,
    };
    const service = createService({
      config: { get: vi.fn((key: string) => (key === 'TELEGRAM_UNDO_WINDOW_MINUTES' ? 10 : undefined)) },
      prisma: { $transaction: vi.fn((callback) => callback(tx)) },
      tenantScope: {
        consistentTransactionRelations: vi.fn().mockReturnValue({ AND: [{ id: { not: 'inconsistent' } }] }),
      },
    });
    (service as unknown as { resolveLinkedContextFromIds: () => Promise<unknown> }).resolveLinkedContextFromIds = vi
      .fn()
      .mockResolvedValue(linked);
    const answer = vi.fn().mockResolvedValue(undefined);
    const replace = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { safeAnswerCallbackQuery: typeof answer }).safeAnswerCallbackQuery = answer;
    (service as unknown as { safeReplaceMessage: typeof replace }).safeReplaceMessage = replace;

    await (
      service as unknown as {
        confirmUndo(updateId: string, callback: unknown, pendingId: string, payload: unknown): Promise<void>;
      }
    ).confirmUndo(
      'update-undo',
      { id: 'callback-1', from: { id: 'tg-1' }, message: { chat: { id: 'chat-1' }, message_id: 7 } },
      'pending-1',
      { kind: 'UNDO_OPERATION', operationId: 'operation-1' },
    );

    expect(transactionDeleteMany).toHaveBeenCalledWith({
      where: {
        id: 'transaction-1',
        memberProfileId: 'profile-1',
        installmentPlanId: null,
        AND: [{ id: { not: 'inconsistent' } }],
      },
    });
    expect(operationUpdate).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    const message = 'O lançamento agora pertence a um parcelamento e não pode ser desfeito isoladamente.';
    expect(answer).toHaveBeenCalledWith('callback-1', message, true);
    expect(replace).toHaveBeenCalledWith('chat-1', 7, message);
  });
});
