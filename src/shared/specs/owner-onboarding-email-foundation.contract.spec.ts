import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260801010000_owner_onboarding_email_foundation/migration.sql',
  ),
  'utf8',
);

describe('owner onboarding and email foundation migration contract', () => {
  it('grandfathers every legacy user and canonicalizes email only after collision preflight', () => {
    const collisionPreflight = migration.indexOf('USER_EMAIL_CANONICAL_COLLISION');
    const canonicalUpdate = migration.indexOf('SET "email" = lower(btrim("email"))');

    expect(migration).toContain('ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toMatch(
      /UPDATE "User"[\s\S]*?"emailVerifiedAt" = CURRENT_TIMESTAMP\s+WHERE "emailVerifiedAt" IS NULL/,
    );
    expect(migration).not.toMatch(/SET "emailVerifiedAt" = CURRENT_TIMESTAMP[\s\S]*?"isActive"/);
    expect(collisionPreflight).toBeGreaterThan(-1);
    expect(canonicalUpdate).toBeGreaterThan(collisionPreflight);
    expect(migration).toContain('User_email_canonical_check');
    expect(migration).toContain('User_auth_version_check');
  });

  it('binds owner names and legal facts exclusively to signup_owner OAuth attempts', () => {
    expect(migration).toContain('ADD COLUMN "signupOwnerName" TEXT');
    expect(migration).toContain('ADD COLUMN "signupFamilyName" TEXT');
    expect(migration).toMatch(
      /"intent" = 'signup_owner'[\s\S]*?"legalAcceptanceVersion" IS NOT NULL[\s\S]*?"legalAcceptedAt" IS NOT NULL[\s\S]*?"signupOwnerName" IS NOT NULL[\s\S]*?"signupFamilyName" IS NOT NULL/,
    );
    expect(migration).toMatch(
      /"intent" <> 'signup_owner'[\s\S]*?"legalAcceptanceVersion" IS NULL[\s\S]*?"legalAcceptedAt" IS NULL[\s\S]*?"signupOwnerName" IS NULL[\s\S]*?"signupFamilyName" IS NULL/,
    );
  });

  it('stores immutable, versioned legal acceptance with same-tenant foreign keys', () => {
    expect(migration).toContain(
      'CREATE TYPE "LegalAcceptanceSource" AS ENUM (\'local\', \'google\')',
    );
    expect(migration).toContain('LegalAcceptance_userId_familyId_fkey');
    expect(migration).toMatch(
      /LegalAcceptance_userId_familyId_fkey[\s\S]*?REFERENCES "User"\("id", "familyId"\)[\s\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT/,
    );
    expect(migration).toContain('LegalAcceptance_userId_bundleVersion_key');
    expect(migration).toContain('LegalAcceptance_append_only');
    expect(migration).toContain('LEGAL_ACCEPTANCE_IS_APPEND_ONLY');
  });

  it('keeps one encrypted outbox delivery per action token and enforces terminal states', () => {
    expect(migration).toContain(
      'CREATE TYPE "EmailOutboxStatus" AS ENUM (\'pending\', \'processing\', \'sent\', \'discarded\')',
    );
    expect(migration).toContain('EmailOutbox_userActionTokenId_key');
    expect(migration).toContain('"payloadCiphertext" TEXT');
    expect(migration).toContain('"payloadKeyVersion" TEXT NOT NULL');
    expect(migration).not.toMatch(/plaintext|verificationCode|resetToken/i);
    expect(migration).toContain('EmailOutbox_state_check');
    expect(migration).toContain('EmailOutbox_state_transition');
    expect(migration).toContain('EMAIL_OUTBOX_TERMINAL_STATE_IS_IMMUTABLE');
  });

  it('persists generic password-reset requests with recoverable leases and ciphertext cleanup', () => {
    expect(migration).toContain(
      'CREATE TYPE "PasswordResetRequestStatus" AS ENUM (\'pending\', \'processing\', \'completed\', \'discarded\')',
    );
    expect(migration).toContain('CREATE TABLE "PasswordResetRequest"');
    expect(migration).toContain('"emailCiphertext" TEXT');
    expect(migration).toContain('PasswordResetRequest_status_nextAttemptAt_idx');
    expect(migration).toContain('PasswordResetRequest_lockedAt_idx');
    expect(migration).toContain('PasswordResetRequest_state_check');
    expect(migration).toContain('PasswordResetRequest_state_transition');
    expect(migration).toContain('PASSWORD_RESET_REQUEST_TERMINAL_STATE_IS_IMMUTABLE');
    expect(migration).toMatch(
      /"status" = 'completed'[\s\S]*?"emailCiphertext" IS NULL[\s\S]*?"completedAt" IS NOT NULL/,
    );
    expect(migration).toMatch(
      /"status" = 'discarded'[\s\S]*?"emailCiphertext" IS NULL[\s\S]*?"discardedAt" IS NOT NULL/,
    );
  });
});
