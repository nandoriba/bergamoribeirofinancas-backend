-- Add reference month and installment metadata.
ALTER TABLE "Transaction" ADD COLUMN "referenceMonth" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "installmentNumber" INTEGER;
ALTER TABLE "Transaction" ADD COLUMN "linkedToPlanAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "linkedToPlanByUserId" TEXT;

-- Backfill the economic month before normalizing date to its new bookkeeping meaning.
UPDATE "Transaction" AS t
SET "referenceMonth" = DATE_TRUNC('month', invoice."referenceMonth")
FROM "Invoice" AS invoice
WHERE t."invoiceId" = invoice."id";

UPDATE "Transaction"
SET "referenceMonth" = DATE_TRUNC('month', "date")
WHERE "referenceMonth" IS NULL;

-- D10: date means bookkeeping/entry date. CSV original dates remain in ImportRow.date.
UPDATE "Transaction"
SET "date" = "createdAt";

ALTER TABLE "Transaction" ALTER COLUMN "referenceMonth" SET NOT NULL;

ALTER TABLE "InstallmentPlan" ADD COLUMN "firstInstallmentNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "InstallmentPlan" ADD COLUMN "firstReferenceMonth" TIMESTAMP(3);

UPDATE "InstallmentPlan"
SET "firstReferenceMonth" = DATE_TRUNC('month', "startsAt");

ALTER TABLE "InstallmentPlan" ALTER COLUMN "firstReferenceMonth" SET NOT NULL;

CREATE UNIQUE INDEX "Transaction_installmentPlanId_installmentNumber_key" ON "Transaction"("installmentPlanId", "installmentNumber");
CREATE INDEX "Transaction_memberProfileId_referenceMonth_idx" ON "Transaction"("memberProfileId", "referenceMonth");
