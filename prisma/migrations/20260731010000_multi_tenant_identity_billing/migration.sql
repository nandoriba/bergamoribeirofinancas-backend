BEGIN;

LOCK TABLE "Family", "User", "MemberProfile", "MemberInvite", "MemberApproval", "TelegramAuthorizedGroup"
  IN SHARE ROW EXCLUSIVE MODE;

-- Abort before changing data when legacy tenant references are inconsistent.
DO $$
DECLARE
  profile_mismatches INTEGER;
  users_without_profiles INTEGER;
  tenant_reference_mismatches INTEGER;
  invalid_owner_families INTEGER;
  duplicate_active_groups INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO profile_mismatches
    FROM "MemberProfile" profile
    JOIN "User" app_user ON app_user."id" = profile."userId"
   WHERE profile."familyId" <> app_user."familyId";

  IF profile_mismatches > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_PROFILE_FAMILY_MISMATCH: %s profile row(s) disagree with their user family',
        profile_mismatches
      );
  END IF;

  SELECT COUNT(*)
    INTO users_without_profiles
    FROM "User" app_user
    LEFT JOIN "MemberProfile" profile ON profile."userId" = app_user."id"
   WHERE profile."id" IS NULL;

  IF users_without_profiles > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_USER_WITHOUT_PROFILE: %s legacy user row(s) do not have a member profile',
        users_without_profiles
      );
  END IF;

  SELECT COUNT(*)
    INTO tenant_reference_mismatches
    FROM (
      SELECT invite."id"
        FROM "MemberInvite" invite
        JOIN "User" creator ON creator."id" = invite."creatorUserId"
       WHERE invite."familyId" <> creator."familyId"
      UNION ALL
      SELECT approval."id"
        FROM "MemberApproval" approval
        JOIN "MemberInvite" invite ON invite."id" = approval."inviteId"
       WHERE approval."familyId" <> invite."familyId"
      UNION ALL
      SELECT approval."id"
        FROM "MemberApproval" approval
        LEFT JOIN "User" approved_user ON approved_user."id" = approval."userId"
       WHERE approval."userId" IS NOT NULL
         AND (
           approved_user."id" IS NULL
           OR approval."familyId" <> approved_user."familyId"
         )
      UNION ALL
      SELECT approval."id"
        FROM "MemberApproval" approval
        JOIN "User" reviewer ON reviewer."id" = approval."reviewerUserId"
       WHERE approval."reviewerUserId" IS NOT NULL
         AND approval."familyId" <> reviewer."familyId"
      UNION ALL
      SELECT authorized_group."id"
        FROM "TelegramAuthorizedGroup" authorized_group
        JOIN "User" authorizer ON authorizer."id" = authorized_group."authorizedByUserId"
       WHERE authorized_group."familyId" <> authorizer."familyId"
    ) mismatches;

  IF tenant_reference_mismatches > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_TENANT_REFERENCE_MISMATCH: %s tenant-owned reference(s) point to users from another family',
        tenant_reference_mismatches
      );
  END IF;

  SELECT COUNT(*)
    INTO invalid_owner_families
    FROM (
      SELECT family."id"
        FROM "Family" family
        LEFT JOIN "User" candidate
          ON candidate."familyId" = family."id"
        LEFT JOIN "MemberProfile" profile
          ON profile."userId" = candidate."id"
       GROUP BY family."id"
      HAVING COUNT(candidate."id") FILTER (
               WHERE candidate."role" = 'admin'::"UserRole"
             ) <> 1
          OR COUNT(candidate."id") FILTER (
               WHERE candidate."role" = 'admin'::"UserRole"
                 AND candidate."isActive" = TRUE
                 AND profile."status" = 'active'::"ProfileStatus"
                 AND profile."familyId" = family."id"
             ) <> 1
    ) invalid_families;

  IF invalid_owner_families > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_OWNER_BACKFILL_AMBIGUOUS: %s family row(s) do not have exactly one legacy admin who is active and has an active same-family profile',
        invalid_owner_families
      );
  END IF;

  SELECT COUNT(*)
    INTO duplicate_active_groups
    FROM (
      SELECT "familyId"
        FROM "TelegramAuthorizedGroup"
       WHERE "revokedAt" IS NULL
       GROUP BY "familyId"
      HAVING COUNT(*) > 1
    ) duplicates;

  IF duplicate_active_groups > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_MULTIPLE_ACTIVE_TELEGRAM_GROUPS: %s family row(s) have more than one active group',
        duplicate_active_groups
      );
  END IF;
END
$$;

ALTER TABLE "Family"
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "pendingPaymentExpiresAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

UPDATE "Family" family
   SET "ownerUserId" = candidate."id"
  FROM "User" candidate
  JOIN "MemberProfile" profile
    ON profile."userId" = candidate."id"
   AND profile."familyId" = candidate."familyId"
 WHERE candidate."familyId" = family."id"
   AND candidate."role" = 'admin'::"UserRole"
   AND candidate."isActive" = TRUE
   AND profile."status" = 'active'::"ProfileStatus";

DO $$
DECLARE
  missing_owners INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_owners FROM "Family" WHERE "ownerUserId" IS NULL;
  IF missing_owners > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'FATIA3_OWNER_BACKFILL_INCOMPLETE: %s existing family row(s) remained without owner',
        missing_owners
      );
  END IF;
END
$$;

ALTER TYPE "UserRole" RENAME TO "PlatformRole";
ALTER TYPE "PlatformRole" RENAME VALUE 'member' TO 'user';
ALTER TABLE "User" RENAME COLUMN "role" TO "platformRole";
ALTER TABLE "User" ALTER COLUMN "platformRole" SET DEFAULT 'user'::"PlatformRole";
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TYPE "IdentityProvider" AS ENUM ('google');
CREATE TYPE "OAuthIntent" AS ENUM ('login', 'signup_owner', 'accept_invite', 'link_account');
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');
CREATE TYPE "SubscriptionCycle" AS ENUM ('MONTHLY');
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('CARD');
CREATE TYPE "UserActionTokenPurpose" AS ENUM ('email_verification', 'password_reset');

CREATE TABLE "UserIdentity" (
  "id" TEXT NOT NULL,
  "provider" "IdentityProvider" NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "observedEmail" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthAttempt" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "browserBindingHash" TEXT NOT NULL,
  "pkceVerifierCiphertext" TEXT NOT NULL,
  "pkceVerifierKeyVersion" TEXT NOT NULL,
  "intent" "OAuthIntent" NOT NULL,
  "authenticatedUserId" TEXT,
  "memberInviteId" TEXT,
  "legalAcceptanceVersion" TEXT,
  "legalAcceptedAt" TIMESTAMP(3),
  "returnPath" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserActionToken" (
  "id" TEXT NOT NULL,
  "purpose" "UserActionTokenPurpose" NOT NULL,
  "secretHash" TEXT NOT NULL,
  "deliveryEmail" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserActionToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'abacatepay',
  "externalId" TEXT NOT NULL,
  "providerSubscriptionId" TEXT,
  "providerCustomerId" TEXT,
  "providerCheckoutId" TEXT,
  "providerProductId" TEXT NOT NULL,
  "providerStatus" TEXT,
  "lastProviderEvent" TEXT,
  "providerUpdatedAt" TIMESTAMP(3),
  "lastSuccessfulPaymentAt" TIMESTAMP(3),
  "accessPaidThrough" TIMESTAMP(3),
  "paymentFailedAt" TIMESTAMP(3),
  "graceUntil" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancelledDueTo" TEXT,
  "lastInstallmentNumber" INTEGER,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "paymentMethod" "SubscriptionPaymentMethod",
  "providerPaymentMethod" TEXT,
  "billingCycle" "SubscriptionCycle" NOT NULL DEFAULT 'MONTHLY',
  "devMode" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionPayment" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "providerPaymentId" TEXT,
  "providerInstallmentId" TEXT,
  "providerStatus" TEXT NOT NULL,
  "installmentNumber" INTEGER,
  "retryNumber" INTEGER,
  "maxRetry" INTEGER,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "paymentMethod" "SubscriptionPaymentMethod",
  "providerPaymentMethod" TEXT,
  "dueAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cycleStartedAt" TIMESTAMP(3),
  "cycleEndedAt" TIMESTAMP(3),
  "appliedAccessPaidThrough" TIMESTAMP(3),
  "providerCreatedAt" TIMESTAMP(3),
  "providerUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'abacatepay',
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "apiVersion" TEXT,
  "devMode" BOOLEAN,
  "payloadHash" TEXT NOT NULL,
  "sanitizedPayload" JSONB,
  "signatureValid" BOOLEAN NOT NULL,
  "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "familyId" TEXT,
  "subscriptionId" TEXT,
  "subscriptionPaymentId" TEXT,
  "providerSubscriptionId" TEXT,
  "providerPaymentId" TEXT,
  "occurredAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "errorCode" TEXT,
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_id_familyId_key" ON "User"("id", "familyId");
CREATE INDEX "User_familyId_idx" ON "User"("familyId");
CREATE UNIQUE INDEX "Family_ownerUserId_key" ON "Family"("ownerUserId");
CREATE UNIQUE INDEX "Family_ownerUserId_id_key" ON "Family"("ownerUserId", "id");
CREATE INDEX "Family_pendingPaymentExpiresAt_idx" ON "Family"("pendingPaymentExpiresAt");
CREATE INDEX "Family_purgeAfter_idx" ON "Family"("purgeAfter");
CREATE UNIQUE INDEX "MemberProfile_userId_familyId_key" ON "MemberProfile"("userId", "familyId");
CREATE INDEX "MemberProfile_familyId_idx" ON "MemberProfile"("familyId");

CREATE UNIQUE INDEX "UserIdentity_provider_providerSubject_key" ON "UserIdentity"("provider", "providerSubject");
CREATE UNIQUE INDEX "UserIdentity_userId_provider_key" ON "UserIdentity"("userId", "provider");
CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity"("userId");

CREATE UNIQUE INDEX "OAuthAttempt_stateHash_key" ON "OAuthAttempt"("stateHash");
CREATE UNIQUE INDEX "OAuthAttempt_nonceHash_key" ON "OAuthAttempt"("nonceHash");
CREATE INDEX "OAuthAttempt_browserBindingHash_expiresAt_idx" ON "OAuthAttempt"("browserBindingHash", "expiresAt");
CREATE INDEX "OAuthAttempt_authenticatedUserId_idx" ON "OAuthAttempt"("authenticatedUserId");
CREATE INDEX "OAuthAttempt_memberInviteId_idx" ON "OAuthAttempt"("memberInviteId");
CREATE INDEX "OAuthAttempt_expiresAt_consumedAt_idx" ON "OAuthAttempt"("expiresAt", "consumedAt");

CREATE UNIQUE INDEX "UserActionToken_secretHash_key" ON "UserActionToken"("secretHash");
CREATE INDEX "UserActionToken_userId_purpose_expiresAt_idx" ON "UserActionToken"("userId", "purpose", "expiresAt");
CREATE INDEX "UserActionToken_expiresAt_consumedAt_revokedAt_idx" ON "UserActionToken"("expiresAt", "consumedAt", "revokedAt");
-- Issuance must revoke the previous unconsumed token in the same transaction; expiry alone
-- intentionally does not release this slot, avoiding concurrent valid deliveries.
CREATE UNIQUE INDEX "UserActionToken_one_active_per_purpose"
  ON "UserActionToken"("userId", "purpose")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;

CREATE UNIQUE INDEX "Subscription_externalId_key" ON "Subscription"("externalId");
CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key" ON "Subscription"("provider", "providerSubscriptionId");
CREATE UNIQUE INDEX "Subscription_provider_providerCheckoutId_key" ON "Subscription"("provider", "providerCheckoutId");
CREATE INDEX "Subscription_familyId_idx" ON "Subscription"("familyId");
CREATE INDEX "Subscription_familyId_providerStatus_idx" ON "Subscription"("familyId", "providerStatus");
CREATE INDEX "Subscription_provider_providerCustomerId_idx" ON "Subscription"("provider", "providerCustomerId");
CREATE INDEX "Subscription_providerProductId_idx" ON "Subscription"("providerProductId");
CREATE UNIQUE INDEX "Subscription_id_familyId_key" ON "Subscription"("id", "familyId");
CREATE UNIQUE INDEX "Subscription_one_open_per_family"
  ON "Subscription"("familyId")
  WHERE "cancelledAt" IS NULL;

CREATE UNIQUE INDEX "SubscriptionPayment_providerPaymentId_key" ON "SubscriptionPayment"("providerPaymentId");
CREATE UNIQUE INDEX "SubscriptionPayment_subscriptionId_providerInstallmentId_key" ON "SubscriptionPayment"("subscriptionId", "providerInstallmentId");
CREATE INDEX "SubscriptionPayment_subscriptionId_providerStatus_idx" ON "SubscriptionPayment"("subscriptionId", "providerStatus");
CREATE INDEX "SubscriptionPayment_familyId_idx" ON "SubscriptionPayment"("familyId");
CREATE INDEX "SubscriptionPayment_subscriptionId_installmentNumber_idx" ON "SubscriptionPayment"("subscriptionId", "installmentNumber");
CREATE INDEX "SubscriptionPayment_providerInstallmentId_idx" ON "SubscriptionPayment"("providerInstallmentId");
CREATE INDEX "SubscriptionPayment_dueAt_idx" ON "SubscriptionPayment"("dueAt");
CREATE UNIQUE INDEX "SubscriptionPayment_id_familyId_key" ON "SubscriptionPayment"("id", "familyId");
CREATE UNIQUE INDEX "SubscriptionPayment_id_subscriptionId_familyId_key"
  ON "SubscriptionPayment"("id", "subscriptionId", "familyId");

CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_providerEventId_key" ON "PaymentWebhookEvent"("provider", "providerEventId");
CREATE INDEX "PaymentWebhookEvent_familyId_receivedAt_idx" ON "PaymentWebhookEvent"("familyId", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_subscriptionId_eventType_idx" ON "PaymentWebhookEvent"("subscriptionId", "eventType");
CREATE INDEX "PaymentWebhookEvent_subscriptionPaymentId_idx" ON "PaymentWebhookEvent"("subscriptionPaymentId");
CREATE INDEX "PaymentWebhookEvent_provider_providerSubscriptionId_idx" ON "PaymentWebhookEvent"("provider", "providerSubscriptionId");
CREATE INDEX "PaymentWebhookEvent_provider_providerPaymentId_idx" ON "PaymentWebhookEvent"("provider", "providerPaymentId");
CREATE INDEX "PaymentWebhookEvent_processingStatus_receivedAt_idx" ON "PaymentWebhookEvent"("processingStatus", "receivedAt");

CREATE INDEX "MemberInvite_familyId_idx" ON "MemberInvite"("familyId");
CREATE UNIQUE INDEX "MemberInvite_id_familyId_key" ON "MemberInvite"("id", "familyId");
CREATE INDEX "MemberApproval_familyId_idx" ON "MemberApproval"("familyId");
CREATE INDEX "Account_memberProfileId_idx" ON "Account"("memberProfileId");
CREATE INDEX "Invoice_memberProfileId_idx" ON "Invoice"("memberProfileId");
CREATE INDEX "RecurringTemplate_memberProfileId_idx" ON "RecurringTemplate"("memberProfileId");
CREATE INDEX "InstallmentPlan_memberProfileId_idx" ON "InstallmentPlan"("memberProfileId");
CREATE INDEX "ImportBatch_memberProfileId_idx" ON "ImportBatch"("memberProfileId");

CREATE UNIQUE INDEX "TelegramAuthorizedGroup_one_active_per_family"
  ON "TelegramAuthorizedGroup"("familyId")
  WHERE "revokedAt" IS NULL;

ALTER TABLE "Family"
  ADD CONSTRAINT "Family_ownerUserId_id_fkey"
  FOREIGN KEY ("ownerUserId", "id") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "MemberProfile" DROP CONSTRAINT "MemberProfile_userId_fkey";
ALTER TABLE "MemberProfile"
  ADD CONSTRAINT "MemberProfile_userId_familyId_fkey"
  FOREIGN KEY ("userId", "familyId") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "MemberInvite" DROP CONSTRAINT "MemberInvite_creatorUserId_fkey";
ALTER TABLE "MemberInvite"
  ADD CONSTRAINT "MemberInvite_creatorUserId_familyId_fkey"
  FOREIGN KEY ("creatorUserId", "familyId") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "MemberApproval"
  DROP CONSTRAINT "MemberApproval_inviteId_fkey",
  DROP CONSTRAINT "MemberApproval_reviewerUserId_fkey";
ALTER TABLE "MemberApproval"
  ADD CONSTRAINT "MemberApproval_inviteId_familyId_fkey"
  FOREIGN KEY ("inviteId", "familyId") REFERENCES "MemberInvite"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberApproval"
  ADD CONSTRAINT "MemberApproval_userId_familyId_fkey"
  FOREIGN KEY ("userId", "familyId") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberApproval"
  ADD CONSTRAINT "MemberApproval_reviewerUserId_familyId_fkey"
  FOREIGN KEY ("reviewerUserId", "familyId") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "TelegramAuthorizedGroup" DROP CONSTRAINT "TelegramAuthorizedGroup_authorizedByUserId_fkey";
ALTER TABLE "TelegramAuthorizedGroup"
  ADD CONSTRAINT "TelegramAuthorizedGroup_authorizedByUserId_familyId_fkey"
  FOREIGN KEY ("authorizedByUserId", "familyId") REFERENCES "User"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "UserIdentity"
  ADD CONSTRAINT "UserIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OAuthAttempt"
  ADD CONSTRAINT "OAuthAttempt_authenticatedUserId_fkey"
  FOREIGN KEY ("authenticatedUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OAuthAttempt"
  ADD CONSTRAINT "OAuthAttempt_memberInviteId_fkey"
  FOREIGN KEY ("memberInviteId") REFERENCES "MemberInvite"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActionToken"
  ADD CONSTRAINT "UserActionToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionPayment"
  ADD CONSTRAINT "SubscriptionPayment_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment"
  ADD CONSTRAINT "SubscriptionPayment_subscriptionId_familyId_fkey"
  FOREIGN KEY ("subscriptionId", "familyId") REFERENCES "Subscription"("id", "familyId")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_subscriptionId_familyId_fkey"
  FOREIGN KEY ("subscriptionId", "familyId") REFERENCES "Subscription"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_subscriptionPaymentId_familyId_fkey"
  FOREIGN KEY ("subscriptionPaymentId", "subscriptionId", "familyId")
  REFERENCES "SubscriptionPayment"("id", "subscriptionId", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Family"
  ADD CONSTRAINT "Family_pending_payment_expiry_check"
  CHECK ("pendingPaymentExpiresAt" IS NULL OR "pendingPaymentExpiresAt" > "createdAt"),
  ADD CONSTRAINT "Family_cancellation_retention_pair_check"
  CHECK (("cancelledAt" IS NULL) = ("purgeAfter" IS NULL)),
  ADD CONSTRAINT "Family_purge_after_cancellation_check"
  CHECK ("purgeAfter" IS NULL OR "purgeAfter" > "cancelledAt");

ALTER TABLE "OAuthAttempt"
  ADD CONSTRAINT "OAuthAttempt_expiry_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "OAuthAttempt_link_account_user_check"
    CHECK (("intent" = 'link_account') = ("authenticatedUserId" IS NOT NULL)),
  ADD CONSTRAINT "OAuthAttempt_accept_invite_check"
    CHECK (("intent" = 'accept_invite') = ("memberInviteId" IS NOT NULL)),
  ADD CONSTRAINT "OAuthAttempt_signup_legal_check"
    CHECK (
      ("intent" = 'signup_owner')
      = ("legalAcceptanceVersion" IS NOT NULL AND "legalAcceptedAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "OAuthAttempt_return_path_check"
    CHECK ("returnPath" IS NULL OR (LEFT("returnPath", 1) = '/' AND LEFT("returnPath", 2) <> '//'));

ALTER TABLE "UserActionToken"
  ADD CONSTRAINT "UserActionToken_expiry_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "UserActionToken_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "UserActionToken_terminal_state_check"
    CHECK ("consumedAt" IS NULL OR "revokedAt" IS NULL);

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_amount_check" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "Subscription_currency_check" CHECK ("currency" = 'BRL'),
  ADD CONSTRAINT "Subscription_installment_check"
    CHECK ("lastInstallmentNumber" IS NULL OR "lastInstallmentNumber" > 0),
  ADD CONSTRAINT "Subscription_grace_check"
    CHECK ("graceUntil" IS NULL OR "paymentFailedAt" IS NOT NULL);

ALTER TABLE "SubscriptionPayment"
  ADD CONSTRAINT "SubscriptionPayment_amount_check" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "SubscriptionPayment_currency_check" CHECK ("currency" = 'BRL'),
  ADD CONSTRAINT "SubscriptionPayment_provider_reference_check"
    CHECK ("providerPaymentId" IS NOT NULL OR "providerInstallmentId" IS NOT NULL),
  ADD CONSTRAINT "SubscriptionPayment_installment_check"
    CHECK ("installmentNumber" IS NULL OR "installmentNumber" > 0),
  ADD CONSTRAINT "SubscriptionPayment_retry_check"
    CHECK (
      ("retryNumber" IS NULL OR "retryNumber" >= 0)
      AND ("maxRetry" IS NULL OR "maxRetry" >= 0)
      AND ("retryNumber" IS NULL OR "maxRetry" IS NULL OR "retryNumber" <= "maxRetry")
    ),
  ADD CONSTRAINT "SubscriptionPayment_cycle_check"
    CHECK ("cycleEndedAt" IS NULL OR ("cycleStartedAt" IS NOT NULL AND "cycleEndedAt" > "cycleStartedAt"));

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "PaymentWebhookEvent_signature_check" CHECK ("signatureValid" = TRUE),
  ADD CONSTRAINT "PaymentWebhookEvent_subscription_tenant_check"
    CHECK ("subscriptionId" IS NULL OR "familyId" IS NOT NULL),
  ADD CONSTRAINT "PaymentWebhookEvent_payment_tenant_check"
    CHECK (
      "subscriptionPaymentId" IS NULL
      OR ("subscriptionId" IS NOT NULL AND "familyId" IS NOT NULL)
    ),
  ADD CONSTRAINT "PaymentWebhookEvent_processed_at_check"
    CHECK ("processedAt" IS NULL OR "processedAt" >= "receivedAt");

CREATE FUNCTION "enforce_family_owner_at_commit"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Family" WHERE "id" = NEW."id") THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "Family" family
      JOIN "User" owner_user
        ON owner_user."id" = family."ownerUserId"
       AND owner_user."familyId" = family."id"
       AND owner_user."isActive" = TRUE
      JOIN "MemberProfile" owner_profile
        ON owner_profile."userId" = owner_user."id"
       AND owner_profile."familyId" = family."id"
       AND owner_profile."status" = 'active'::"ProfileStatus"
     WHERE family."id" = NEW."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FAMILY_ACTIVE_OWNER_REQUIRED_AT_COMMIT';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Family_owner_required_at_commit"
AFTER INSERT OR UPDATE ON "Family"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_family_owner_at_commit"();

CREATE FUNCTION "enforce_owner_change_only_for_purge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."ownerUserId" IS NOT NULL
     AND NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
     AND EXISTS (SELECT 1 FROM "Family" WHERE "id" = OLD."id") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FAMILY_OWNER_IS_IMMUTABLE_IN_MVP';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Family_owner_change_only_for_purge"
AFTER UPDATE OF "ownerUserId" ON "Family"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_owner_change_only_for_purge"();

CREATE FUNCTION "prevent_owner_user_deactivation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."isActive" = TRUE
     AND NEW."isActive" = FALSE
     AND EXISTS (SELECT 1 FROM "Family" WHERE "ownerUserId" = OLD."id") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FAMILY_OWNER_CANNOT_BE_DEACTIVATED';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "User_owner_cannot_be_deactivated"
BEFORE UPDATE OF "isActive" ON "User"
FOR EACH ROW EXECUTE FUNCTION "prevent_owner_user_deactivation"();

CREATE FUNCTION "protect_owner_profile"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "Family"
     WHERE "id" = OLD."familyId"
       AND "ownerUserId" = OLD."userId"
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'FAMILY_OWNER_PROFILE_MUST_REMAIN_ACTIVE';
    END IF;

    IF NEW."status" <> 'active'::"ProfileStatus"
       OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'FAMILY_OWNER_PROFILE_MUST_REMAIN_ACTIVE';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MemberProfile_owner_protected"
BEFORE UPDATE OR DELETE ON "MemberProfile"
FOR EACH ROW EXECUTE FUNCTION "protect_owner_profile"();

CREATE FUNCTION "prevent_tenant_key_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."familyId" IS DISTINCT FROM OLD."familyId" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'TENANT_KEY_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "User_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "User"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "MemberProfile_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "MemberProfile"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "MemberInvite_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "MemberInvite"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "MemberApproval_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "MemberApproval"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "Category_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "Category"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "TelegramAuthorizedGroup_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "TelegramAuthorizedGroup"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "Subscription_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "Subscription"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE TRIGGER "SubscriptionPayment_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "SubscriptionPayment"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();

CREATE FUNCTION "bind_tenant_key_once"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."familyId" IS NOT NULL AND NEW."familyId" IS DISTINCT FROM OLD."familyId" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'TENANT_KEY_BINDING_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentWebhookEvent_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "PaymentWebhookEvent"
FOR EACH ROW EXECUTE FUNCTION "bind_tenant_key_once"();

CREATE FUNCTION "prevent_consumed_at_reversal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'CONSUMED_AT_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OAuthAttempt_consumedAt_immutable"
BEFORE UPDATE ON "OAuthAttempt"
FOR EACH ROW
EXECUTE FUNCTION "prevent_consumed_at_reversal"();

CREATE TRIGGER "UserActionToken_consumedAt_immutable"
BEFORE UPDATE ON "UserActionToken"
FOR EACH ROW
EXECUTE FUNCTION "prevent_consumed_at_reversal"();

CREATE FUNCTION "prevent_action_token_revocation_reversal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'REVOKED_AT_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "UserActionToken_revokedAt_immutable"
BEFORE UPDATE OF "revokedAt" ON "UserActionToken"
FOR EACH ROW
EXECUTE FUNCTION "prevent_action_token_revocation_reversal"();

CREATE FUNCTION "enforce_subscription_monotonic_facts"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."accessPaidThrough" IS NOT NULL
     AND (NEW."accessPaidThrough" IS NULL OR NEW."accessPaidThrough" < OLD."accessPaidThrough") THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'SUBSCRIPTION_ACCESS_PAID_THROUGH_REGRESSION';
  END IF;
  IF OLD."lastSuccessfulPaymentAt" IS NOT NULL
     AND (NEW."lastSuccessfulPaymentAt" IS NULL OR NEW."lastSuccessfulPaymentAt" < OLD."lastSuccessfulPaymentAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'SUBSCRIPTION_LAST_PAYMENT_REGRESSION';
  END IF;
  IF OLD."providerUpdatedAt" IS NOT NULL
     AND (NEW."providerUpdatedAt" IS NULL OR NEW."providerUpdatedAt" < OLD."providerUpdatedAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'SUBSCRIPTION_PROVIDER_TIMESTAMP_REGRESSION';
  END IF;
  IF OLD."lastInstallmentNumber" IS NOT NULL
     AND (NEW."lastInstallmentNumber" IS NULL OR NEW."lastInstallmentNumber" < OLD."lastInstallmentNumber") THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'SUBSCRIPTION_INSTALLMENT_REGRESSION';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'SUBSCRIPTION_CANCELLATION_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Subscription_monotonic_facts"
BEFORE UPDATE ON "Subscription"
FOR EACH ROW
EXECUTE FUNCTION "enforce_subscription_monotonic_facts"();

COMMIT;
