BEGIN;

CREATE TYPE "CheckoutProvisioningStatus" AS ENUM (
  'pending',
  'processing',
  'ready',
  'ambiguous',
  'failed'
);

ALTER TABLE "Subscription"
  ADD COLUMN "providerCheckoutUrl" TEXT,
  ADD COLUMN "providerCheckoutStatus" TEXT,
  ADD COLUMN "checkoutProvisioningStatus" "CheckoutProvisioningStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "checkoutCreationAllowed" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "checkoutAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkoutClaimToken" TEXT,
  ADD COLUMN "checkoutLockedAt" TIMESTAMP(3),
  ADD COLUMN "checkoutReadyAt" TIMESTAMP(3),
  ADD COLUMN "checkoutClosedAt" TIMESTAMP(3),
  ADD COLUMN "checkoutCloseReason" TEXT,
  ADD COLUMN "checkoutLastErrorCode" TEXT;

-- Billing runtime did not exist before this migration. Any pre-existing row is
-- therefore quarantined until it can be reconciled by its stable externalId.
UPDATE "Subscription"
SET
  "checkoutProvisioningStatus" = 'ambiguous',
  "checkoutCreationAllowed" = FALSE,
  "checkoutLastErrorCode" = 'LEGACY_CHECKOUT_REQUIRES_RECONCILIATION'
WHERE TRUE;

CREATE INDEX "Subscription_checkoutProvisioningStatus_checkoutLockedAt_idx"
  ON "Subscription"("checkoutProvisioningStatus", "checkoutLockedAt");

DROP INDEX "Subscription_one_open_per_family";
CREATE UNIQUE INDEX "Subscription_one_open_per_family"
  ON "Subscription"("familyId")
  WHERE "cancelledAt" IS NULL AND "checkoutClosedAt" IS NULL;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_checkout_attempts_check"
    CHECK ("checkoutAttempts" >= 0),
  ADD CONSTRAINT "Subscription_checkout_status_check"
    CHECK (
      "providerCheckoutStatus" IS NULL
      OR "providerCheckoutStatus" IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED')
    ),
  ADD CONSTRAINT "Subscription_checkout_close_check"
    CHECK (
      ("checkoutClosedAt" IS NULL AND "checkoutCloseReason" IS NULL)
      OR
      (
        "checkoutClosedAt" IS NOT NULL
        AND "checkoutReadyAt" IS NOT NULL
        AND "checkoutCloseReason" IN ('EXPIRED', 'CANCELLED', 'REFUNDED')
        AND "providerCheckoutStatus" IS NOT NULL
        AND "providerCheckoutStatus" = "checkoutCloseReason"
      )
    ),
  ADD CONSTRAINT "Subscription_checkout_url_check"
    CHECK (
      "providerCheckoutUrl" IS NULL
      OR
      (
        "providerCheckoutId" IS NOT NULL
        AND "providerCheckoutId" ~ '^bill_[A-Za-z0-9_-]+$'
        AND "providerCheckoutUrl" = ('https://app.abacatepay.com/pay/' || "providerCheckoutId")
      )
    ),
  ADD CONSTRAINT "Subscription_checkout_claim_check"
    CHECK (
      (
        "checkoutProvisioningStatus" = 'processing'
        AND "checkoutClaimToken" IS NOT NULL
        AND "checkoutLockedAt" IS NOT NULL
      )
      OR
      (
        "checkoutProvisioningStatus" <> 'processing'
        AND "checkoutClaimToken" IS NULL
        AND "checkoutLockedAt" IS NULL
      )
    ),
  ADD CONSTRAINT "Subscription_checkout_state_check"
    CHECK (
      (
        "checkoutProvisioningStatus" = 'pending'
        AND "checkoutCreationAllowed" = TRUE
        AND "providerCheckoutId" IS NULL
        AND "providerCheckoutUrl" IS NULL
        AND "providerCheckoutStatus" IS NULL
        AND "checkoutReadyAt" IS NULL
        AND "checkoutLastErrorCode" IS NULL
      )
      OR
      (
        "checkoutProvisioningStatus" = 'processing'
        AND "providerCheckoutUrl" IS NULL
        AND "providerCheckoutStatus" IS NULL
        AND "checkoutReadyAt" IS NULL
      )
      OR
      (
        "checkoutProvisioningStatus" = 'ready'
        AND "checkoutCreationAllowed" = FALSE
        AND "providerCheckoutId" IS NOT NULL
        AND "providerCheckoutUrl" IS NOT NULL
        AND "providerCheckoutStatus" IS NOT NULL
        AND "checkoutReadyAt" IS NOT NULL
        AND "checkoutLastErrorCode" IS NULL
      )
      OR
      (
        "checkoutProvisioningStatus" = 'ambiguous'
        AND "checkoutCreationAllowed" = FALSE
        AND "providerCheckoutUrl" IS NULL
        AND "providerCheckoutStatus" IS NULL
        AND "checkoutReadyAt" IS NULL
        AND "checkoutLastErrorCode" IS NOT NULL
      )
      OR
      (
        "checkoutProvisioningStatus" = 'failed'
        AND "checkoutCreationAllowed" = TRUE
        AND "providerCheckoutId" IS NULL
        AND "providerCheckoutUrl" IS NULL
        AND "providerCheckoutStatus" IS NULL
        AND "checkoutReadyAt" IS NULL
        AND "checkoutLastErrorCode" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "Subscription_checkout_timestamp_check"
    CHECK ("checkoutClosedAt" IS NULL OR "checkoutClosedAt" >= "checkoutReadyAt");

CREATE FUNCTION "enforce_checkout_provisioning_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."familyId" IS DISTINCT FROM OLD."familyId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."externalId" IS DISTINCT FROM OLD."externalId"
     OR NEW."providerProductId" IS DISTINCT FROM OLD."providerProductId"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."billingCycle" IS DISTINCT FROM OLD."billingCycle"
     OR NEW."devMode" IS DISTINCT FROM OLD."devMode" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_IDENTITY_IS_IMMUTABLE';
  END IF;

  IF OLD."providerCheckoutId" IS NOT NULL
     AND NEW."providerCheckoutId" IS DISTINCT FROM OLD."providerCheckoutId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_PROVIDER_CHECKOUT_ID_IS_IMMUTABLE';
  END IF;

  IF OLD."providerCheckoutUrl" IS NOT NULL
     AND NEW."providerCheckoutUrl" IS DISTINCT FROM OLD."providerCheckoutUrl" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_PROVIDER_CHECKOUT_URL_IS_IMMUTABLE';
  END IF;

  IF OLD."checkoutReadyAt" IS NOT NULL
     AND NEW."checkoutReadyAt" IS DISTINCT FROM OLD."checkoutReadyAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_READY_AT_IS_IMMUTABLE';
  END IF;

  IF NEW."checkoutAttempts" < OLD."checkoutAttempts" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_ATTEMPTS_ARE_MONOTONIC';
  END IF;

  IF OLD."checkoutClosedAt" IS NOT NULL
     AND (
       NEW."checkoutClosedAt" IS DISTINCT FROM OLD."checkoutClosedAt"
       OR NEW."checkoutCloseReason" IS DISTINCT FROM OLD."checkoutCloseReason"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_CLOSURE_IS_IMMUTABLE';
  END IF;

  IF OLD."checkoutProvisioningStatus" = 'ready'
     AND NEW."checkoutProvisioningStatus" <> 'ready' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_READY_IS_TERMINAL';
  END IF;

  IF OLD."checkoutProvisioningStatus" = 'pending'
     AND NEW."checkoutProvisioningStatus" NOT IN ('pending', 'processing', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_INVALID_STATE_TRANSITION';
  END IF;

  IF OLD."checkoutProvisioningStatus" = 'failed'
     AND NEW."checkoutProvisioningStatus" NOT IN ('failed', 'processing') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_INVALID_STATE_TRANSITION';
  END IF;

  IF OLD."checkoutProvisioningStatus" = 'ambiguous'
     AND NEW."checkoutProvisioningStatus" NOT IN ('ambiguous', 'processing') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_INVALID_STATE_TRANSITION';
  END IF;

  IF OLD."checkoutProvisioningStatus" = 'processing'
     AND NEW."checkoutProvisioningStatus" NOT IN ('processing', 'ready', 'ambiguous', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SUBSCRIPTION_CHECKOUT_INVALID_STATE_TRANSITION';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Subscription_checkout_provisioning_transition"
BEFORE UPDATE ON "Subscription"
FOR EACH ROW EXECUTE FUNCTION "enforce_checkout_provisioning_transition"();

COMMIT;
