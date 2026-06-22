ALTER TABLE "Transaction"
ADD COLUMN "isInvoiceAdjustment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "invoiceAmountCents" INTEGER;
