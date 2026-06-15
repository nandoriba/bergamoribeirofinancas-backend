ALTER TABLE "TelegramFinancialOperation"
DROP CONSTRAINT "TelegramFinancialOperation_one_effect_chk";

ALTER TABLE "TelegramFinancialOperation"
ADD CONSTRAINT "TelegramFinancialOperation_one_effect_chk"
CHECK (
  (
    "status" = 'UNDONE'
    AND "transactionId" IS NULL
    AND "installmentPlanId" IS NULL
  )
  OR
  (
    (CASE WHEN "transactionId" IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "installmentPlanId" IS NULL THEN 0 ELSE 1 END) = 1
  )
);
