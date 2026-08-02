import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260731010000_multi_tenant_identity_billing/migration.sql'),
  'utf8',
);

function tableDefinition(table: string): string {
  const match = migration.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`Tabela ${table} ausente na migration da fatia 3`);
  return match[1];
}

describe('migration multi-tenant, identity and billing contract', () => {
  it('renames the legacy role in place and leaves legacy users unverified', () => {
    expect(migration).toContain('ALTER TYPE "UserRole" RENAME TO "PlatformRole"');
    expect(migration).toContain('ALTER TYPE "PlatformRole" RENAME VALUE \'member\' TO \'user\'');
    expect(migration).toContain('ALTER TABLE "User" RENAME COLUMN "role" TO "platformRole"');
    expect(migration).not.toContain('DROP TYPE "UserRole"');
    expect(migration).not.toContain('DROP COLUMN "role"');
    expect(migration).not.toMatch(/UPDATE "User" SET "emailVerifiedAt"/);
  });

  it('fails closed before an ambiguous or inconsistent owner backfill', () => {
    expect(migration).toContain('FATIA3_OWNER_BACKFILL_AMBIGUOUS');
    expect(migration).toContain('FATIA3_USER_WITHOUT_PROFILE');
    expect(migration).toContain('FATIA3_PROFILE_FAMILY_MISMATCH');
    expect(migration).toContain('FATIA3_TENANT_REFERENCE_MISMATCH');
    expect(migration).toContain('FATIA3_MULTIPLE_ACTIVE_TELEGRAM_GROUPS');
    expect(migration).toContain('Family_owner_required_at_commit');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('enforces same-tenant relations without update cascades', () => {
    const expectedConstraints = [
      'Family_ownerUserId_id_fkey',
      'MemberProfile_userId_familyId_fkey',
      'MemberInvite_creatorUserId_familyId_fkey',
      'MemberApproval_inviteId_familyId_fkey',
      'MemberApproval_userId_familyId_fkey',
      'MemberApproval_reviewerUserId_familyId_fkey',
      'TelegramAuthorizedGroup_authorizedByUserId_familyId_fkey',
      'SubscriptionPayment_subscriptionId_familyId_fkey',
      'PaymentWebhookEvent_subscriptionId_familyId_fkey',
      'PaymentWebhookEvent_subscriptionPaymentId_familyId_fkey',
    ];

    for (const constraint of expectedConstraints) {
      const relation = migration.match(new RegExp(`ADD CONSTRAINT "${constraint}"[\\s\\S]*?;`));
      expect(relation?.[0], constraint).toContain('"familyId"');
      expect(relation?.[0], constraint).toContain('ON UPDATE RESTRICT');
    }
    expect(migration).toContain('MemberApproval_inviteId_familyId_fkey');
    expect(migration).toContain('SubscriptionPayment_subscriptionId_familyId_fkey');
    expect(migration).toContain('PaymentWebhookEvent_subscriptionPaymentId_familyId_fkey');
    expect(migration).toContain('TENANT_KEY_IS_IMMUTABLE');
    expect(migration).toContain('TENANT_KEY_BINDING_IS_IMMUTABLE');
    expect(migration).toContain('FAMILY_OWNER_IS_IMMUTABLE_IN_MVP');
    expect(migration).toContain('FAMILY_OWNER_CANNOT_BE_DEACTIVATED');
  });

  it('stores OAuth correlation secrets without provider credentials', () => {
    const oauthAttempt = tableDefinition('OAuthAttempt');

    expect(oauthAttempt).toContain('"stateHash" TEXT NOT NULL');
    expect(oauthAttempt).toContain('"nonceHash" TEXT NOT NULL');
    expect(oauthAttempt).toContain('"pkceVerifierCiphertext" TEXT NOT NULL');
    expect(oauthAttempt).not.toMatch(/authorizationCode|idToken|accessToken|refreshToken/i);
    expect(migration).toMatch(
      /OAuthAttempt_authenticatedUserId_fkey[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE;/,
    );
    expect(migration).toMatch(/OAuthAttempt_memberInviteId_fkey[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE;/);
    expect(migration).toContain(
      'CHECK (("intent" = \'link_account\') = ("authenticatedUserId" IS NOT NULL))',
    );
    expect(migration).toContain('CHECK (("intent" = \'accept_invite\') = ("memberInviteId" IS NOT NULL))');
  });

  it('keeps payment facts fail-closed and tenant-safe', () => {
    const subscription = tableDefinition('Subscription');
    const payment = tableDefinition('SubscriptionPayment');
    const webhook = tableDefinition('PaymentWebhookEvent');

    expect(subscription).toContain('"devMode" BOOLEAN NOT NULL');
    expect(subscription).not.toContain('"devMode" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(payment).toContain('"providerPaymentId" TEXT');
    expect(payment).not.toContain('"providerPaymentId" TEXT NOT NULL');
    expect(webhook).toContain('"familyId" TEXT');
    expect(webhook).not.toContain('"familyId" TEXT NOT NULL');
    expect(migration).toContain('SubscriptionPayment_provider_reference_check');
    expect(migration).toContain('PaymentWebhookEvent_subscription_tenant_check');
    expect(migration).toContain('PaymentWebhookEvent_payment_tenant_check');
    expect(migration).toContain('SubscriptionPayment_id_subscriptionId_familyId_key');
    expect(migration).toContain('PaymentWebhookEvent_signature_check');
    expect(migration).toContain('Subscription_one_open_per_family');
    expect(migration).toContain('Subscription_monotonic_facts');
    expect(migration).toContain('REVOKED_AT_IS_IMMUTABLE');
  });

  it('keeps the MVP billing vocabulary closed to monthly card subscriptions', () => {
    expect(migration).toContain("CREATE TYPE \"SubscriptionCycle\" AS ENUM ('MONTHLY')");
    expect(migration).toContain("CREATE TYPE \"SubscriptionPaymentMethod\" AS ENUM ('CARD')");
    expect(migration).toContain('TelegramAuthorizedGroup_one_active_per_family');
  });
});
