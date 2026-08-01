import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260801030000_webhook_paywall_retention/migration.sql",
  ),
  "utf8",
);

describe("migration webhook, paywall e retenção", () => {
  it("aborta ambiguidade e cria um ponteiro corrente tenant-safe e determinístico", () => {
    expect(migration).toContain("FATIA8_MULTIPLE_CURRENT_SUBSCRIPTIONS");
    expect(migration).toContain('"currentSubscriptionId" TEXT');
    expect(migration).toContain("Family_currentSubscriptionId_id_fkey");
    expect(migration).toMatch(
      /REFERENCES "Subscription"\("id", "familyId"\)[\s\S]*?ON DELETE RESTRICT[\s\S]*?ON UPDATE RESTRICT/,
    );
    expect(migration).toMatch(
      /ORDER BY[\s\S]*?"cancelledAt" IS NULL[\s\S]*?"checkoutClosedAt" IS NULL[\s\S]*?"createdAt" DESC[\s\S]*?"id" DESC/,
    );
  });

  it("mantém entitlement versionado e a identidade do provider imutável", () => {
    expect(migration).toContain("Subscription_entitlement_contract_check");
    expect(migration).toContain(
      '"accessPaidThrough" IS NULL OR "entitlementContractVersion" IS NOT NULL',
    );
    expect(migration).toContain(
      "Subscription_providerSubscriptionId_immutable",
    );
    expect(migration).toContain("PROVIDER_SUBSCRIPTION_ID_IS_IMMUTABLE");
    expect(migration).toContain("Subscription_cancel_claim_check");
  });

  it("fecha o contrato de webhook em API v2 e correlaciona checkout sem PII obrigatório", () => {
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'quarantined'");
    expect(migration).toContain("PaymentWebhookEvent_api_version_check");
    expect(migration).toContain('"apiVersion" IS NULL OR "apiVersion" = 2');
    expect(migration).toContain(
      "PaymentWebhookEvent_provider_providerCheckoutId_idx",
    );
    expect(migration).toContain("SubscriptionPayment_providerCheckoutId_key");
  });

  it("audita retenção, impede duas execuções e exige estados terminais coerentes", () => {
    expect(migration).toContain('CREATE TABLE "TenantPurgeRun"');
    expect(migration).toContain("TenantPurgeRun_terminal_check");
    expect(migration).toContain("TenantPurgeRun_counts_check");
    expect(migration).toContain("TenantPurgeRun_single_running_key");
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "TenantPurgeRun_single_running_key"[\s\S]*?WHERE "status" = 'running'/,
    );
  });
});
