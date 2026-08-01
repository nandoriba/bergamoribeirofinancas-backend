import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260801060000_ai_usage_limits/migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

describe('contrato persistente de consumo da IA', () => {
  it('mantém um único evento por update e uma única cota por tenant/mês', () => {
    expect(migration).toContain('AiUsageEvent_sourceUpdateId_key');
    expect(migration).toContain('AiTenantMonthlyUsage_familyId_periodStart_key');
    expect(migration).toContain('AiMemberMonthlyUsage_familyId_memberProfileId_periodStart_key');
    expect(schema).toContain('sourceUpdateId                String                    @unique');
    expect(schema).toContain('@@unique([familyId, periodStart])');
  });

  it('impede quota excedida, métricas negativas e medição completa sem tokens/custo', () => {
    expect(migration).toContain('"messages" <= "messageLimit"');
    expect(migration).toContain('"measurementIncompleteCount" <= "messages"');
    expect(migration).toContain('"tokensIn" IS NULL OR "tokensIn" >= 0');
    expect(migration).toContain('"inputUsdPerMillionTokens" >= 0');
    expect(migration).toContain(
      '"tokensIn" IS NOT NULL AND "tokensOut" IS NOT NULL AND "estimatedCostUsd" IS NOT NULL',
    );
    expect(migration).toContain('AiUsageEvent_status_payload_check');
    expect(migration).toContain('"finishedAt" >= "startedAt"');
  });

  it('usa BIGINT apenas nos totais mensais e preserva Int nos eventos individuais', () => {
    expect(migration).toMatch(
      /CREATE TABLE "AiTenantMonthlyUsage"[\s\S]*?"tokensIn" BIGINT[\s\S]*?"tokensOut" BIGINT/,
    );
    expect(migration).toMatch(
      /CREATE TABLE "AiMemberMonthlyUsage"[\s\S]*?"tokensIn" BIGINT[\s\S]*?"tokensOut" BIGINT/,
    );
    expect(migration).toMatch(
      /CREATE TABLE "AiUsageEvent"[\s\S]*?"tokensIn" INTEGER[\s\S]*?"tokensOut" INTEGER/,
    );
    expect(schema).toMatch(
      /model AiTenantMonthlyUsage[\s\S]*?tokensIn\s+BigInt[\s\S]*?tokensOut\s+BigInt/,
    );
    expect(schema).toMatch(
      /model AiMemberMonthlyUsage[\s\S]*?tokensIn\s+BigInt[\s\S]*?tokensOut\s+BigInt/,
    );
    expect(schema).toMatch(/model AiUsageEvent[\s\S]*?tokensIn\s+Int\?[\s\S]*?tokensOut\s+Int\?/);
  });

  it('amarra eventos e agregados ao mesmo tenant, período e membro', () => {
    expect(migration).toContain('AiMemberMonthlyUsage_memberProfileId_familyId_fkey');
    expect(migration).toContain('AiMemberMonthlyUsage_tenantUsageId_familyId_periodStart_fkey');
    expect(migration).toContain(
      'AiUsageEvent_memberUsageId_tenantUsageId_familyId_memberProfileId_fkey',
    );
    expect(migration).toContain('AiUsageEvent_memberProfileId_familyId_fkey');
    expect(migration).toContain('REFERENCES "MemberProfile"("id", "familyId")');
    expect(migration).toContain('AiUsageEvent_familyId_immutable');
    expect(migration).toContain('AiUsageEvent_rewrite_guard');
    expect(migration).toContain('AI_USAGE_EVENT_TERMINAL_IMMUTABLE');
  });

  it('vincula operação e log ao mesmo membro sem apagar o ledger por acidente', () => {
    expect(migration).toContain('TelegramFinancialOperation_aiUsageEventId_key');
    expect(migration).toContain('TelegramMessageLog_aiUsageEventId_key');
    expect(migration).toContain('TelegramPendingConfirmation_aiUsageEventId_key');
    expect(migration).toContain('AiUsageEvent_id_memberProfileId_key');
    expect(migration).toContain('TelegramMessageLog_ai_event_requires_member_check');
    expect(migration).toContain('ALTER COLUMN "costUsd" TYPE DECIMAL(18,6)');
    expect(migration).toMatch(
      /REFERENCES "AiUsageEvent"\("id", "memberProfileId"\)\s+ON DELETE RESTRICT/g,
    );
  });
});
