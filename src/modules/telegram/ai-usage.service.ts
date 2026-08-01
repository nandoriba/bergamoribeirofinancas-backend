import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiUsageAlertKind,
  AiUsageEventStatus,
  Prisma,
  type AiMemberMonthlyUsage,
  type AiTenantMonthlyUsage,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AppConfig } from '../../shared/configuration';
import type { TenantContext } from '../../shared/tenant-context';
import type { AiParseResult, AiProviderError } from './ai-provider';
import { telegramAiResponseSchema } from './telegram-ai.schema';

export interface AiUsageIdentity {
  familyId: string;
  memberProfileId: string;
  chatId: string;
  tgUserId: string;
}

export interface AiUsageAlertDelivery {
  id: string;
  kind: AiUsageAlertKind;
  messageCount: number;
  messageLimit: number;
  resetAt: Date;
}

export type AiUsageReservation =
  | {
      kind: 'reserved';
      eventId: string;
      alerts: AiUsageAlertDelivery[];
    }
  | {
      kind: 'quota_exceeded';
      eventId: string;
      messageLimit: number;
      messageCount: number;
      resetAt: Date;
      alerts: AiUsageAlertDelivery[];
    }
  | {
      kind: 'replay';
      eventId: string;
      status: AiUsageEventStatus;
      messageLimit: number;
      messageCount: number;
      resetAt: Date;
      alerts: AiUsageAlertDelivery[];
      replayResult?: AiParseResult;
    };

interface UsagePricing {
  provider: string;
  requestedModel: string;
  pricingVersion: string;
  inputUsdPerMillionTokens: Prisma.Decimal;
  outputUsdPerMillionTokens: Prisma.Decimal;
}

interface UsagePeriodSettings extends UsagePricing {
  periodStart: Date;
  resetAt: Date;
  planCode: string;
  messageLimit: number;
  nearLimitMessageCount: number;
}

interface UsageRows {
  tenant: AiTenantMonthlyUsage;
  member: AiMemberMonthlyUsage;
}

export interface AiUsageMeasurement {
  model?: string;
  requestId?: string;
  tokensIn?: number;
  tokensOut?: number;
}

@Injectable()
export class AiUsageService {
  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
  ) {}

  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    identity: AiUsageIdentity,
    sourceUpdateId: string,
    sourceMessageId: number,
    now = new Date(),
  ): Promise<AiUsageReservation> {
    const existing = await tx.aiUsageEvent.findUnique({
      where: { sourceUpdateId },
      include: {
        tenantUsage: true,
        messageLog: true,
      },
    });

    if (existing) {
      this.assertSameIdentity(existing, identity);
      const resetAt = nextUtcMonth(existing.tenantUsage.periodStart);
      let status = existing.status;
      if (status === AiUsageEventStatus.IN_FLIGHT && this.isStale(existing.startedAt, now)) {
        const changed = await tx.aiUsageEvent.updateMany({
          where: { id: existing.id, status: AiUsageEventStatus.IN_FLIGHT },
          data: {
            status: AiUsageEventStatus.AMBIGUOUS,
            failureCode: 'worker_recovery_ambiguous',
            finishedAt: now,
          },
        });
        if (changed.count === 1) status = AiUsageEventStatus.AMBIGUOUS;
      }

      const messageLog = existing.messageLog;
      const replayed = messageLog?.aiResponseJson
        ? telegramAiResponseSchema.safeParse(messageLog.aiResponseJson)
        : undefined;
      return {
        kind: 'replay',
        eventId: existing.id,
        status,
        messageLimit: existing.tenantUsage.messageLimit,
        messageCount: existing.tenantUsage.messages,
        resetAt,
        alerts: await this.pendingAlerts(tx, existing.tenantUsage, resetAt),
        replayResult:
          status === AiUsageEventStatus.SUCCEEDED && messageLog && replayed?.success
            ? {
                raw: messageLog.aiResponseJson,
                parsed: replayed.data,
                model: messageLog.model ?? existing.usedModel ?? existing.requestedModel,
                requestId: existing.providerRequestId ?? undefined,
                tokensIn: messageLog.tokensIn ?? undefined,
                tokensOut: messageLog.tokensOut ?? undefined,
              }
            : undefined,
      };
    }

    const settings = this.periodSettings(now);
    const usage = await this.ensureUsageRows(tx, identity, settings);
    if (usage.tenant.messages >= usage.tenant.messageLimit) {
      const event = await tx.aiUsageEvent.create({
        data: {
          sourceUpdateId,
          sourceMessageId,
          familyId: identity.familyId,
          tenantUsageId: usage.tenant.id,
          memberUsageId: usage.member.id,
          memberProfileId: identity.memberProfileId,
          chatId: identity.chatId,
          tgUserId: identity.tgUserId,
          status: AiUsageEventStatus.BLOCKED_QUOTA,
          provider: settings.provider,
          requestedModel: settings.requestedModel,
          pricingVersion: settings.pricingVersion,
          inputUsdPerMillionTokens: settings.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: settings.outputUsdPerMillionTokens,
          failureCode: 'monthly_quota_exhausted',
          startedAt: now,
          finishedAt: now,
        },
      });
      await Promise.all([
        tx.aiTenantMonthlyUsage.update({
          where: { id: usage.tenant.id },
          data: { blockedMessages: { increment: 1 } },
        }),
        tx.aiMemberMonthlyUsage.update({
          where: { id: usage.member.id },
          data: { blockedMessages: { increment: 1 } },
        }),
        this.ensureAlert(tx, usage.tenant, AiUsageAlertKind.EXHAUSTED),
      ]);

      return {
        kind: 'quota_exceeded',
        eventId: event.id,
        messageLimit: usage.tenant.messageLimit,
        messageCount: usage.tenant.messages,
        resetAt: settings.resetAt,
        alerts: await this.pendingAlerts(tx, usage.tenant, settings.resetAt),
      };
    }

    const consumed = await tx.aiTenantMonthlyUsage.updateMany({
      where: {
        id: usage.tenant.id,
        messages: { lt: usage.tenant.messageLimit },
      },
      data: {
        messages: { increment: 1 },
        measurementIncompleteCount: { increment: 1 },
      },
    });
    if (consumed.count !== 1) {
      throw new Error('AI_USAGE_QUOTA_CONFLICT');
    }

    await tx.aiMemberMonthlyUsage.update({
      where: { id: usage.member.id },
      data: {
        messages: { increment: 1 },
        measurementIncompleteCount: { increment: 1 },
      },
    });

    const event = await tx.aiUsageEvent.create({
      data: {
        sourceUpdateId,
        sourceMessageId,
        familyId: identity.familyId,
        tenantUsageId: usage.tenant.id,
        memberUsageId: usage.member.id,
        memberProfileId: identity.memberProfileId,
        chatId: identity.chatId,
        tgUserId: identity.tgUserId,
        provider: settings.provider,
        requestedModel: settings.requestedModel,
        pricingVersion: settings.pricingVersion,
        inputUsdPerMillionTokens: settings.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: settings.outputUsdPerMillionTokens,
        startedAt: now,
      },
    });

    const messageCount = usage.tenant.messages + 1;
    if (messageCount >= usage.tenant.messageLimit) {
      await this.ensureAlert(tx, usage.tenant, AiUsageAlertKind.EXHAUSTED);
    } else if (messageCount >= usage.tenant.nearLimitMessageCount) {
      await this.ensureAlert(tx, usage.tenant, AiUsageAlertKind.NEAR_LIMIT);
    }

    return {
      kind: 'reserved',
      eventId: event.id,
      alerts: await this.pendingAlerts(
        tx,
        { ...usage.tenant, messages: messageCount },
        settings.resetAt,
      ),
    };
  }

  async complete(
    eventId: string,
    result: AiParseResult,
    message: {
      chatId: string;
      tgUserId: string;
      messageId: number;
      memberProfileId: string;
      textRaw: string;
    },
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (tx) => {
      const finished = await this.finishInTransaction(
        tx,
        eventId,
        AiUsageEventStatus.SUCCEEDED,
        {
          model: result.model,
          requestId: result.requestId,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        },
        undefined,
        now,
      );
      if (!finished.applied) return finished;

      await tx.telegramMessageLog.create({
        data: {
          chatId: message.chatId,
          tgUserId: message.tgUserId,
          messageId: message.messageId,
          memberProfileId: message.memberProfileId,
          textRaw: message.textRaw,
          aiResponseJson: result.raw as Prisma.InputJsonValue,
          model: result.model,
          tokensIn: finished.tokensIn,
          tokensOut: finished.tokensOut,
          costUsd: finished.estimatedCostUsd,
          aiUsageEventId: eventId,
        },
      });
      return finished;
    });
  }

  async fail(eventId: string, error: AiProviderError | unknown, now = new Date()) {
    const providerError = isAiProviderError(error) ? error : undefined;
    const status =
      providerError?.kind === 'RESPONSE_INVALID'
        ? AiUsageEventStatus.RESPONSE_INVALID
        : AiUsageEventStatus.PROVIDER_FAILED;
    const failureCode = providerFailureCode(providerError);

    return this.prisma.$transaction((tx) =>
      this.finishInTransaction(
        tx,
        eventId,
        status,
        {
          model: providerError?.model,
          requestId: providerError?.requestId,
          tokensIn: providerError?.tokensIn,
          tokensOut: providerError?.tokensOut,
        },
        failureCode,
        now,
      ),
    );
  }

  async markAmbiguous(
    eventId: string,
    measurement: AiUsageMeasurement = {},
    failureCode = 'local_finalization_ambiguous',
    now = new Date(),
  ) {
    return this.prisma.$transaction((tx) =>
      this.finishInTransaction(
        tx,
        eventId,
        AiUsageEventStatus.AMBIGUOUS,
        measurement,
        failureCode,
        now,
      ),
    );
  }

  async reconcileStaleEvents(now = new Date()) {
    const recoveryMinutes = this.config.get<number>('TELEGRAM_UPDATE_RECOVERY_MINUTES') ?? 5;
    const cutoff = new Date(now.getTime() - recoveryMinutes * 60_000);
    return this.prisma.aiUsageEvent.updateMany({
      where: {
        status: AiUsageEventStatus.IN_FLIGHT,
        startedAt: { lte: cutoff },
      },
      data: {
        status: AiUsageEventStatus.AMBIGUOUS,
        failureCode: 'worker_recovery_ambiguous',
        finishedAt: now,
      },
    });
  }

  async recordFinancialOperationInTransaction(
    tx: Prisma.TransactionClient,
    aiUsageEventId: string | undefined,
    identity: Pick<AiUsageIdentity, 'familyId' | 'memberProfileId'>,
    occurredAt = new Date(),
  ) {
    if (!aiUsageEventId) return;
    const event = await tx.aiUsageEvent.findFirst({
      where: {
        id: aiUsageEventId,
        familyId: identity.familyId,
        memberProfileId: identity.memberProfileId,
        status: AiUsageEventStatus.SUCCEEDED,
      },
      select: { id: true },
    });
    if (!event) throw new UnauthorizedException('Evento de IA não pertence ao lançamento');

    const settings = this.periodSettings(occurredAt);
    const usage = await this.ensureUsageRows(
      tx,
      {
        familyId: identity.familyId,
        memberProfileId: identity.memberProfileId,
      },
      settings,
    );
    await Promise.all([
      tx.aiTenantMonthlyUsage.update({
        where: { id: usage.tenant.id },
        data: { financialOperations: { increment: 1 } },
      }),
      tx.aiMemberMonthlyUsage.update({
        where: { id: usage.member.id },
        data: { financialOperations: { increment: 1 } },
      }),
    ]);
  }

  async getCurrentUsage(context: TenantContext, now = new Date()) {
    const settings = this.periodSettings(now);
    const tenant = await this.prisma.aiTenantMonthlyUsage.findUnique({
      where: {
        familyId_periodStart: {
          familyId: context.familyId,
          periodStart: settings.periodStart,
        },
      },
      include: {
        memberUsages: {
          where: { memberProfileId: context.authorProfileId },
          take: 1,
        },
      },
    });
    const member = tenant?.memberUsages[0];
    const messageLimit = tenant?.messageLimit ?? settings.messageLimit;
    const messageCount = tenant?.messages ?? 0;
    const nearLimitMessageCount = tenant?.nearLimitMessageCount ?? settings.nearLimitMessageCount;

    return {
      periodStart: settings.periodStart.toISOString(),
      resetAt: settings.resetAt.toISOString(),
      status: quotaStatus(messageCount, messageLimit, nearLimitMessageCount),
      messageLimit,
      messageCount,
      remaining: Math.max(0, messageLimit - messageCount),
      measurementComplete: (tenant?.measurementIncompleteCount ?? 0) === 0,
      tenant: usageMetrics(tenant),
      currentMember: usageMetrics(member),
    };
  }

  async getMemberBreakdown(context: TenantContext, month?: string) {
    const periodStart = month ? parseUtcMonth(month) : utcMonthStart(new Date());
    const resetAt = nextUtcMonth(periodStart);
    const rows = await this.prisma.aiMemberMonthlyUsage.findMany({
      where: { familyId: context.familyId, periodStart },
      include: {
        memberProfile: { select: { displayName: true, status: true } },
      },
      orderBy: [{ messages: 'desc' }, { memberProfile: { displayName: 'asc' } }],
    });

    return {
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
      members: rows.map((row) => ({
        displayName: row.memberProfile.displayName,
        profileStatus: row.memberProfile.status,
        measurementComplete: row.measurementIncompleteCount === 0,
        ...usageMetrics(row),
      })),
    };
  }

  async markAlertDelivery(alertId: string, sent: boolean, now = new Date()) {
    if (!sent) return;

    await this.prisma.$transaction(async (tx) => {
      const alert = await tx.aiUsageAlert.findUnique({
        where: { id: alertId },
        select: { tenantUsageId: true, kind: true, status: true },
      });
      if (!alert || alert.status !== 'PENDING') return;

      await tx.aiUsageAlert.updateMany({
        where: { id: alertId, status: 'PENDING' },
        data: { status: 'SENT', lastAttemptAt: now, sentAt: now },
      });
      if (alert.kind === AiUsageAlertKind.EXHAUSTED) {
        await tx.aiUsageAlert.updateMany({
          where: {
            tenantUsageId: alert.tenantUsageId,
            kind: AiUsageAlertKind.NEAR_LIMIT,
            status: 'PENDING',
          },
          data: { status: 'SUPERSEDED', lastAttemptAt: now },
        });
      }
    });
  }

  async claimAlertDelivery(alertId: string, now = new Date()) {
    const retryCutoff = new Date(now.getTime() - 5 * 60_000);
    const claimed = await this.prisma.aiUsageAlert.updateMany({
      where: {
        id: alertId,
        status: 'PENDING',
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: retryCutoff } }],
      },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });
    return claimed.count === 1;
  }

  async deleteExpiredMessageLogs(now = new Date()) {
    const retentionDays = this.config.get<number>('TELEGRAM_MESSAGE_LOG_RETENTION_DAYS') ?? 30;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
    return this.prisma.$transaction(async (tx) => {
      // Terminal updates no longer need their provider payload for recovery.
      // Redact all of them, including commands and records predating the usage
      // ledger, while retaining updateId/status for idempotency and audit.
      const redactedUpdates = await tx.$executeRaw`
        UPDATE "TelegramUpdate" AS telegram_update
           SET "payload" = jsonb_build_object(
             'redacted', TRUE,
             'reason', 'telegram_payload_retention_expired'
           )
         WHERE telegram_update."status" IN ('succeeded', 'failed')
           AND telegram_update."receivedAt" < ${cutoff}
           AND telegram_update."payload" IS DISTINCT FROM jsonb_build_object(
             'redacted', TRUE,
             'reason', 'telegram_payload_retention_expired'
           )
      `;
      const deleted = await tx.telegramMessageLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      return {
        count: deleted.count,
        redactedUpdates,
      };
    });
  }

  private async finishInTransaction(
    tx: Prisma.TransactionClient,
    eventId: string,
    status: Exclude<AiUsageEventStatus, 'IN_FLIGHT' | 'BLOCKED_QUOTA'>,
    measurement: AiUsageMeasurement,
    failureCode: string | undefined,
    now: Date,
  ) {
    const event = await tx.aiUsageEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new Error('AI_USAGE_EVENT_NOT_FOUND');
    if (event.status !== AiUsageEventStatus.IN_FLIGHT) {
      return {
        applied: false as const,
        estimatedCostUsd: event.estimatedCostUsd ?? undefined,
        tokensIn: event.tokensIn ?? undefined,
        tokensOut: event.tokensOut ?? undefined,
      };
    }

    const tokensIn = validTokenCount(measurement.tokensIn);
    const tokensOut = validTokenCount(measurement.tokensOut);
    const measurementComplete = tokensIn !== undefined && tokensOut !== undefined;
    const hasMeasuredTokens = tokensIn !== undefined || tokensOut !== undefined;
    const estimatedCostUsd = hasMeasuredTokens
      ? estimateCostUsd(
          tokensIn ?? 0,
          tokensOut ?? 0,
          event.inputUsdPerMillionTokens,
          event.outputUsdPerMillionTokens,
        )
      : undefined;

    const changed = await tx.aiUsageEvent.updateMany({
      where: { id: eventId, status: AiUsageEventStatus.IN_FLIGHT },
      data: {
        status,
        usedModel: measurement.model,
        providerRequestId: measurement.requestId,
        tokensIn,
        tokensOut,
        estimatedCostUsd,
        measurementComplete,
        failureCode,
        finishedAt: now,
      },
    });
    if (changed.count !== 1) {
      return { applied: false as const, estimatedCostUsd, tokensIn, tokensOut };
    }

    const increments = {
      tokensIn: { increment: BigInt(tokensIn ?? 0) },
      tokensOut: { increment: BigInt(tokensOut ?? 0) },
      ...(estimatedCostUsd ? { estimatedCostUsd: { increment: estimatedCostUsd } } : {}),
      ...(measurementComplete ? { measurementIncompleteCount: { decrement: 1 } } : {}),
    };
    await Promise.all([
      tx.aiTenantMonthlyUsage.update({
        where: { id: event.tenantUsageId },
        data: increments,
      }),
      tx.aiMemberMonthlyUsage.update({
        where: { id: event.memberUsageId },
        data: increments,
      }),
    ]);

    return { applied: true as const, estimatedCostUsd, tokensIn, tokensOut };
  }

  private async ensureUsageRows(
    tx: Prisma.TransactionClient,
    identity: Pick<AiUsageIdentity, 'familyId' | 'memberProfileId'>,
    settings: UsagePeriodSettings,
  ): Promise<UsageRows> {
    const tenant = await tx.aiTenantMonthlyUsage.upsert({
      where: {
        familyId_periodStart: {
          familyId: identity.familyId,
          periodStart: settings.periodStart,
        },
      },
      create: {
        familyId: identity.familyId,
        periodStart: settings.periodStart,
        planCode: settings.planCode,
        messageLimit: settings.messageLimit,
        nearLimitMessageCount: settings.nearLimitMessageCount,
      },
      update: {},
    });
    const member = await tx.aiMemberMonthlyUsage.upsert({
      where: {
        familyId_memberProfileId_periodStart: {
          familyId: identity.familyId,
          memberProfileId: identity.memberProfileId,
          periodStart: settings.periodStart,
        },
      },
      create: {
        tenantUsageId: tenant.id,
        familyId: identity.familyId,
        memberProfileId: identity.memberProfileId,
        periodStart: settings.periodStart,
      },
      update: {},
    });
    if (member.tenantUsageId !== tenant.id) throw new Error('AI_USAGE_PERIOD_MISMATCH');
    return { tenant, member };
  }

  private async ensureAlert(
    tx: Prisma.TransactionClient,
    tenant: Pick<AiTenantMonthlyUsage, 'id' | 'familyId'>,
    kind: AiUsageAlertKind,
  ) {
    return tx.aiUsageAlert.createMany({
      data: [{ tenantUsageId: tenant.id, familyId: tenant.familyId, kind }],
      skipDuplicates: true,
    });
  }

  private async pendingAlerts(
    tx: Prisma.TransactionClient,
    tenant: Pick<AiTenantMonthlyUsage, 'id' | 'messages' | 'messageLimit'>,
    resetAt: Date,
  ): Promise<AiUsageAlertDelivery[]> {
    const alerts = await tx.aiUsageAlert.findMany({
      where: { tenantUsageId: tenant.id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    const exhausted = alerts.find((alert) => alert.kind === AiUsageAlertKind.EXHAUSTED);
    const selected = exhausted ? [exhausted] : alerts;
    return selected.map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      messageCount: tenant.messages,
      messageLimit: tenant.messageLimit,
      resetAt,
    }));
  }

  private periodSettings(now: Date): UsagePeriodSettings {
    const messageLimit = this.config.get<number>('TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT') ?? 200;
    const warningPercent = this.config.get<number>('TELEGRAM_AI_WARNING_PERCENT') ?? 80;
    const warningCount = Math.max(1, Math.ceil((messageLimit * warningPercent) / 100));
    return {
      periodStart: utcMonthStart(now),
      resetAt: nextUtcMonth(now),
      planCode: this.config.get<string>('TELEGRAM_AI_PLAN_CODE') ?? 'monthly-card-v1',
      messageLimit,
      nearLimitMessageCount:
        messageLimit === 1 ? 1 : Math.min(messageLimit - 1, warningCount),
      provider: this.config.get<string>('AI_PROVIDER') ?? 'openai',
      requestedModel: this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini',
      pricingVersion:
        this.config.get<string>('OPENAI_PRICING_VERSION') ?? 'openai-gpt-4o-mini-2026-08-01',
      inputUsdPerMillionTokens: new Prisma.Decimal(
        this.config.get<string>('OPENAI_INPUT_USD_PER_MILLION_TOKENS') ?? '0.15',
      ),
      outputUsdPerMillionTokens: new Prisma.Decimal(
        this.config.get<string>('OPENAI_OUTPUT_USD_PER_MILLION_TOKENS') ?? '0.60',
      ),
    };
  }

  private isStale(startedAt: Date, now: Date) {
    const minutes = this.config.get<number>('TELEGRAM_UPDATE_RECOVERY_MINUTES') ?? 5;
    return startedAt.getTime() <= now.getTime() - minutes * 60_000;
  }

  private assertSameIdentity(
    event: Pick<AiUsageIdentity, 'familyId' | 'memberProfileId' | 'chatId' | 'tgUserId'>,
    identity: AiUsageIdentity,
  ) {
    if (
      event.familyId !== identity.familyId ||
      event.memberProfileId !== identity.memberProfileId ||
      event.chatId !== identity.chatId ||
      event.tgUserId !== identity.tgUserId
    ) {
      throw new UnauthorizedException('Update de IA pertence a outro contexto');
    }
  }
}

export function utcMonthStart(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

export function nextUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

export function parseUtcMonth(value: string) {
  if (!/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new BadRequestException('INVALID_USAGE_MONTH');
  }
  const [year, month] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  inputUsdPerMillionTokens: Prisma.Decimal.Value,
  outputUsdPerMillionTokens: Prisma.Decimal.Value,
) {
  return new Prisma.Decimal(tokensIn)
    .mul(inputUsdPerMillionTokens)
    .plus(new Prisma.Decimal(tokensOut).mul(outputUsdPerMillionTokens))
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

function quotaStatus(messageCount: number, messageLimit: number, nearLimitMessageCount: number) {
  if (messageCount >= messageLimit) return 'exhausted' as const;
  if (messageCount >= nearLimitMessageCount) return 'near_limit' as const;
  return 'available' as const;
}

function usageMetrics(
  usage:
    | Pick<
        AiTenantMonthlyUsage | AiMemberMonthlyUsage,
        'messages' | 'tokensIn' | 'tokensOut' | 'estimatedCostUsd' | 'financialOperations'
      >
    | null
    | undefined,
) {
  return {
    messages: usage?.messages ?? 0,
    inputTokens: toSafeTokenTotalNumber(usage?.tokensIn),
    outputTokens: toSafeTokenTotalNumber(usage?.tokensOut),
    estimatedCostUsd: usage?.estimatedCostUsd.toFixed(6) ?? '0.000000',
    financialOperationsCompleted: usage?.financialOperations ?? 0,
  };
}

function toSafeTokenTotalNumber(value: bigint | null | undefined) {
  const total = value ?? 0n;
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('AI_USAGE_TOKEN_TOTAL_OUT_OF_SAFE_RANGE');
  }
  return Number(total);
}

function validTokenCount(value: number | undefined) {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

function isAiProviderError(error: unknown): error is AiProviderError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'kind' in error &&
      (error.kind === 'PROVIDER_FAILED' || error.kind === 'RESPONSE_INVALID'),
  );
}

function providerFailureCode(error: AiProviderError | undefined) {
  if (!error) return 'provider_unknown';
  if (error.kind === 'RESPONSE_INVALID') return 'provider_response_invalid';
  if (error.httpStatus) return `provider_http_${error.httpStatus}`;
  return 'provider_transport_or_config';
}
