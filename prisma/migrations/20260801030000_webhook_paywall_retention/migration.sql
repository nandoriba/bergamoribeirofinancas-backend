-- Fatia 8: authoritative current subscription, webhook correlation and retention audit.
-- Positive entitlement remains disabled until the sandbox contract proves HMAC and cycle boundaries.

ALTER TYPE "WebhookProcessingStatus" ADD VALUE IF NOT EXISTS 'quarantined';

CREATE TYPE "RetentionRunStatus" AS ENUM ('running', 'succeeded', 'failed');

ALTER TABLE "Family"
  ADD COLUMN "currentSubscriptionId" TEXT;

-- LegalAcceptance remains append-only for every ordinary UPDATE/DELETE. Tenant
-- retention may delete it only while dismantling the matching family in the same
-- transaction. set_config(..., true) is transaction-local, so the authorization
-- cannot survive a commit/rollback or leak through a pooled connection.
CREATE OR REPLACE FUNCTION "protect_legal_acceptance"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.tenant_retention_family_id', TRUE) = OLD."familyId"
     AND EXISTS (
       SELECT 1
         FROM "Family" family
        WHERE family."id" = OLD."familyId"
          AND family."ownerUserId" IS NULL
          AND family."currentSubscriptionId" IS NULL
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'LEGAL_ACCEPTANCE_IS_APPEND_ONLY';
END
$$;

ALTER TABLE "Subscription"
  ADD COLUMN "entitlementContractVersion" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelClaimToken" TEXT,
  ADD COLUMN "cancelLockedAt" TIMESTAMP(3),
  ADD COLUMN "cancelAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelLastErrorCode" TEXT;

ALTER TABLE "SubscriptionPayment"
  ADD COLUMN "providerCheckoutId" TEXT;

ALTER TABLE "PaymentWebhookEvent"
  ADD COLUMN "providerCheckoutId" TEXT,
  ADD COLUMN "providerFailureReason" TEXT;

ALTER TABLE "PaymentWebhookEvent"
  ALTER COLUMN "apiVersion" TYPE INTEGER
  USING (
    CASE
      WHEN "apiVersion" IS NULL THEN NULL
      WHEN "apiVersion" ~ '^[0-9]+$' THEN "apiVersion"::INTEGER
      ELSE NULL
    END
  );

CREATE TABLE "TenantPurgeRun" (
  "id" TEXT NOT NULL,
  "status" "RetentionRunStatus" NOT NULL DEFAULT 'running',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "pendingPaymentPurged" INTEGER NOT NULL DEFAULT 0,
  "cancelledPurged" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantPurgeRun_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT "familyId"
      FROM "Subscription"
     WHERE "cancelledAt" IS NULL
       AND "checkoutClosedAt" IS NULL
     GROUP BY "familyId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FATIA8_MULTIPLE_CURRENT_SUBSCRIPTIONS';
  END IF;
END
$$;

UPDATE "Family" family
   SET "currentSubscriptionId" = (
     SELECT subscription."id"
       FROM "Subscription" subscription
      WHERE subscription."familyId" = family."id"
      ORDER BY
        (
          subscription."cancelledAt" IS NULL
          AND subscription."checkoutClosedAt" IS NULL
        ) DESC,
        subscription."createdAt" DESC,
        subscription."id" DESC
      LIMIT 1
   )
 WHERE EXISTS (
   SELECT 1 FROM "Subscription" subscription WHERE subscription."familyId" = family."id"
 );

CREATE UNIQUE INDEX "Family_currentSubscriptionId_key"
  ON "Family"("currentSubscriptionId");
CREATE UNIQUE INDEX "Family_currentSubscriptionId_id_key"
  ON "Family"("currentSubscriptionId", "id");
CREATE UNIQUE INDEX "SubscriptionPayment_providerCheckoutId_key"
  ON "SubscriptionPayment"("providerCheckoutId");
CREATE INDEX "PaymentWebhookEvent_provider_providerCheckoutId_idx"
  ON "PaymentWebhookEvent"("provider", "providerCheckoutId");
CREATE INDEX "TenantPurgeRun_status_finishedAt_idx"
  ON "TenantPurgeRun"("status", "finishedAt");
CREATE INDEX "TenantPurgeRun_startedAt_idx"
  ON "TenantPurgeRun"("startedAt");
CREATE UNIQUE INDEX "TenantPurgeRun_single_running_key"
  ON "TenantPurgeRun"("status")
  WHERE "status" = 'running';

ALTER TABLE "Family"
  ADD CONSTRAINT "Family_currentSubscriptionId_id_fkey"
  FOREIGN KEY ("currentSubscriptionId", "id")
  REFERENCES "Subscription"("id", "familyId")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_entitlement_contract_check"
    CHECK ("accessPaidThrough" IS NULL OR "entitlementContractVersion" IS NOT NULL),
  ADD CONSTRAINT "Subscription_cancel_attempts_check"
    CHECK ("cancelAttempts" >= 0),
  ADD CONSTRAINT "Subscription_cancel_claim_check"
    CHECK (("cancelClaimToken" IS NULL) = ("cancelLockedAt" IS NULL));

ALTER TABLE "SubscriptionPayment"
  ADD CONSTRAINT "SubscriptionPayment_checkout_reference_check"
    CHECK ("providerCheckoutId" IS NULL OR "providerCheckoutId" ~ '^bill_[A-Za-z0-9_-]+$');

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_api_version_check"
    CHECK ("apiVersion" IS NULL OR "apiVersion" = 2),
  ADD CONSTRAINT "PaymentWebhookEvent_checkout_reference_check"
    CHECK ("providerCheckoutId" IS NULL OR "providerCheckoutId" ~ '^bill_[A-Za-z0-9_-]+$');

ALTER TABLE "TenantPurgeRun"
  ADD CONSTRAINT "TenantPurgeRun_counts_check"
    CHECK ("pendingPaymentPurged" >= 0 AND "cancelledPurged" >= 0),
  ADD CONSTRAINT "TenantPurgeRun_terminal_check"
    CHECK (
      ("status" = 'running' AND "finishedAt" IS NULL AND "errorCode" IS NULL)
      OR ("status" = 'succeeded' AND "finishedAt" IS NOT NULL AND "errorCode" IS NULL)
      OR ("status" = 'failed' AND "finishedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
    ),
  ADD CONSTRAINT "TenantPurgeRun_time_check"
    CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt");

CREATE FUNCTION "prevent_provider_subscription_id_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."providerSubscriptionId" IS NOT NULL
     AND NEW."providerSubscriptionId" IS DISTINCT FROM OLD."providerSubscriptionId" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'PROVIDER_SUBSCRIPTION_ID_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Subscription_providerSubscriptionId_immutable"
BEFORE UPDATE OF "providerSubscriptionId" ON "Subscription"
FOR EACH ROW
EXECUTE FUNCTION "prevent_provider_subscription_id_change"();
