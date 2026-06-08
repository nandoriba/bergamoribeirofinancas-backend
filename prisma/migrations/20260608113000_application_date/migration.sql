ALTER TABLE "Transaction" ADD COLUMN "applicationDate" TIMESTAMP(3);

UPDATE "Transaction"
SET "applicationDate" = "date"
WHERE "applicationDate" IS NULL;

ALTER TABLE "Transaction" ALTER COLUMN "applicationDate" SET NOT NULL;

CREATE INDEX "Transaction_memberProfileId_applicationDate_idx" ON "Transaction"("memberProfileId", "applicationDate");
