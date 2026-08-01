BEGIN;

CREATE TYPE "LegalAcceptanceSource" AS ENUM ('local', 'google');
CREATE TYPE "EmailOutboxStatus" AS ENUM ('pending', 'processing', 'sent', 'discarded');
CREATE TYPE "PasswordResetRequestStatus" AS ENUM ('pending', 'processing', 'completed', 'discarded');

ALTER TABLE "User"
  ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

-- Every existing account predates mandatory verification, including inactive
-- invitees awaiting owner approval. New onboarding records created after this
-- migration remain unverified until their challenge succeeds.
UPDATE "User"
SET "emailVerifiedAt" = CURRENT_TIMESTAMP
WHERE "emailVerifiedAt" IS NULL;

-- Fail with a stable diagnostic before the canonicalization can hit the old unique
-- index in a non-obvious row order.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'USER_EMAIL_CANONICAL_COLLISION';
  END IF;

  IF EXISTS (SELECT 1 FROM "User" WHERE btrim("email") = '') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'USER_EMAIL_CANNOT_BE_EMPTY';
  END IF;
END
$$;

UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" IS DISTINCT FROM lower(btrim("email"));

ALTER TABLE "User"
  ADD CONSTRAINT "User_email_canonical_check"
    CHECK ("email" = lower(btrim("email")) AND length("email") > 0),
  ADD CONSTRAINT "User_auth_version_check"
    CHECK ("authVersion" >= 0);

ALTER TABLE "OAuthAttempt"
  ADD COLUMN "signupOwnerName" TEXT,
  ADD COLUMN "signupFamilyName" TEXT;

ALTER TABLE "OAuthAttempt"
  DROP CONSTRAINT "OAuthAttempt_signup_legal_check",
  ADD CONSTRAINT "OAuthAttempt_signup_legal_check"
    CHECK (
      (
        "intent" = 'signup_owner'
        AND "legalAcceptanceVersion" IS NOT NULL
        AND btrim("legalAcceptanceVersion") <> ''
        AND "legalAcceptedAt" IS NOT NULL
        AND "signupOwnerName" IS NOT NULL
        AND btrim("signupOwnerName") <> ''
        AND "signupFamilyName" IS NOT NULL
        AND btrim("signupFamilyName") <> ''
      )
      OR
      (
        "intent" <> 'signup_owner'
        AND "legalAcceptanceVersion" IS NULL
        AND "legalAcceptedAt" IS NULL
        AND "signupOwnerName" IS NULL
        AND "signupFamilyName" IS NULL
      )
    );

CREATE TABLE "LegalAcceptance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "bundleVersion" TEXT NOT NULL,
  "source" "LegalAcceptanceSource" NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalAcceptance_userId_bundleVersion_key"
  ON "LegalAcceptance"("userId", "bundleVersion");
CREATE INDEX "LegalAcceptance_familyId_acceptedAt_idx"
  ON "LegalAcceptance"("familyId", "acceptedAt");

ALTER TABLE "LegalAcceptance"
  ADD CONSTRAINT "LegalAcceptance_userId_familyId_fkey"
    FOREIGN KEY ("userId", "familyId") REFERENCES "User"("id", "familyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "LegalAcceptance_familyId_fkey"
    FOREIGN KEY ("familyId") REFERENCES "Family"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "LegalAcceptance_bundle_version_check"
    CHECK (btrim("bundleVersion") <> '');

CREATE FUNCTION "protect_legal_acceptance"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'LEGAL_ACCEPTANCE_IS_APPEND_ONLY';
END
$$;

CREATE TRIGGER "LegalAcceptance_append_only"
BEFORE UPDATE OR DELETE ON "LegalAcceptance"
FOR EACH ROW EXECUTE FUNCTION "protect_legal_acceptance"();

CREATE TABLE "EmailOutbox" (
  "id" TEXT NOT NULL,
  "userActionTokenId" TEXT NOT NULL,
  "payloadCiphertext" TEXT,
  "payloadKeyVersion" TEXT NOT NULL,
  "status" "EmailOutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "discardedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailOutbox_userActionTokenId_key"
  ON "EmailOutbox"("userActionTokenId");
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx"
  ON "EmailOutbox"("status", "nextAttemptAt");
CREATE INDEX "EmailOutbox_lockedAt_idx"
  ON "EmailOutbox"("lockedAt");

ALTER TABLE "EmailOutbox"
  ADD CONSTRAINT "EmailOutbox_userActionTokenId_fkey"
    FOREIGN KEY ("userActionTokenId") REFERENCES "UserActionToken"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "EmailOutbox_attempts_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "EmailOutbox_payload_key_version_check"
    CHECK (btrim("payloadKeyVersion") <> ''),
  ADD CONSTRAINT "EmailOutbox_timestamp_order_check"
    CHECK (
      ("lockedAt" IS NULL OR "lockedAt" >= "createdAt")
      AND ("sentAt" IS NULL OR "sentAt" >= "createdAt")
      AND ("discardedAt" IS NULL OR "discardedAt" >= "createdAt")
    ),
  ADD CONSTRAINT "EmailOutbox_state_check"
    CHECK (
      (
        "status" = 'pending'
        AND "payloadCiphertext" IS NOT NULL
        AND "nextAttemptAt" IS NOT NULL
        AND "lockedAt" IS NULL
        AND "providerMessageId" IS NULL
        AND "sentAt" IS NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'processing'
        AND "payloadCiphertext" IS NOT NULL
        AND "attempts" > 0
        AND "lockedAt" IS NOT NULL
        AND "providerMessageId" IS NULL
        AND "sentAt" IS NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'sent'
        AND "payloadCiphertext" IS NULL
        AND "nextAttemptAt" IS NULL
        AND "lockedAt" IS NULL
        AND "sentAt" IS NOT NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'discarded'
        AND "payloadCiphertext" IS NULL
        AND "nextAttemptAt" IS NULL
        AND "lockedAt" IS NULL
        AND "providerMessageId" IS NULL
        AND "sentAt" IS NULL
        AND "discardedAt" IS NOT NULL
      )
    );

CREATE FUNCTION "enforce_email_outbox_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."userActionTokenId" IS DISTINCT FROM OLD."userActionTokenId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'EMAIL_OUTBOX_IDENTITY_IS_IMMUTABLE';
  END IF;

  IF OLD."status" IN ('sent', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'EMAIL_OUTBOX_TERMINAL_STATE_IS_IMMUTABLE';
  END IF;

  IF OLD."status" = 'pending'
     AND NEW."status" NOT IN ('pending', 'processing', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'EMAIL_OUTBOX_INVALID_STATE_TRANSITION';
  END IF;

  IF OLD."status" = 'processing'
     AND NEW."status" NOT IN ('processing', 'pending', 'sent', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'EMAIL_OUTBOX_INVALID_STATE_TRANSITION';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "EmailOutbox_state_transition"
BEFORE UPDATE ON "EmailOutbox"
FOR EACH ROW EXECUTE FUNCTION "enforce_email_outbox_transition"();

CREATE TABLE "PasswordResetRequest" (
  "id" TEXT NOT NULL,
  "emailCiphertext" TEXT,
  "payloadKeyVersion" TEXT NOT NULL,
  "status" "PasswordResetRequestStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "discardedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PasswordResetRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasswordResetRequest_status_nextAttemptAt_idx"
  ON "PasswordResetRequest"("status", "nextAttemptAt");
CREATE INDEX "PasswordResetRequest_lockedAt_idx"
  ON "PasswordResetRequest"("lockedAt");
CREATE INDEX "PasswordResetRequest_expiresAt_status_idx"
  ON "PasswordResetRequest"("expiresAt", "status");

ALTER TABLE "PasswordResetRequest"
  ADD CONSTRAINT "PasswordResetRequest_attempts_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "PasswordResetRequest_payload_key_version_check"
    CHECK (btrim("payloadKeyVersion") <> ''),
  ADD CONSTRAINT "PasswordResetRequest_timestamp_order_check"
    CHECK (
      "expiresAt" > "createdAt"
      AND ("lockedAt" IS NULL OR "lockedAt" >= "createdAt")
      AND ("completedAt" IS NULL OR "completedAt" >= "createdAt")
      AND ("discardedAt" IS NULL OR "discardedAt" >= "createdAt")
    ),
  ADD CONSTRAINT "PasswordResetRequest_state_check"
    CHECK (
      (
        "status" = 'pending'
        AND "emailCiphertext" IS NOT NULL
        AND "nextAttemptAt" IS NOT NULL
        AND "lockedAt" IS NULL
        AND "completedAt" IS NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'processing'
        AND "emailCiphertext" IS NOT NULL
        AND "attempts" > 0
        AND "nextAttemptAt" IS NOT NULL
        AND "lockedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'completed'
        AND "emailCiphertext" IS NULL
        AND "nextAttemptAt" IS NULL
        AND "lockedAt" IS NULL
        AND "completedAt" IS NOT NULL
        AND "discardedAt" IS NULL
      )
      OR
      (
        "status" = 'discarded'
        AND "emailCiphertext" IS NULL
        AND "nextAttemptAt" IS NULL
        AND "lockedAt" IS NULL
        AND "completedAt" IS NULL
        AND "discardedAt" IS NOT NULL
      )
    );

CREATE FUNCTION "enforce_password_reset_request_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."payloadKeyVersion" IS DISTINCT FROM OLD."payloadKeyVersion"
     OR (
       NEW."emailCiphertext" IS DISTINCT FROM OLD."emailCiphertext"
       AND NEW."emailCiphertext" IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASSWORD_RESET_REQUEST_IDENTITY_IS_IMMUTABLE';
  END IF;

  IF OLD."status" IN ('completed', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASSWORD_RESET_REQUEST_TERMINAL_STATE_IS_IMMUTABLE';
  END IF;

  IF OLD."status" = 'pending'
     AND NEW."status" NOT IN ('pending', 'processing', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASSWORD_RESET_REQUEST_INVALID_STATE_TRANSITION';
  END IF;

  IF OLD."status" = 'processing'
     AND NEW."status" NOT IN ('processing', 'pending', 'completed', 'discarded') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASSWORD_RESET_REQUEST_INVALID_STATE_TRANSITION';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "PasswordResetRequest_state_transition"
BEFORE UPDATE ON "PasswordResetRequest"
FOR EACH ROW EXECUTE FUNCTION "enforce_password_reset_request_transition"();

COMMIT;
