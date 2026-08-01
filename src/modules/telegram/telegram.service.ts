import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import type { AppConfig } from '../../shared/configuration';
import { endOfDay, endOfMonth, startOfMonth } from '../../shared/date-range';
import { accountBalanceCents, expenseCents } from '../../shared/finance-calculator';
import { TenantContext } from '../../shared/tenant-context';
import { timingSafeStringEqual } from '../../shared/timing-safe-string-equal';
import { InstallmentsService } from '../installments/installments.service';
import { SUBSCRIPTION_ACCESS_SELECT } from '../payments/subscription-access.projection';
import {
  SubscriptionAccessPolicy,
  type SubscriptionAccessDecision,
} from '../payments/subscription-access.policy';
import { TransactionsService } from '../transactions/transactions.service';
import { AI_PROVIDER, type AiProvider } from './ai-provider';
import {
  financialDraftSchema,
  type FinancialDraft,
  type TelegramAiResponse,
  telegramPendingPayloadSchema,
  type TelegramPendingPayload,
} from './telegram-ai.schema';
import { TelegramClient } from './telegram.client';
import type { TelegramCallbackQueryPayload, TelegramMessagePayload, TelegramUpdatePayload } from './telegram.types';

interface LinkedTelegramContext {
  chatId: string;
  tgUserId: string;
  memberProfileId: string;
  familyId: string;
  tenant: TenantContext;
}

type TelegramPrismaExecutor = PrismaService | Prisma.TransactionClient;

const TELEGRAM_TRANSACTION_RETRIES = 3;

interface AccountCandidate {
  id: string;
  name: string;
  type: string;
  institution: string | null;
  lastFourDigits: string | null;
  closingDay: number | null;
}

interface CategoryCandidate {
  id: string;
  name: string;
  type: string;
  aliases: string[];
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private queue = Promise.resolve();
  private recovering = false;

  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClient,
    @Inject(AI_PROVIDER) private readonly aiProvider: AiProvider,
    private readonly transactionsService: TransactionsService,
    private readonly installmentsService: InstallmentsService,
    private readonly subscriptionAccessPolicy: SubscriptionAccessPolicy,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  async receiveWebhook(payload: TelegramUpdatePayload, secretToken?: string) {
    this.assertWebhookSecret(secretToken);
    const updateId = this.resolveUpdateId(payload);

    const created = await this.persistUpdate(updateId, payload);
    if (created) {
      this.enqueue(updateId);
    }

    return { ok: true };
  }

  async createGroupAuthCode(context: TenantContext) {
    const code = await this.createAuthCode({
      kind: 'GROUP',
      userId: context.userId,
    });

    return {
      code: code.code,
      expiresAt: code.expiresAt,
      instruction: `/autorizar_grupo ${code.code}`,
    };
  }

  async createMemberAuthCode(context: TenantContext) {
    const [profile, group] = await Promise.all([
      this.prisma.memberProfile.findFirst({
        where: {
          id: context.authorProfileId,
          userId: context.userId,
          familyId: context.familyId,
          status: 'active',
        },
        select: { id: true },
      }),
      this.prisma.telegramAuthorizedGroup.findFirst({
        where: { familyId: context.familyId, revokedAt: null },
        select: { id: true },
      }),
    ]);
    if (!profile) {
      throw new BadRequestException('Perfil ativo não encontrado');
    }
    if (!group) {
      throw new BadRequestException('O owner precisa autorizar o grupo da família antes do vínculo.');
    }

    const code = await this.createAuthCode({
      kind: 'MEMBER',
      userId: context.userId,
      memberProfileId: profile.id,
    });

    return {
      code: code.code,
      expiresAt: code.expiresAt,
      instruction: `/vincular ${code.code}`,
    };
  }

  async getStatus(context: TenantContext) {
    const group = await this.prisma.telegramAuthorizedGroup.findFirst({
      where: { familyId: context.familyId, revokedAt: null },
      select: { chatId: true },
    });
    if (!group) {
      return {
        group: { authorized: false },
        member: { linked: false },
      };
    }

    const link = await this.prisma.telegramUserLink.findFirst({
      where: {
        chatId: group.chatId,
        familyId: context.familyId,
        memberProfileId: context.authorProfileId,
        revokedAt: null,
      },
      select: { id: true },
    });

    return {
      group: { authorized: true },
      member: { linked: Boolean(link) },
    };
  }

  @Cron('*/1 * * * *')
  async recoverStuckUpdates() {
    if (this.recovering) return;
    this.recovering = true;

    try {
      const minutes = this.config.get<number>('TELEGRAM_UPDATE_RECOVERY_MINUTES') ?? 5;
      const cutoff = new Date(Date.now() - minutes * 60_000);
      const stuck = await this.prisma.telegramUpdate.findMany({
        where: {
          status: { in: ['received', 'processing'] },
          receivedAt: { lte: cutoff },
        },
        select: { updateId: true },
        orderBy: { receivedAt: 'asc' },
        take: 20,
      });

      for (const update of stuck) {
        this.enqueue(update.updateId);
      }
    } finally {
      this.recovering = false;
    }
  }

  private assertWebhookSecret(secretToken?: string) {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!timingSafeStringEqual(expected, secretToken)) {
      throw new UnauthorizedException('Telegram webhook secret inválido');
    }
  }

  private resolveUpdateId(payload: TelegramUpdatePayload) {
    if (payload.update_id === undefined || payload.update_id === null) {
      throw new BadRequestException('update_id ausente');
    }

    return String(payload.update_id);
  }

  private async persistUpdate(updateId: string, payload: TelegramUpdatePayload) {
    try {
      await this.prisma.telegramUpdate.create({
        data: {
          updateId,
          status: 'received',
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  private enqueue(updateId: string) {
    this.queue = this.queue
      .then(() => this.processUpdate(updateId))
      .catch((error: unknown) => this.logger.error(`Falha no worker Telegram: ${formatError(error)}`));
  }

  private async processUpdate(updateId: string) {
    const update = await this.prisma.telegramUpdate.findUnique({ where: { updateId } });
    if (!update || update.status === 'succeeded') return;

    await this.prisma.telegramUpdate.update({
      where: { updateId },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    try {
      const finalized = await this.processPayload(updateId, update.payload as unknown as TelegramUpdatePayload);
      if (!finalized) {
        await this.markUpdateSucceeded(updateId);
      }
    } catch (error) {
      await this.markUpdateFailed(updateId, error);
      await this.notifyFailure(update.payload as unknown as TelegramUpdatePayload);
    }
  }

  private async processPayload(updateId: string, payload: TelegramUpdatePayload): Promise<boolean> {
    try {
      return await this.dispatchPayload(updateId, payload);
    } catch (error) {
      if (!(error instanceof TelegramSubscriptionBlockedError)) throw error;
      await this.notifyBlockedTenant(payload, error.decision);
      return false;
    }
  }

  private async dispatchPayload(updateId: string, payload: TelegramUpdatePayload): Promise<boolean> {
    if (payload.edited_message) return false;
    if (payload.callback_query) {
      return this.handleCallbackQuery(updateId, payload.callback_query);
    }

    const message = payload.message;
    if (!message?.text || !message.from || message.from.is_bot) return false;
    if (message.forward_from || message.forward_from_chat || message.via_bot) return false;

    const text = message.text.trim();
    if (!text) return false;

    if (text.startsWith('/')) {
      return this.handleCommand(updateId, message, text);
    }

    return this.handleFinancialMessage(updateId, message, text);
  }

  private async handleCommand(updateId: string, message: TelegramMessagePayload, text: string) {
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    if (command === '/autorizar_grupo') {
      await this.authorizeGroup(updateId, message, args[0]);
      return true;
    }

    if (command === '/vincular') {
      await this.linkMember(updateId, message, args[0]);
      return true;
    }

    if (command === '/saldo' || command === '/resumo') {
      await this.sendBalanceSummary(message);
      return false;
    }

    if (command === '/desfazer') {
      await this.requestUndo(message);
      return false;
    }

    return false;
  }

  private async authorizeGroup(updateId: string, message: TelegramMessagePayload, code?: string) {
    const chatId = String(message.chat.id);
    if (!code) {
      await this.telegram.sendMessage(chatId, 'Envie /autorizar_grupo CODIGO.');
      await this.markUpdateSucceeded(updateId);
      return;
    }

    if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') {
      await this.telegram.sendMessage(chatId, 'A autorização só pode ser feita em um grupo ou supergrupo.');
      await this.markUpdateSucceeded(updateId);
      return;
    }

    const result = await this.withTelegramTransactionRetry(
      async (tx) => {
        const codeTarget = await tx.telegramAuthCode.findUnique({
          where: { code },
          select: { user: { select: { familyId: true } } },
        });
        if (codeTarget?.user) {
          await this.lockFamily(tx, codeTarget.user.familyId);
        }
        const now = new Date();

        const authCode = await tx.telegramAuthCode.findUnique({
          where: { code },
          include: {
            user: {
              include: {
                family: {
                  select: {
                    ownerUserId: true,
                    currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
                  },
                },
              },
            },
          },
        });

        if (
          !authCode ||
          authCode.kind !== 'GROUP' ||
          authCode.consumedAt ||
          authCode.expiresAt <= now ||
          !authCode.user ||
          !authCode.user.isActive ||
          authCode.user.family.ownerUserId !== authCode.user.id
        ) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return { ok: false as const, message: 'Código inválido ou expirado.' };
        }

        const chatOwner = await tx.telegramAuthorizedGroup.findUnique({
          where: { chatId },
          select: { familyId: true },
        });
        if (chatOwner && chatOwner.familyId !== authCode.user.familyId) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return { ok: false as const, message: 'Este grupo já pertence a outra família.' };
        }

        const subscriptionAccess = this.subscriptionAccessPolicy.evaluate(
          authCode.user.family.currentSubscription,
        );
        if (!this.subscriptionAccessPolicy.allows(subscriptionAccess)) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return {
            ok: false as const,
            message: blockedTenantGuidance(subscriptionAccess),
          };
        }

        const previousGroups = await tx.telegramAuthorizedGroup.findMany({
          where: {
            familyId: authCode.user.familyId,
            chatId: { not: chatId },
            revokedAt: null,
          },
          select: { chatId: true },
        });
        const previousChatIds = previousGroups.map((group) => group.chatId);
        if (previousChatIds.length > 0) {
          await tx.telegramAuthorizedGroup.updateMany({
            where: {
              familyId: authCode.user.familyId,
              chatId: { in: previousChatIds },
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
          await tx.telegramUserLink.updateMany({
            where: {
              familyId: authCode.user.familyId,
              chatId: { in: previousChatIds },
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
          await tx.telegramPendingConfirmation.updateMany({
            where: {
              chatId: { in: previousChatIds },
              status: 'PENDING',
              memberProfile: { familyId: authCode.user.familyId },
            },
            data: { status: 'CANCELLED', resolvedAt: now },
          });
        }

        await tx.telegramAuthorizedGroup.upsert({
          where: { chatId },
          update: {
            authorizedByUserId: authCode.user.id,
            revokedAt: null,
          },
          create: {
            chatId,
            familyId: authCode.user.familyId,
            authorizedByUserId: authCode.user.id,
          },
        });
        const claimedCode = await tx.telegramAuthCode.updateMany({
          where: { id: authCode.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (claimedCode.count !== 1) {
          throw new BadRequestException('Código inválido ou expirado');
        }
        await tx.telegramUpdate.update({
          where: { updateId },
          data: { status: 'succeeded', processedAt: now, lastError: null },
        });

        return { ok: true as const, message: 'Grupo autorizado para lançamentos financeiros.' };
      },
    );

    await this.telegram.sendMessage(chatId, result.message);
  }

  private async linkMember(updateId: string, message: TelegramMessagePayload, code?: string) {
    const chatId = String(message.chat.id);
    const tgUserId = this.getTelegramUserId(message);
    if (!tgUserId) {
      await this.markUpdateSucceeded(updateId);
      return;
    }

    if (!code) {
      await this.telegram.sendMessage(chatId, 'Envie /vincular CODIGO.');
      await this.markUpdateSucceeded(updateId);
      return;
    }

    if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') {
      await this.telegram.sendMessage(chatId, 'O vínculo só pode ser feito no grupo autorizado.');
      await this.markUpdateSucceeded(updateId);
      return;
    }

    const result = await this.withTelegramTransactionRetry(
      async (tx) => {
        const groupTarget = await tx.telegramAuthorizedGroup.findUnique({
          where: { chatId },
          select: { familyId: true },
        });
        if (groupTarget) {
          await this.lockFamily(tx, groupTarget.familyId);
        }
        const now = new Date();

        const group = await tx.telegramAuthorizedGroup.findUnique({
          where: { chatId },
          include: {
            family: {
              select: { currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT } },
            },
          },
        });
        const authCode = await tx.telegramAuthCode.findUnique({
          where: { code },
          include: { memberProfile: { include: { user: true } } },
        });

        if (!group || group.revokedAt) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return { ok: false as const, message: 'Este grupo ainda não está autorizado.' };
        }

        if (
          !authCode ||
          authCode.kind !== 'MEMBER' ||
          authCode.consumedAt ||
          authCode.expiresAt <= now ||
          !authCode.memberProfile ||
          authCode.memberProfile.status !== 'active' ||
          !authCode.memberProfile.user.isActive ||
          authCode.memberProfile.userId !== authCode.userId ||
          authCode.memberProfile.user.familyId !== group.familyId ||
          authCode.memberProfile.familyId !== group.familyId
        ) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return { ok: false as const, message: 'Código inválido ou expirado.' };
        }

        const subscriptionAccess = this.subscriptionAccessPolicy.evaluate(
          group.family.currentSubscription,
        );
        if (!this.subscriptionAccessPolicy.allows(subscriptionAccess)) {
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: now, lastError: null },
          });
          return {
            ok: false as const,
            message: blockedTenantGuidance(subscriptionAccess),
          };
        }

        await tx.telegramUserLink.updateMany({
          where: {
            chatId,
            familyId: group.familyId,
            memberProfileId: authCode.memberProfile.id,
            revokedAt: null,
            NOT: { tgUserId },
          },
          data: { revokedAt: now },
        });
        await tx.telegramPendingConfirmation.updateMany({
          where: {
            chatId,
            memberProfileId: authCode.memberProfile.id,
            status: 'PENDING',
            NOT: { tgUserId },
          },
          data: { status: 'CANCELLED', resolvedAt: now },
        });
        await tx.telegramUserLink.upsert({
          where: { tgUserId_chatId: { tgUserId, chatId } },
          update: {
            familyId: group.familyId,
            memberProfileId: authCode.memberProfile.id,
            revokedAt: null,
          },
          create: {
            tgUserId,
            chatId,
            familyId: group.familyId,
            memberProfileId: authCode.memberProfile.id,
          },
        });
        const claimedCode = await tx.telegramAuthCode.updateMany({
          where: { id: authCode.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (claimedCode.count !== 1) {
          throw new BadRequestException('Código inválido ou expirado');
        }
        await tx.telegramUpdate.update({
          where: { updateId },
          data: { status: 'succeeded', processedAt: now, lastError: null },
        });

        return {
          ok: true as const,
          message:
            'Vínculo criado. Mensagens financeiras deste grupo serão enviadas à OpenAI para interpretação e ficarão armazenadas por 30 dias para depuração.',
        };
      },
    );

    await this.telegram.sendMessage(chatId, result.message);
    if (result.ok) {
      await this.trySendPrivacyNotice(tgUserId);
    }
  }

  private async sendBalanceSummary(message: TelegramMessagePayload) {
    const context = await this.resolveLinkedContext(message);
    if (!context) return;

    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);
    const accounts = await this.prisma.account.findMany({
      where: { memberProfileId: context.memberProfileId },
      orderBy: { name: 'asc' },
    });
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: context.memberProfileId,
        status: 'confirmed',
        applicationDate: { lte: endOfDay(now) },
        ...this.tenantScope.consistentTransactionRelations(context.tenant),
      },
      include: { account: true },
    });
    const monthTransactions = transactions.filter(
      (transaction) => transaction.referenceMonth >= monthStart && transaction.referenceMonth <= monthEnd,
    );
    const expenseTotal = expenseCents(
      monthTransactions.filter((transaction) => !this.isInvoicePaymentTransaction(transaction)),
    );

    const lines = accounts.map((account) => {
      const accountTransactions = transactions.filter((transaction) => transaction.accountId === account.id);
      const balance = account.initialBalanceCents + accountBalanceCents(accountTransactions);
      return `${account.name}: ${formatMoney(balance)}`;
    });

    await this.telegram.sendMessage(
      context.chatId,
      [`Saldo atual`, ...lines, `Despesas do mês: ${formatMoney(expenseTotal)}`].join('\n'),
    );
  }

  private async requestUndo(message: TelegramMessagePayload) {
    const context = await this.resolveLinkedContext(message);
    if (!context) return;

    const minutes = this.config.get<number>('TELEGRAM_UNDO_WINDOW_MINUTES') ?? 10;
    const operation = await this.prisma.telegramFinancialOperation.findFirst({
      where: {
        memberProfileId: context.memberProfileId,
        tgUserId: context.tgUserId,
        status: 'CREATED',
        undoneAt: null,
        createdAt: { gte: new Date(Date.now() - minutes * 60_000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!operation) {
      await this.telegram.sendMessage(context.chatId, 'Não encontrei lançamento recente para desfazer.');
      return;
    }

    await this.createPendingConfirmation(
      context,
      {
        kind: 'UNDO_OPERATION',
        operationId: operation.id,
      },
      `Desfazer o último lançamento criado pelo Telegram?`,
      new Date(operation.createdAt.getTime() + minutes * 60_000),
    );
  }

  private async handleFinancialMessage(updateId: string, message: TelegramMessagePayload, text: string) {
    let context = await this.resolveLinkedContext(message);
    if (!context) return false;

    const aiContext = await this.buildAiContext(context);
    const contextBeforeAi = await this.resolveLinkedContextFromIds(context.chatId, context.tgUserId);
    if (!contextBeforeAi || contextBeforeAi.memberProfileId !== context.memberProfileId) return false;
    context = contextBeforeAi;

    const aiResult = await this.aiProvider.parseFinancialMessage({
      text,
      today: todayKey(),
      timezone: 'America/Sao_Paulo',
      accounts: aiContext.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        institution: account.institution,
        lastFourDigits: account.lastFourDigits,
      })),
      categories: aiContext.categories.map((category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
        aliases: category.aliases,
      })),
    });

    const contextAfterAi = await this.resolveLinkedContextFromIds(context.chatId, context.tgUserId);
    if (!contextAfterAi || contextAfterAi.memberProfileId !== context.memberProfileId) return false;
    context = contextAfterAi;

    await this.prisma.telegramMessageLog.create({
      data: {
        chatId: context.chatId,
        tgUserId: context.tgUserId,
        messageId: message.message_id,
        memberProfileId: context.memberProfileId,
        textRaw: text,
        aiResponseJson: aiResult.raw as Prisma.InputJsonValue,
        model: aiResult.model,
        tokensIn: aiResult.tokensIn,
        tokensOut: aiResult.tokensOut,
      },
    });

    const ai = aiResult.parsed;
    if (ai.intent === 'NON_FINANCIAL') return false;
    if (ai.intent === 'UNCLEAR' || ai.confidence < 0.4) {
      await this.telegram.sendMessage(context.chatId, 'Não entendi se foi gasto ou receita. Pode reformular?');
      return false;
    }
    if (ai.intent === 'RECURRING_UNSUPPORTED') {
      await this.telegram.sendMessage(
        context.chatId,
        'Recorrências são configuradas direto no app. Posso lançar só o mês atual? Envie novamente como lançamento único.',
      );
      return false;
    }

    const draft = this.buildFinancialDraft(ai, aiContext, text, message.message_id);
    if (!draft) {
      await this.telegram.sendMessage(context.chatId, 'Não consegui identificar valor, data ou descrição. Pode reformular?');
      return false;
    }

    const shouldConfirm = this.shouldConfirm(ai, draft, aiContext);
    if (shouldConfirm) {
      await this.createPendingConfirmation(
        context,
        { kind: 'FINANCIAL_DRAFT', draft },
        `Confirma este lançamento?\n${this.formatDraft(draft, aiContext)}`,
      );
      return false;
    }

    const idempotencyKey = `tg:msg:${context.chatId}:${message.message_id}`;
    const operation = await this.tryCreateFinancialOperation(updateId, context, draft, idempotencyKey);
    if (operation.duplicate) {
      await this.safeSendMessage(
        context.chatId,
        `Lançamento não criado: já existe um lançamento igual.\n${this.formatDraft(draft, aiContext)}`,
      );
      return true;
    }

    await this.safeSendMessage(
      context.chatId,
      operation.alreadyExisted ? 'Lançamento já processado anteriormente.' : `Lançamento criado.\n${this.formatDraft(draft, aiContext)}`,
    );
    return true;
  }

  private async handleCallbackQuery(updateId: string, callback: TelegramCallbackQueryPayload) {
    const data = callback.data ?? '';
    const match = /^tg:([A-Za-z0-9_-]{8,24}):(confirm|cancel|edit)$/.exec(data);
    if (!match || !callback.message) {
      await this.safeAnswerCallbackQuery(callback.id);
      return false;
    }

    const [, pendingId, action] = match;
    const pending = await this.prisma.telegramPendingConfirmation.findUnique({ where: { id: pendingId } });
    const chatId = String(callback.message.chat.id);
    const tgUserId = String(callback.from.id);

    if (!pending || pending.chatId !== chatId) {
      await this.safeAnswerCallbackQuery(callback.id, 'Confirmação não encontrada.');
      return false;
    }

    if (pending.tgUserId !== tgUserId) {
      await this.safeAnswerCallbackQuery(callback.id, 'Só quem enviou a mensagem original pode confirmar.', true);
      return false;
    }

    if (pending.status !== 'PENDING' || pending.expiresAt <= new Date()) {
      await this.expirePendingIfNeeded(pending.id, pending.expiresAt);
      await this.safeAnswerCallbackQuery(callback.id, 'Confirmação expirada ou já resolvida.');
      return false;
    }

    if (action === 'edit') {
      await this.safeAnswerCallbackQuery(callback.id, 'Edição pelo Telegram ainda não está disponível.');
      return false;
    }

    if (action === 'cancel') {
      await this.prisma.$transaction(async (tx) => {
        await tx.telegramPendingConfirmation.update({
          where: { id: pending.id },
          data: { status: 'CANCELLED', resolvedAt: new Date() },
        });
        await tx.telegramUpdate.update({
          where: { updateId },
          data: { status: 'succeeded', processedAt: new Date(), lastError: null },
        });
      });
      await this.safeAnswerCallbackQuery(callback.id, 'Cancelado.');
      await this.safeReplaceMessage(chatId, callback.message.message_id, 'Lançamento cancelado.');
      return true;
    }

    const payload = telegramPendingPayloadSchema.parse(pending.payload);
    if (payload.kind === 'UNDO_OPERATION') {
      await this.confirmUndo(updateId, callback, pending.id, payload);
      return true;
    }

    const context = await this.resolveLinkedContextFromIds(chatId, tgUserId);
    if (!context || context.memberProfileId !== pending.memberProfileId) {
      await this.safeAnswerCallbackQuery(callback.id, 'Vínculo não encontrado.');
      return false;
    }

    const aiContext = await this.buildAiContext(context);
    const idempotencyKey = `tg:pending:${pending.id}`;
    const operation = await this.tryCreateFinancialOperation(
      updateId,
      context,
      payload.draft,
      idempotencyKey,
      pending.id,
    );
    if (operation.duplicate) {
      await this.prisma.$transaction(async (tx) => {
        await tx.telegramPendingConfirmation.update({
          where: { id: pending.id },
          data: { status: 'CANCELLED', resolvedAt: new Date() },
        });
        await tx.telegramUpdate.update({
          where: { updateId },
          data: { status: 'succeeded', processedAt: new Date(), lastError: null },
        });
      });
      await this.safeAnswerCallbackQuery(callback.id, 'Lançamento duplicado.');
      await this.safeReplaceMessage(
        chatId,
        callback.message.message_id,
        `Lançamento não criado: já existe um lançamento igual.\n${this.formatDraft(payload.draft, aiContext)}`,
      );
      return true;
    }

    await this.safeAnswerCallbackQuery(callback.id, 'Confirmado.');
    await this.safeReplaceMessage(
      chatId,
      callback.message.message_id,
      `Lançamento criado.\n${this.formatDraft(payload.draft, aiContext)}`,
    );
    return true;
  }

  private async confirmUndo(
    updateId: string,
    callback: TelegramCallbackQueryPayload,
    pendingId: string,
    payload: Extract<TelegramPendingPayload, { kind: 'UNDO_OPERATION' }>,
  ) {
    const chatId = String(callback.message?.chat.id);
    const tgUserId = String(callback.from.id);
    const context = await this.resolveLinkedContextFromIds(chatId, tgUserId);
    if (!context) {
      await this.safeAnswerCallbackQuery(callback.id, 'Vínculo não encontrado.');
      return;
    }

    const undoWindowMinutes = this.config.get<number>('TELEGRAM_UNDO_WINDOW_MINUTES') ?? 10;
    const undoResult = await this.withLockedFamilyTransaction(
      context.familyId,
      async (tx) => {
        const undoCutoff = new Date(Date.now() - undoWindowMinutes * 60_000);
        const currentContext = await this.resolveLinkedContextFromIds(context.chatId, context.tgUserId, tx);
        if (!currentContext || currentContext.memberProfileId !== context.memberProfileId) {
          throw new UnauthorizedException('Vínculo Telegram não está mais ativo');
        }

        const operation = await tx.telegramFinancialOperation.findFirst({
          where: {
            id: payload.operationId,
            memberProfileId: currentContext.memberProfileId,
            tgUserId: currentContext.tgUserId,
            chatId: currentContext.chatId,
            status: 'CREATED',
            undoneAt: null,
            createdAt: { gte: undoCutoff },
          },
        });
        if (!operation) {
          await tx.telegramPendingConfirmation.update({
            where: {
              id: pendingId,
              memberProfileId: currentContext.memberProfileId,
              tgUserId: currentContext.tgUserId,
              chatId: currentContext.chatId,
              status: 'PENDING',
            },
            data: { status: 'CANCELLED', resolvedAt: new Date() },
          });
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: new Date(), lastError: null },
          });
          return 'expired' as const;
        }

        if (operation.transactionId) {
          const removed = await tx.transaction.deleteMany({
            where: {
              id: operation.transactionId,
              memberProfileId: currentContext.memberProfileId,
              installmentPlanId: null,
              ...this.tenantScope.consistentTransactionRelations(currentContext.tenant),
            },
          });
          if (removed.count !== 1) {
            await tx.telegramPendingConfirmation.update({
              where: {
                id: pendingId,
                memberProfileId: currentContext.memberProfileId,
                tgUserId: currentContext.tgUserId,
                chatId: currentContext.chatId,
                status: 'PENDING',
              },
              data: { status: 'CANCELLED', resolvedAt: new Date() },
            });
            await tx.telegramUpdate.update({
              where: { updateId },
              data: { status: 'succeeded', processedAt: new Date(), lastError: null },
            });
            return 'linked' as const;
          }
        }
        if (operation.installmentPlanId) {
          await this.installmentsService.removeTelegramCreatedPlanInTransaction(
            tx,
            currentContext.tenant,
            operation.installmentPlanId,
          );
        }

        await tx.telegramFinancialOperation.update({
          where: {
            id: operation.id,
            memberProfileId: currentContext.memberProfileId,
            tgUserId: currentContext.tgUserId,
            chatId: currentContext.chatId,
            status: 'CREATED',
          },
          data: {
            status: 'UNDONE',
            undoneAt: new Date(),
            undoPendingConfirmationId: pendingId,
          },
        });

        await tx.telegramPendingConfirmation.update({
          where: {
            id: pendingId,
            memberProfileId: currentContext.memberProfileId,
            tgUserId: currentContext.tgUserId,
            chatId: currentContext.chatId,
            status: 'PENDING',
          },
          data: { status: 'CONFIRMED', resolvedAt: new Date() },
        });
        await tx.telegramUpdate.update({
          where: { updateId },
          data: { status: 'succeeded', processedAt: new Date(), lastError: null },
        });
        return 'undone' as const;
      },
    );

    if (undoResult === 'expired') {
      await this.safeAnswerCallbackQuery(callback.id, 'A janela para desfazer expirou.');
      if (callback.message) {
        await this.safeReplaceMessage(chatId, callback.message.message_id, 'A janela para desfazer expirou.');
      }
      return;
    }

    if (undoResult === 'linked') {
      const message = 'O lançamento agora pertence a um parcelamento e não pode ser desfeito isoladamente.';
      await this.safeAnswerCallbackQuery(callback.id, message, true);
      if (callback.message) {
        await this.safeReplaceMessage(chatId, callback.message.message_id, message);
      }
      return;
    }

    await this.safeAnswerCallbackQuery(callback.id, 'Desfeito.');
    if (callback.message) {
      await this.safeReplaceMessage(chatId, callback.message.message_id, 'Lançamento desfeito.');
    }
  }

  private async tryCreateFinancialOperation(
    updateId: string,
    context: LinkedTelegramContext,
    draft: FinancialDraft,
    idempotencyKey: string,
    pendingConfirmationId?: string,
  ) {
    try {
      return await this.withLockedFamilyTransaction(
        context.familyId,
        async (tx) => {
          const currentContext = await this.resolveLinkedContextFromIds(context.chatId, context.tgUserId, tx);
          if (!currentContext || currentContext.memberProfileId !== context.memberProfileId) {
            throw new UnauthorizedException('Vínculo Telegram não está mais ativo');
          }

          const created = await this.createFinancialOperation(
            tx,
            currentContext,
            draft,
            idempotencyKey,
            updateId,
            pendingConfirmationId,
          );
          if (pendingConfirmationId) {
            await tx.telegramPendingConfirmation.update({
              where: {
                id: pendingConfirmationId,
                memberProfileId: currentContext.memberProfileId,
                tgUserId: currentContext.tgUserId,
                chatId: currentContext.chatId,
                status: 'PENDING',
              },
              data: { status: 'CONFIRMED', resolvedAt: new Date() },
            });
          }
          await tx.telegramUpdate.update({
            where: { updateId },
            data: { status: 'succeeded', processedAt: new Date(), lastError: null },
          });
          return { ...created, duplicate: false as const };
        },
      );
    } catch (error) {
      if (!isStrongDuplicateError(error)) throw error;
      await this.markUpdateSucceeded(updateId);
      return { duplicate: true as const, alreadyExisted: false as const, operation: null };
    }
  }

  private async createFinancialOperation(
    tx: Prisma.TransactionClient,
    context: LinkedTelegramContext,
    draft: FinancialDraft,
    idempotencyKey: string,
    sourceUpdateId: string,
    pendingConfirmationId?: string,
  ) {
    const existing = await tx.telegramFinancialOperation.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return { alreadyExisted: true, operation: existing };
    }

    if (draft.action === 'INSTALLMENT_PLAN') {
      const installments = draft.installments?.count ?? 1;
      const monthlyAmountCents = draft.installments?.totalIsKnown
        ? Math.round(draft.amountCents / installments)
        : draft.amountCents;
      const totalAmountCents = monthlyAmountCents * installments;
      const plan = await this.installmentsService.createInTransaction(tx, context.tenant, {
        description: draft.description,
        totalInstallments: installments,
        firstInstallmentNumber: 1,
        paidInstallments: 0,
        monthlyAmountCents,
        totalAmountCents,
        startsAt: draft.applicationDate,
        firstApplicationDate: draft.applicationDate,
        firstReferenceMonth: draft.referenceMonth ?? startOfMonth(new Date(draft.applicationDate)).toISOString(),
        accountId: draft.accountId,
        categoryId: draft.categoryId,
      });
      const operation = await tx.telegramFinancialOperation.create({
        data: {
          idempotencyKey,
          kind: 'INSTALLMENT_PLAN',
          status: 'CREATED',
          memberProfileId: context.memberProfileId,
          tgUserId: context.tgUserId,
          chatId: context.chatId,
          sourceUpdateId,
          sourceMessageId: draft.sourceMessageId,
          pendingConfirmationId,
          installmentPlanId: plan.id,
        },
      });
      return { alreadyExisted: false, operation };
    }

    const transaction = await this.transactionsService.createInTransaction(tx, context.tenant, {
      applicationDate: draft.applicationDate,
      referenceMonth: draft.referenceMonth,
      description: draft.description,
      amountCents: draft.amountCents,
      type: draft.transactionType ?? 'expense',
      source: 'telegram',
      externalId: idempotencyKey,
      accountId: draft.accountId,
      categoryId: draft.categoryId,
      allowDuplicate: true,
    });
    const operation = await tx.telegramFinancialOperation.create({
      data: {
        idempotencyKey,
        kind: 'TRANSACTION',
        status: 'CREATED',
        memberProfileId: context.memberProfileId,
        tgUserId: context.tgUserId,
        chatId: context.chatId,
        sourceUpdateId,
        sourceMessageId: draft.sourceMessageId,
        pendingConfirmationId,
        transactionId: transaction.id,
      },
    });
    return { alreadyExisted: false, operation };
  }

  private buildFinancialDraft(
    ai: TelegramAiResponse,
    context: { accounts: AccountCandidate[]; categories: CategoryCandidate[] },
    originalText: string,
    sourceMessageId: number,
  ): FinancialDraft | null {
    if (!ai.amount?.value) return null;
    const transactionType = ai.intent === 'INCOME' ? 'income' : 'expense';
    const amountCents = Math.round(ai.amount.value * 100);
    const applicationDate = ai.date ?? todayKey();
    const account = this.resolveAccount(ai.accountHint, context.accounts);
    const category = this.resolveCategory(ai.categoryHint, context.categories, transactionType);
    const action = ai.intent === 'INSTALLMENT' ? 'INSTALLMENT_PLAN' : 'TRANSACTION';
    const description = cleanDescription(ai.description ?? originalText);
    const installments = ai.installments?.count && ai.installments.count > 1 ? ai.installments : undefined;

    const draft = {
      action,
      transactionType,
      amountCents,
      applicationDate,
      description,
      accountId: account?.id,
      categoryId: category?.id,
      installments,
      sourceMessageId,
    };

    return financialDraftSchema.parse(draft);
  }

  private shouldConfirm(
    ai: TelegramAiResponse,
    draft: FinancialDraft,
    context: { accounts: AccountCandidate[] },
  ) {
    const threshold = this.config.get<number>('TELEGRAM_AI_CONFIDENCE_THRESHOLD') ?? 0.85;
    const account = draft.accountId ? context.accounts.find((item) => item.id === draft.accountId) : null;
    if (draft.action === 'INSTALLMENT_PLAN') return true;
    if (account?.type === 'credit_card') return true;
    if (ai.confidence < threshold) return true;
    return ai.missingFields.length > 0;
  }

  private async createPendingConfirmation(
    context: LinkedTelegramContext,
    payload: TelegramPendingPayload,
    text: string,
    expiresAt?: Date,
  ) {
    const ttlHours = this.config.get<number>('TELEGRAM_PENDING_TTL_HOURS') ?? 24;
    const defaultExpiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const effectiveExpiresAt = expiresAt && expiresAt < defaultExpiresAt ? expiresAt : defaultExpiresAt;
    const id = randomShortId();
    const pending = await this.withLockedFamilyTransaction(context.familyId, async (tx) => {
      const currentContext = await this.resolveLinkedContextFromIds(context.chatId, context.tgUserId, tx);
      if (!currentContext || currentContext.memberProfileId !== context.memberProfileId) {
        return null;
      }
      if (effectiveExpiresAt <= new Date()) {
        return null;
      }

      return tx.telegramPendingConfirmation.create({
        data: {
          id,
          chatId: currentContext.chatId,
          memberProfileId: currentContext.memberProfileId,
          tgUserId: currentContext.tgUserId,
          payload: toJsonInput(payload),
          expiresAt: effectiveExpiresAt,
        },
      });
    });
    if (!pending) return false;

    const sent = await this.telegram.sendMessage(context.chatId, text, {
      inline_keyboard: [
        [
          { text: 'Confirmar', callback_data: `tg:${pending.id}:confirm` },
          { text: 'Cancelar', callback_data: `tg:${pending.id}:cancel` },
        ],
      ],
    });
    const messageId = readTelegramMessageId(sent);
    if (messageId) {
      await this.prisma.telegramPendingConfirmation.update({
        where: { id: pending.id },
        data: { messageId },
      });
    }
    return true;
  }

  private async buildAiContext(context: LinkedTelegramContext) {
    const [accounts, categories] = await Promise.all([
      this.prisma.account.findMany({
        where: { memberProfileId: context.memberProfileId },
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
        take: 8,
      }),
      this.prisma.category.findMany({
        where: { familyId: context.familyId },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        take: 12,
      }),
    ]);

    return { accounts, categories };
  }

  private async resolveLinkedContext(message: TelegramMessagePayload) {
    const tgUserId = this.getTelegramUserId(message);
    if (!tgUserId) return null;
    return this.resolveLinkedContextFromIds(String(message.chat.id), tgUserId);
  }

  private async resolveLinkedContextFromIds(
    chatId: string,
    tgUserId: string,
    client: TelegramPrismaExecutor = this.prisma,
  ): Promise<LinkedTelegramContext | null> {
    const group = await client.telegramAuthorizedGroup.findUnique({
      where: { chatId },
      include: {
        family: {
          select: {
            ownerUserId: true,
            currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
          },
        },
      },
    });
    if (!group || group.revokedAt) return null;

    const link = await client.telegramUserLink.findUnique({
      where: { tgUserId_chatId: { tgUserId, chatId } },
      include: {
        memberProfile: {
          include: { user: true },
        },
      },
    });
    if (
      !link ||
      link.revokedAt ||
      link.familyId !== group.familyId ||
      !link.memberProfile.user.isActive ||
      link.memberProfile.user.familyId !== group.familyId ||
      link.memberProfile.familyId !== group.familyId ||
      link.memberProfile.status !== 'active'
    ) {
      return null;
    }

    const subscriptionAccess = this.subscriptionAccessPolicy.evaluate(
      group.family.currentSubscription,
    );
    if (!this.subscriptionAccessPolicy.allows(subscriptionAccess)) {
      throw new TelegramSubscriptionBlockedError(subscriptionAccess);
    }

    return {
      chatId,
      tgUserId,
      memberProfileId: link.memberProfileId,
      familyId: group.familyId,
      tenant: TenantContext.fromAuthenticatedUser({
        id: link.memberProfile.user.id,
        email: link.memberProfile.user.email,
        platformRole: link.memberProfile.user.platformRole,
        tenantRole: group.family.ownerUserId === link.memberProfile.user.id ? 'owner' : 'member',
        familyId: group.familyId,
        profileId: link.memberProfileId,
      }),
    };
  }

  private getTelegramUserId(message: TelegramMessagePayload) {
    return message.from?.id ? String(message.from.id) : null;
  }

  private resolveAccount(hint: string | null, accounts: AccountCandidate[]) {
    if (!hint) return accounts.length === 1 ? accounts[0] : null;
    const normalizedHint = normalizeText(hint);
    return (
      accounts.find((account) => normalizeText(account.name) === normalizedHint) ??
      accounts.find((account) =>
        [account.name, account.institution, account.lastFourDigits].some((value) =>
          value ? normalizeText(value).includes(normalizedHint) || normalizedHint.includes(normalizeText(value)) : false,
        ),
      ) ??
      null
    );
  }

  private resolveCategory(hint: string | null, categories: CategoryCandidate[], type: 'income' | 'expense') {
    const candidates = categories.filter((category) => category.type === type);
    if (hint) {
      const normalizedHint = normalizeText(hint);
      const match =
        candidates.find((category) => normalizeText(category.name) === normalizedHint) ??
        candidates.find((category) =>
          [category.name, ...category.aliases].some((value) => {
            const normalized = normalizeText(value);
            return normalized.includes(normalizedHint) || normalizedHint.includes(normalized);
          }),
        );
      if (match) return match;
    }

    return candidates.find((category) => normalizeText(category.name) === 'outros') ?? null;
  }

  private formatDraft(draft: FinancialDraft, context: { accounts: AccountCandidate[]; categories: CategoryCandidate[] }) {
    const account = draft.accountId ? context.accounts.find((item) => item.id === draft.accountId)?.name : 'Sem conta';
    const category = draft.categoryId ? context.categories.find((item) => item.id === draft.categoryId)?.name : 'Sem categoria';
    const kind = draft.action === 'INSTALLMENT_PLAN' ? 'Parcelamento' : draft.transactionType === 'income' ? 'Receita' : 'Despesa';
    const installmentText = draft.installments ? `\nParcelas: ${draft.installments.count}` : '';
    return [
      `Tipo: ${kind}`,
      `Descrição: ${draft.description}`,
      `Valor: ${formatMoney(draft.amountCents)}`,
      `Data: ${formatDate(draft.applicationDate)}`,
      `Conta: ${account}`,
      `Categoria: ${category}${installmentText}`,
    ].join('\n');
  }

  private async markUpdateSucceeded(updateId: string) {
    await this.prisma.telegramUpdate.update({
      where: { updateId },
      data: { status: 'succeeded', processedAt: new Date(), lastError: null },
    });
  }

  private async markUpdateFailed(updateId: string, error: unknown) {
    await this.prisma.telegramUpdate.update({
      where: { updateId },
      data: {
        status: 'failed',
        processedAt: new Date(),
        lastError: formatError(error).slice(0, 2000),
      },
    });
  }

  private async notifyBlockedTenant(
    payload: TelegramUpdatePayload,
    decision: SubscriptionAccessDecision,
  ) {
    const message = blockedTenantGuidance(decision);
    if (payload.callback_query) {
      await this.safeAnswerCallbackQuery(payload.callback_query.id, message, true);
      return;
    }

    const chatId = payload.message?.chat.id ?? null;
    if (chatId !== null) {
      await this.safeSendMessage(String(chatId), message);
    }
  }

  private async notifyFailure(payload: TelegramUpdatePayload) {
    const chatId =
      payload.message?.chat.id ?? payload.callback_query?.message?.chat.id ?? payload.edited_message?.chat.id ?? null;
    if (!chatId) return;
    await this.safeSendMessage(String(chatId), 'Não consegui processar agora, tente de novo em alguns minutos.');
  }

  private async safeSendMessage(chatId: string, text: string) {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (error) {
      this.logger.warn(`Falha ao enviar mensagem Telegram: ${formatError(error)}`);
    }
  }

  private async safeAnswerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    try {
      await this.telegram.answerCallbackQuery(callbackQueryId, text, showAlert);
    } catch (error) {
      this.logger.warn(`Falha ao responder callback Telegram: ${formatError(error)}`);
    }
  }

  private async safeReplaceMessage(chatId: string, messageId: number, text: string) {
    try {
      await this.telegram.editMessageText(chatId, messageId, text);
    } catch (error) {
      this.logger.warn(`Falha ao editar mensagem Telegram: ${formatError(error)}`);
      await this.safeSendMessage(chatId, text);
    }
  }

  private async trySendPrivacyNotice(tgUserId: string) {
    await this.safeSendMessage(
      tgUserId,
      'Suas mensagens no grupo autorizado serão enviadas à OpenAI para interpretação e ficam armazenadas por 30 dias para depuração.',
    );
  }

  private async expirePendingIfNeeded(id: string, expiresAt: Date) {
    if (expiresAt > new Date()) return;
    await this.prisma.telegramPendingConfirmation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'EXPIRED', resolvedAt: new Date() },
    });
  }

  private isInvoicePaymentTransaction(transaction: {
    type: string;
    description: string;
    isInvoicePayment: boolean;
    account?: { type?: string | null } | null;
  }) {
    if (transaction.isInvoicePayment) return true;
    if (transaction.type !== 'expense' || transaction.account?.type === 'credit_card') return false;
    const description = normalizeText(transaction.description);
    return description.includes('pagamento') && description.includes('fatura');
  }

  private async lockFamily(tx: Prisma.TransactionClient, familyId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Family" WHERE "id" = ${familyId} FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new UnauthorizedException('Família do vínculo Telegram não está mais ativa');
    }
  }

  private async withLockedFamilyTransaction<T>(
    familyId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.withTelegramTransactionRetry(async (tx) => {
      await this.lockFamily(tx, familyId);
      return operation(tx);
    });
  }

  private async withTelegramTransactionRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= TELEGRAM_TRANSACTION_RETRIES; attempt += 1) {
      try {
        // READ COMMITTED is intentional: the Family row is the tenant-wide
        // authorization lock. After waiting for a concurrent revocation, every
        // following statement must observe the newly committed access state.
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        });
      } catch (error) {
        if (isTelegramTransactionConflict(error) && attempt < TELEGRAM_TRANSACTION_RETRIES) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Telegram transaction retry budget exhausted.');
  }

  private async createAuthCode(input: { kind: 'GROUP' | 'MEMBER'; userId: string; memberProfileId?: string }) {
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.telegramAuthCode.create({
          data: {
            code: randomCode(),
            kind: input.kind,
            userId: input.userId,
            memberProfileId: input.memberProfileId,
            expiresAt,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }

    throw new Error('Não foi possível gerar código Telegram único');
  }
}

class TelegramSubscriptionBlockedError extends Error {
  constructor(readonly decision: SubscriptionAccessDecision) {
    super('Assinatura sem acesso ao Telegram');
    this.name = 'TelegramSubscriptionBlockedError';
  }
}

function blockedTenantGuidance(_decision: SubscriptionAccessDecision) {
  return 'A assinatura desta família não permite usar o bot agora. O owner deve abrir Configurações > Assinatura no app para pagar, iniciar um novo checkout ou restabelecer o acesso.';
}

function randomCode() {
  return randomBytes(4).toString('hex').toUpperCase();
}

function randomShortId() {
  return randomBytes(9).toString('base64url');
}

function todayKey() {
  return dateKeyInTimeZone(new Date(), 'America/Sao_Paulo');
}

function dateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cleanDescription(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function readTelegramMessageId(value: unknown) {
  if (!value || typeof value !== 'object' || !('message_id' in value)) return null;
  const messageId = (value as { message_id?: unknown }).message_id;
  return typeof messageId === 'number' ? messageId : null;
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isStrongDuplicateError(error: unknown) {
  if (!(error instanceof BadRequestException)) return false;
  const response = error.getResponse();
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  return 'code' in response && response.code === 'STRONG_DUPLICATE';
}

function isTelegramTransactionConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2034');
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
