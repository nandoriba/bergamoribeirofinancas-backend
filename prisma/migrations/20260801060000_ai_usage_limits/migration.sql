CREATE TYPE "AiUsageEventStatus" AS ENUM (
  'IN_FLIGHT',
  'SUCCEEDED',
  'PROVIDER_FAILED',
  'RESPONSE_INVALID',
  'AMBIGUOUS',
  'BLOCKED_QUOTA'
);

CREATE TYPE "AiUsageAlertKind" AS ENUM ('NEAR_LIMIT', 'EXHAUSTED');
CREATE TYPE "AiUsageAlertStatus" AS ENUM ('PENDING', 'SENT', 'SUPERSEDED');

CREATE TABLE "AiTenantMonthlyUsage" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "planCode" TEXT NOT NULL,
  "messageLimit" INTEGER NOT NULL,
  "nearLimitMessageCount" INTEGER NOT NULL,
  "messages" INTEGER NOT NULL DEFAULT 0,
  "blockedMessages" INTEGER NOT NULL DEFAULT 0,
  "tokensIn" BIGINT NOT NULL DEFAULT 0,
  "tokensOut" BIGINT NOT NULL DEFAULT 0,
  "estimatedCostUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "measurementIncompleteCount" INTEGER NOT NULL DEFAULT 0,
  "financialOperations" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiTenantMonthlyUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiTenantMonthlyUsage_limit_check" CHECK (
    "messageLimit" > 0
    AND "nearLimitMessageCount" > 0
    AND "nearLimitMessageCount" <= "messageLimit"
    AND "messages" >= 0
    AND "messages" <= "messageLimit"
    AND "blockedMessages" >= 0
    AND "tokensIn" >= 0
    AND "tokensOut" >= 0
    AND "estimatedCostUsd" >= 0
    AND "measurementIncompleteCount" >= 0
    AND "measurementIncompleteCount" <= "messages"
    AND "financialOperations" >= 0
  )
);

CREATE TABLE "AiMemberMonthlyUsage" (
  "id" TEXT NOT NULL,
  "tenantUsageId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "messages" INTEGER NOT NULL DEFAULT 0,
  "blockedMessages" INTEGER NOT NULL DEFAULT 0,
  "tokensIn" BIGINT NOT NULL DEFAULT 0,
  "tokensOut" BIGINT NOT NULL DEFAULT 0,
  "estimatedCostUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "measurementIncompleteCount" INTEGER NOT NULL DEFAULT 0,
  "financialOperations" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiMemberMonthlyUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiMemberMonthlyUsage_non_negative_check" CHECK (
    "messages" >= 0
    AND "blockedMessages" >= 0
    AND "tokensIn" >= 0
    AND "tokensOut" >= 0
    AND "estimatedCostUsd" >= 0
    AND "measurementIncompleteCount" >= 0
    AND "measurementIncompleteCount" <= "messages"
    AND "financialOperations" >= 0
  )
);

CREATE TABLE "AiUsageEvent" (
  "id" TEXT NOT NULL,
  "sourceUpdateId" TEXT NOT NULL,
  "sourceMessageId" INTEGER NOT NULL,
  "familyId" TEXT NOT NULL,
  "tenantUsageId" TEXT NOT NULL,
  "memberUsageId" TEXT NOT NULL,
  "memberProfileId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "tgUserId" TEXT NOT NULL,
  "status" "AiUsageEventStatus" NOT NULL DEFAULT 'IN_FLIGHT',
  "provider" TEXT NOT NULL,
  "requestedModel" TEXT NOT NULL,
  "usedModel" TEXT,
  "providerRequestId" TEXT,
  "pricingVersion" TEXT NOT NULL,
  "inputUsdPerMillionTokens" DECIMAL(18,6) NOT NULL,
  "outputUsdPerMillionTokens" DECIMAL(18,6) NOT NULL,
  "tokensIn" INTEGER,
  "tokensOut" INTEGER,
  "estimatedCostUsd" DECIMAL(18,6),
  "measurementComplete" BOOLEAN NOT NULL DEFAULT false,
  "failureCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiUsageEvent_measurement_check" CHECK (
    "inputUsdPerMillionTokens" >= 0
    AND "outputUsdPerMillionTokens" >= 0
    AND
    ("tokensIn" IS NULL OR "tokensIn" >= 0)
    AND ("tokensOut" IS NULL OR "tokensOut" >= 0)
    AND ("estimatedCostUsd" IS NULL OR "estimatedCostUsd" >= 0)
    AND (
      NOT "measurementComplete"
      OR ("tokensIn" IS NOT NULL AND "tokensOut" IS NOT NULL AND "estimatedCostUsd" IS NOT NULL)
    )
  ),
  CONSTRAINT "AiUsageEvent_finished_check" CHECK (
    ("status" = 'IN_FLIGHT' AND "finishedAt" IS NULL)
    OR (
      "status" <> 'IN_FLIGHT'
      AND "finishedAt" IS NOT NULL
      AND "finishedAt" >= "startedAt"
    )
  ),
  CONSTRAINT "AiUsageEvent_status_payload_check" CHECK (
    (
      "status" = 'IN_FLIGHT'
      AND "tokensIn" IS NULL
      AND "tokensOut" IS NULL
      AND "estimatedCostUsd" IS NULL
      AND NOT "measurementComplete"
      AND "failureCode" IS NULL
    )
    OR ("status" = 'SUCCEEDED' AND "failureCode" IS NULL)
    OR (
      "status" IN ('PROVIDER_FAILED', 'RESPONSE_INVALID', 'AMBIGUOUS')
      AND "failureCode" IS NOT NULL
    )
    OR (
      "status" = 'BLOCKED_QUOTA'
      AND "failureCode" IS NOT NULL
      AND "tokensIn" IS NULL
      AND "tokensOut" IS NULL
      AND "estimatedCostUsd" IS NULL
      AND NOT "measurementComplete"
    )
  )
);

CREATE TABLE "AiUsageAlert" (
  "id" TEXT NOT NULL,
  "tenantUsageId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "kind" "AiUsageAlertKind" NOT NULL,
  "status" "AiUsageAlertStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiUsageAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiUsageAlert_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "AiUsageAlert_sent_check" CHECK (
    ("status" = 'PENDING' AND "sentAt" IS NULL)
    OR ("status" = 'SENT' AND "sentAt" IS NOT NULL)
    OR ("status" = 'SUPERSEDED' AND "sentAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "AiTenantMonthlyUsage_familyId_periodStart_key"
  ON "AiTenantMonthlyUsage"("familyId", "periodStart");
CREATE UNIQUE INDEX "AiTenantMonthlyUsage_id_familyId_key"
  ON "AiTenantMonthlyUsage"("id", "familyId");
CREATE UNIQUE INDEX "AiTenantMonthlyUsage_id_familyId_periodStart_key"
  ON "AiTenantMonthlyUsage"("id", "familyId", "periodStart");
CREATE INDEX "AiTenantMonthlyUsage_periodStart_idx"
  ON "AiTenantMonthlyUsage"("periodStart");

CREATE UNIQUE INDEX "AiMemberMonthlyUsage_familyId_memberProfileId_periodStart_key"
  ON "AiMemberMonthlyUsage"("familyId", "memberProfileId", "periodStart");
CREATE UNIQUE INDEX "AiMemberMonthlyUsage_id_familyId_key"
  ON "AiMemberMonthlyUsage"("id", "familyId");
CREATE UNIQUE INDEX "AiMemberMonthlyUsage_id_tenantUsageId_familyId_memberProfileId_key"
  ON "AiMemberMonthlyUsage"("id", "tenantUsageId", "familyId", "memberProfileId");
CREATE INDEX "AiMemberMonthlyUsage_tenantUsageId_idx"
  ON "AiMemberMonthlyUsage"("tenantUsageId");
CREATE INDEX "AiMemberMonthlyUsage_memberProfileId_periodStart_idx"
  ON "AiMemberMonthlyUsage"("memberProfileId", "periodStart");

CREATE UNIQUE INDEX "AiUsageEvent_sourceUpdateId_key" ON "AiUsageEvent"("sourceUpdateId");
CREATE INDEX "TelegramUpdate_status_receivedAt_idx"
  ON "TelegramUpdate"("status", "receivedAt");
CREATE INDEX "AiUsageEvent_familyId_startedAt_idx" ON "AiUsageEvent"("familyId", "startedAt");
CREATE INDEX "AiUsageEvent_memberProfileId_startedAt_idx"
  ON "AiUsageEvent"("memberProfileId", "startedAt");
CREATE INDEX "AiUsageEvent_status_startedAt_idx" ON "AiUsageEvent"("status", "startedAt");
CREATE UNIQUE INDEX "AiUsageEvent_id_memberProfileId_key"
  ON "AiUsageEvent"("id", "memberProfileId");

CREATE UNIQUE INDEX "AiUsageAlert_tenantUsageId_kind_key"
  ON "AiUsageAlert"("tenantUsageId", "kind");
CREATE INDEX "AiUsageAlert_familyId_status_createdAt_idx"
  ON "AiUsageAlert"("familyId", "status", "createdAt");

ALTER TABLE "AiTenantMonthlyUsage"
  ADD CONSTRAINT "AiTenantMonthlyUsage_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AiMemberMonthlyUsage"
  ADD CONSTRAINT "AiMemberMonthlyUsage_tenantUsageId_familyId_periodStart_fkey"
  FOREIGN KEY ("tenantUsageId", "familyId", "periodStart")
  REFERENCES "AiTenantMonthlyUsage"("id", "familyId", "periodStart")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AiMemberMonthlyUsage"
  ADD CONSTRAINT "AiMemberMonthlyUsage_memberProfileId_familyId_fkey"
  FOREIGN KEY ("memberProfileId", "familyId")
  REFERENCES "MemberProfile"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiUsageEvent"
  ADD CONSTRAINT "AiUsageEvent_sourceUpdateId_fkey"
  FOREIGN KEY ("sourceUpdateId") REFERENCES "TelegramUpdate"("updateId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiUsageEvent"
  ADD CONSTRAINT "AiUsageEvent_tenantUsageId_familyId_fkey"
  FOREIGN KEY ("tenantUsageId", "familyId")
  REFERENCES "AiTenantMonthlyUsage"("id", "familyId")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AiUsageEvent"
  ADD CONSTRAINT "AiUsageEvent_memberUsageId_tenantUsageId_familyId_memberProfileId_fkey"
  FOREIGN KEY ("memberUsageId", "tenantUsageId", "familyId", "memberProfileId")
  REFERENCES "AiMemberMonthlyUsage"("id", "tenantUsageId", "familyId", "memberProfileId")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AiUsageEvent"
  ADD CONSTRAINT "AiUsageEvent_memberProfileId_familyId_fkey"
  FOREIGN KEY ("memberProfileId", "familyId")
  REFERENCES "MemberProfile"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AiUsageAlert"
  ADD CONSTRAINT "AiUsageAlert_tenantUsageId_familyId_fkey"
  FOREIGN KEY ("tenantUsageId", "familyId")
  REFERENCES "AiTenantMonthlyUsage"("id", "familyId")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "TelegramPendingConfirmation" ADD COLUMN "aiUsageEventId" TEXT;
ALTER TABLE "TelegramFinancialOperation" ADD COLUMN "aiUsageEventId" TEXT;
ALTER TABLE "TelegramMessageLog" ADD COLUMN "aiUsageEventId" TEXT;
ALTER TABLE "TelegramMessageLog" ALTER COLUMN "costUsd" TYPE DECIMAL(18,6);

CREATE UNIQUE INDEX "TelegramPendingConfirmation_aiUsageEventId_key"
  ON "TelegramPendingConfirmation"("aiUsageEventId");
CREATE UNIQUE INDEX "TelegramPendingConfirmation_aiUsageEventId_memberProfileId_key"
  ON "TelegramPendingConfirmation"("aiUsageEventId", "memberProfileId");
CREATE UNIQUE INDEX "TelegramFinancialOperation_aiUsageEventId_key"
  ON "TelegramFinancialOperation"("aiUsageEventId");
CREATE UNIQUE INDEX "TelegramFinancialOperation_aiUsageEventId_memberProfileId_key"
  ON "TelegramFinancialOperation"("aiUsageEventId", "memberProfileId");
CREATE UNIQUE INDEX "TelegramMessageLog_aiUsageEventId_key"
  ON "TelegramMessageLog"("aiUsageEventId");
CREATE UNIQUE INDEX "TelegramMessageLog_aiUsageEventId_memberProfileId_key"
  ON "TelegramMessageLog"("aiUsageEventId", "memberProfileId");

ALTER TABLE "TelegramPendingConfirmation"
  ADD CONSTRAINT "TelegramPendingConfirmation_aiUsageEventId_memberProfileId_fkey"
  FOREIGN KEY ("aiUsageEventId", "memberProfileId")
  REFERENCES "AiUsageEvent"("id", "memberProfileId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TelegramFinancialOperation"
  ADD CONSTRAINT "TelegramFinancialOperation_aiUsageEventId_memberProfileId_fkey"
  FOREIGN KEY ("aiUsageEventId", "memberProfileId")
  REFERENCES "AiUsageEvent"("id", "memberProfileId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TelegramMessageLog"
  ADD CONSTRAINT "TelegramMessageLog_aiUsageEventId_memberProfileId_fkey"
  FOREIGN KEY ("aiUsageEventId", "memberProfileId")
  REFERENCES "AiUsageEvent"("id", "memberProfileId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "TelegramMessageLog"
  ADD CONSTRAINT "TelegramMessageLog_ai_event_requires_member_check"
  CHECK ("aiUsageEventId" IS NULL OR "memberProfileId" IS NOT NULL);

CREATE OR REPLACE FUNCTION "guard_ai_tenant_monthly_usage_identity"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
     OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
     OR NEW."planCode" IS DISTINCT FROM OLD."planCode"
     OR NEW."messageLimit" IS DISTINCT FROM OLD."messageLimit"
     OR NEW."nearLimitMessageCount" IS DISTINCT FROM OLD."nearLimitMessageCount"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_TENANT_USAGE_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "guard_ai_member_monthly_usage_identity"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantUsageId" IS DISTINCT FROM OLD."tenantUsageId"
     OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
     OR NEW."memberProfileId" IS DISTINCT FROM OLD."memberProfileId"
     OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_MEMBER_USAGE_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "guard_ai_usage_event_rewrite"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."sourceUpdateId" IS DISTINCT FROM OLD."sourceUpdateId"
     OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
     OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
     OR NEW."tenantUsageId" IS DISTINCT FROM OLD."tenantUsageId"
     OR NEW."memberUsageId" IS DISTINCT FROM OLD."memberUsageId"
     OR NEW."memberProfileId" IS DISTINCT FROM OLD."memberProfileId"
     OR NEW."chatId" IS DISTINCT FROM OLD."chatId"
     OR NEW."tgUserId" IS DISTINCT FROM OLD."tgUserId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."requestedModel" IS DISTINCT FROM OLD."requestedModel"
     OR NEW."pricingVersion" IS DISTINCT FROM OLD."pricingVersion"
     OR NEW."inputUsdPerMillionTokens" IS DISTINCT FROM OLD."inputUsdPerMillionTokens"
     OR NEW."outputUsdPerMillionTokens" IS DISTINCT FROM OLD."outputUsdPerMillionTokens"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_USAGE_EVENT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD."status" <> 'IN_FLIGHT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_USAGE_EVENT_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "guard_ai_usage_alert_rewrite"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantUsageId" IS DISTINCT FROM OLD."tenantUsageId"
     OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_USAGE_ALERT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AI_USAGE_ALERT_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AiTenantMonthlyUsage_identity_immutable"
BEFORE UPDATE ON "AiTenantMonthlyUsage"
FOR EACH ROW EXECUTE FUNCTION "guard_ai_tenant_monthly_usage_identity"();
CREATE TRIGGER "AiMemberMonthlyUsage_identity_immutable"
BEFORE UPDATE ON "AiMemberMonthlyUsage"
FOR EACH ROW EXECUTE FUNCTION "guard_ai_member_monthly_usage_identity"();
CREATE TRIGGER "AiUsageEvent_rewrite_guard"
BEFORE UPDATE ON "AiUsageEvent"
FOR EACH ROW EXECUTE FUNCTION "guard_ai_usage_event_rewrite"();
CREATE TRIGGER "AiUsageAlert_rewrite_guard"
BEFORE UPDATE ON "AiUsageAlert"
FOR EACH ROW EXECUTE FUNCTION "guard_ai_usage_alert_rewrite"();

CREATE TRIGGER "AiTenantMonthlyUsage_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "AiTenantMonthlyUsage"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();
CREATE TRIGGER "AiMemberMonthlyUsage_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "AiMemberMonthlyUsage"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();
CREATE TRIGGER "AiUsageEvent_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "AiUsageEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();
CREATE TRIGGER "AiUsageAlert_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "AiUsageAlert"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();
