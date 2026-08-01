BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "MemberApproval"
     GROUP BY "inviteId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'FATIA9_DUPLICATE_MEMBER_APPROVAL_INVITE';
  END IF;
END
$$;

CREATE UNIQUE INDEX "MemberApproval_inviteId_key"
  ON "MemberApproval"("inviteId");

ALTER TABLE "OAuthAttempt"
  ADD COLUMN "inviteDisplayName" TEXT;

-- Tentativas anteriores não armazenavam o nome necessário para concluir o
-- aceite. Elas são efêmeras e não podem ser migradas com segurança.
DELETE FROM "OAuthAttempt"
 WHERE "intent" = 'accept_invite';

ALTER TABLE "OAuthAttempt"
  DROP CONSTRAINT "OAuthAttempt_accept_invite_check",
  ADD CONSTRAINT "OAuthAttempt_accept_invite_check"
    CHECK (
      (
        "intent" = 'accept_invite'
        AND "memberInviteId" IS NOT NULL
        AND "inviteDisplayName" IS NOT NULL
        AND char_length(btrim("inviteDisplayName")) BETWEEN 2 AND 80
      )
      OR
      (
        "intent" <> 'accept_invite'
        AND "memberInviteId" IS NULL
        AND "inviteDisplayName" IS NULL
      )
    );

CREATE INDEX "UserActionToken_purpose_deliveryEmail_createdAt_idx"
  ON "UserActionToken"("purpose", "deliveryEmail", "createdAt");

COMMIT;
