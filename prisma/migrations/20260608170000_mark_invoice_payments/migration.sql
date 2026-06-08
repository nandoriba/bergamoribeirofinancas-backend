UPDATE "Transaction" AS t
SET "isInvoicePayment" = true
FROM "Category" AS c
WHERE t."categoryId" = c."id"
  AND t."isInvoicePayment" = false
  AND t."type" = 'expense'
  AND LOWER(c."name") = 'cartão'
  AND LOWER(t."description") LIKE '%pagamento%'
  AND LOWER(t."description") LIKE '%fatura%'
  AND NOT EXISTS (
    SELECT 1
    FROM "Account" AS a
    WHERE a."id" = t."accountId"
      AND a."type" = 'credit_card'
  );
