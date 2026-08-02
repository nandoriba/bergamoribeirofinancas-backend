import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260801040000_member_invites_management/migration.sql',
  ),
  'utf8',
);

describe('contrato persistente da gestão de membros e convites', () => {
  it('impede mais de uma aprovação para o mesmo convite com preflight explícito', () => {
    expect(schema).toMatch(/inviteId\s+String\s+@unique/);
    const preflight = migration.indexOf('FATIA9_DUPLICATE_MEMBER_APPROVAL_INVITE');
    const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX "MemberApproval_inviteId_key"');
    expect(preflight).toBeGreaterThan(-1);
    expect(uniqueIndex).toBeGreaterThan(preflight);
  });

  it('persiste o nome no OAuth de convite e invalida tentativas legadas antes da constraint', () => {
    expect(schema).toMatch(/inviteDisplayName\s+String\?/);
    const cleanup = migration.indexOf(`DELETE FROM "OAuthAttempt"`);
    const constraint = migration.lastIndexOf('ADD CONSTRAINT "OAuthAttempt_accept_invite_check"');
    expect(cleanup).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(cleanup);
    expect(migration).toContain('char_length(btrim("inviteDisplayName")) BETWEEN 2 AND 80');
  });

  it('mantém índice indexável para quota persistente por destinatário', () => {
    expect(schema).toMatch(
      /@@index\(\[purpose, deliveryEmail, createdAt\]\)/,
    );
    expect(migration).toContain(
      'CREATE INDEX "UserActionToken_purpose_deliveryEmail_createdAt_idx"',
    );
    expect(migration).toContain(
      'ON "UserActionToken"("purpose", "deliveryEmail", "createdAt")',
    );
  });
});
