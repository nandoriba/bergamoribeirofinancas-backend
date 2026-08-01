LOCK TABLE "TelegramUserLink", "TelegramAuthorizedGroup", "MemberProfile" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "TelegramUserLink" ADD COLUMN "familyId" TEXT;

UPDATE "TelegramUserLink" AS telegram_link
SET "familyId" = authorized_group."familyId"
FROM "TelegramAuthorizedGroup" AS authorized_group
WHERE authorized_group."chatId" = telegram_link."chatId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TelegramUserLink"
    WHERE "familyId" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FATIA11_TELEGRAM_LINK_WITHOUT_AUTHORIZED_GROUP';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TelegramUserLink" AS telegram_link
    JOIN "MemberProfile" AS member_profile
      ON member_profile."id" = telegram_link."memberProfileId"
    WHERE member_profile."familyId" IS DISTINCT FROM telegram_link."familyId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'FATIA11_CROSS_TENANT_TELEGRAM_LINK';
  END IF;
END
$$;

ALTER TABLE "TelegramUserLink" ALTER COLUMN "familyId" SET NOT NULL;

WITH ranked_active_links AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "memberProfileId", "chatId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS active_rank
  FROM "TelegramUserLink"
  WHERE "revokedAt" IS NULL
)
UPDATE "TelegramUserLink" AS telegram_link
SET "revokedAt" = CURRENT_TIMESTAMP
FROM ranked_active_links
WHERE ranked_active_links."id" = telegram_link."id"
  AND ranked_active_links.active_rank > 1;

CREATE UNIQUE INDEX "MemberProfile_id_familyId_key"
  ON "MemberProfile"("id", "familyId");
CREATE UNIQUE INDEX "TelegramAuthorizedGroup_chatId_familyId_key"
  ON "TelegramAuthorizedGroup"("chatId", "familyId");
CREATE UNIQUE INDEX "TelegramUserLink_active_profile_chat_key"
  ON "TelegramUserLink"("memberProfileId", "chatId")
  WHERE "revokedAt" IS NULL;
CREATE INDEX "TelegramUserLink_familyId_idx"
  ON "TelegramUserLink"("familyId");

ALTER TABLE "TelegramUserLink"
  DROP CONSTRAINT "TelegramUserLink_memberProfileId_fkey";
ALTER TABLE "TelegramUserLink"
  ADD CONSTRAINT "TelegramUserLink_memberProfileId_familyId_fkey"
  FOREIGN KEY ("memberProfileId", "familyId")
  REFERENCES "MemberProfile"("id", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TelegramUserLink"
  ADD CONSTRAINT "TelegramUserLink_chatId_familyId_fkey"
  FOREIGN KEY ("chatId", "familyId")
  REFERENCES "TelegramAuthorizedGroup"("chatId", "familyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "TelegramUserLink_familyId_immutable"
BEFORE UPDATE OF "familyId" ON "TelegramUserLink"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_key_change"();
