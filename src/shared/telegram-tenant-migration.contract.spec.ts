import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260801050000_telegram_tenant_access/migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

describe('contrato de tenant do Telegram', () => {
  it('faz backfill fail-closed antes de tornar familyId obrigatório', () => {
    expect(migration).toContain('FATIA11_TELEGRAM_LINK_WITHOUT_AUTHORIZED_GROUP');
    expect(migration).toContain('FATIA11_CROSS_TENANT_TELEGRAM_LINK');
    expect(migration.indexOf('FATIA11_CROSS_TENANT_TELEGRAM_LINK')).toBeLessThan(
      migration.indexOf('ALTER COLUMN "familyId" SET NOT NULL'),
    );
  });

  it('amarra cada vínculo ao grupo e ao perfil da mesma família', () => {
    expect(migration).toContain('TelegramUserLink_memberProfileId_familyId_fkey');
    expect(migration).toContain('TelegramUserLink_chatId_familyId_fkey');
    expect(migration).toContain('REFERENCES "MemberProfile"("id", "familyId")');
    expect(migration).toContain('REFERENCES "TelegramAuthorizedGroup"("chatId", "familyId")');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(migration).toContain('TelegramUserLink_familyId_immutable');
    expect(migration).toContain('TelegramUserLink_active_profile_chat_key');
    expect(migration).toMatch(
      /ON "TelegramUserLink"\("memberProfileId", "chatId"\)\s+WHERE "revokedAt" IS NULL/,
    );
    expect(migration.indexOf('ranked_active_links')).toBeLessThan(
      migration.indexOf('TelegramUserLink_active_profile_chat_key'),
    );
  });

  it('mantém chat globalmente único e apenas um grupo ativo por família', () => {
    expect(schema).toMatch(/chatId\s+String\s+@unique/);
    expect(schema).toContain('@@unique([chatId, familyId])');

    const originalMigration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20260731010000_multi_tenant_identity_billing/migration.sql'),
      'utf8',
    );
    expect(originalMigration).toContain('TelegramAuthorizedGroup_one_active_per_family');
    expect(originalMigration).toMatch(
      /ON "TelegramAuthorizedGroup"\("familyId"\)\s+WHERE "revokedAt" IS NULL/,
    );
  });
});
