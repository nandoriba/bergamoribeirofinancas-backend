UPDATE "InstallmentPlan"
SET "description" = BTRIM(REGEXP_REPLACE("description", '\s*[-–—]+\s*$', '', 'g'))
WHERE "description" ~ '\s*[-–—]+\s*$';

UPDATE "Transaction"
SET "description" = BTRIM(REGEXP_REPLACE("description", '\s*[-–—]+\s*[-–—]+\s*Parcela', ' - Parcela', 'gi'))
WHERE "description" ~ '\s*[-–—]+\s*[-–—]+\s*Parcela';
