import {
  OAuthIntent,
  PlatformRole,
  PrismaClient,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface TenantFixture {
  familyId: string;
  userId: string;
  profileId: string;
  email: string;
}

interface FixtureIds {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
  activeProfileA: string;
  inactiveProfileA: string;
  pendingProfileA: string;
  accountA: string;
  cardA: string;
  activeAccountA: string;
  activeCardA: string;
  accountB: string;
  cardB: string;
  categoryB: string;
  transactionB: string;
  activeTransactionA: string;
  activeNestedTransactionA: string;
  invoiceB: string;
  activeInvoiceA: string;
  recurringB: string;
  activeRecurringA: string;
  installmentB: string;
  activeInstallmentA: string;
  importBatchB: string;
  activeImportBatchA: string;
  importRowB: string;
  inconsistentTransactionA: string;
}

describe("isolamento PostgreSQL com dois tenants", () => {
  let prisma: PrismaClient;
  let baseUrl: string;
  let fixture: FixtureIds;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    if (process.env.RUN_TENANT_INTEGRATION !== "true") {
      throw new Error(
        "Execute este arquivo somente por npm run test:integration",
      );
    }

    prisma = new PrismaClient();
    fixture = await createFixtures(prisma);
    baseUrl = process.env.TEST_API_URL ?? "";
    if (!baseUrl) throw new Error("TEST_API_URL ausente");

    cookieA = await login(baseUrl, fixture.tenantA.email);
    cookieB = await login(baseUrl, fixture.tenantB.email);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("mantém leituras familiares dentro do tenant e preserva histórico inativo", async () => {
    const accounts = itemsOf(await getJson(baseUrl, cookieA, "/accounts"));
    expect(accounts.map(readId)).toContain(fixture.accountA);
    expect(accounts.map(readId)).toContain(fixture.activeAccountA);
    expect(accounts.map(readMemberProfileId)).toContain(
      fixture.inactiveProfileA,
    );
    expect(accounts.map(readId)).not.toContain(fixture.accountB);

    const categories = itemsOf(await getJson(baseUrl, cookieA, "/categories"));
    expect(categories.map(readId)).not.toContain(fixture.categoryB);

    const transactions = itemsOf(
      await getJson(
        baseUrl,
        cookieA,
        "/transactions?referenceMonth=2026-07&limit=100",
      ),
    );
    const descriptions = transactions.map((item) =>
      readString(item, "description"),
    );
    expect(descriptions).toContain("Receita owner A");
    expect(descriptions).toContain("Histórico inativo A");
    expect(descriptions).not.toContain("Receita owner B");
    expect(descriptions).not.toContain("Relações inconsistentes");

    const invoices = itemsOf(
      await getJson(baseUrl, cookieA, "/invoices?limit=50"),
    );
    expect(invoices.map(readId)).toContain(fixture.activeInvoiceA);
    expect(invoices.map(readId)).not.toContain(fixture.invoiceB);

    const recurring = itemsOf(await getJson(baseUrl, cookieA, "/recurring"));
    expect(recurring.map(readId)).toContain(fixture.activeRecurringA);
    expect(recurring.map(readId)).not.toContain(fixture.recurringB);

    const installments = await getJson(
      baseUrl,
      cookieA,
      "/installments?limit=50",
    );
    expect(itemsOf(installments).map(readId)).not.toContain(
      fixture.installmentB,
    );
    expect(itemsOf(installments).map(readId)).toContain(
      fixture.activeInstallmentA,
    );

    const batches = itemsOf(
      await getJson(baseUrl, cookieA, "/imports/batches?limit=50"),
    );
    expect(batches.map(readId)).not.toContain(fixture.activeImportBatchA);
    expect(batches.map(readId)).not.toContain(fixture.importBatchB);

    const profiles = itemsOf(await getJson(baseUrl, cookieA, "/profiles"));
    expect(profiles.map(readId)).toContain(fixture.activeProfileA);
    expect(profiles.map(readId)).toContain(fixture.inactiveProfileA);
    expect(profiles.map(readId)).not.toContain(fixture.pendingProfileA);
  });

  it("filtra todas as visões financeiras por um perfil ativo da própria família", async () => {
    const profileId = fixture.activeProfileA;
    const accounts = itemsOf(
      await getJson(baseUrl, cookieA, `/accounts?profileId=${profileId}`),
    );
    expect(accounts.map(readId)).toContain(fixture.activeAccountA);
    expect(accounts.every((item) => readMemberProfileId(item) === profileId)).toBe(true);

    const transactions = itemsOf(
      await getJson(
        baseUrl,
        cookieA,
        `/transactions?referenceMonth=2026-07&limit=100&profileId=${profileId}`,
      ),
    );
    expect(transactions.map(readId)).toEqual(
      expect.arrayContaining([fixture.activeTransactionA, fixture.activeNestedTransactionA]),
    );
    expect(transactions.every((item) => readMemberProfileId(item) === profileId)).toBe(true);

    const invoices = itemsOf(
      await getJson(baseUrl, cookieA, `/invoices?limit=50&profileId=${profileId}`),
    );
    expect(invoices.map(readId)).toEqual([fixture.activeInvoiceA]);
    const invoiceTransactions = itemsOf(invoices[0].transactions);
    expect(invoiceTransactions.map(readId)).toContain(fixture.activeNestedTransactionA);
    expect(invoiceTransactions.every((item) => readMemberProfileId(item) === profileId)).toBe(true);
    const invoiceInstallment = asRecord(
      invoiceTransactions.find((item) => readId(item) === fixture.activeNestedTransactionA)?.installmentPlan,
    );
    expect(itemsOf(invoiceInstallment.transactions).every((item) => readMemberProfileId(item) === profileId)).toBe(true);

    const recurring = itemsOf(
      await getJson(baseUrl, cookieA, `/recurring?profileId=${profileId}`),
    );
    expect(recurring.map(readId)).toEqual([fixture.activeRecurringA]);

    const installments = asRecord(
      await getJson(baseUrl, cookieA, `/installments?limit=50&profileId=${profileId}`),
    );
    const installmentItems = itemsOf(installments);
    expect(installmentItems.map(readId)).toEqual([fixture.activeInstallmentA]);
    expect(itemsOf(installmentItems[0].transactions).map(readId)).toContain(fixture.activeNestedTransactionA);
    expect(
      itemsOf(installmentItems[0].transactions).every((item) => readMemberProfileId(item) === profileId),
    ).toBe(true);
    expect(asRecord(installments.summary)).toMatchObject({
      totalPurchaseCents: 14_000,
      totalInstallments: 2,
      totalAmountToPayCents: 7_000,
    });

    const dashboard = asRecord(
      await getJson(baseUrl, cookieA, `/dashboard?referenceMonth=2026-07&profileId=${profileId}`),
    );
    expect(itemsOf(dashboard.transactions).map(readId)).toEqual(
      expect.arrayContaining([fixture.activeTransactionA, fixture.activeNestedTransactionA]),
    );

    const report = asRecord(
      await getJson(baseUrl, cookieA, `/reports/monthly?month=2026-07&profileId=${profileId}`),
    );
    expect(itemsOf(report.profiles).map(readId)).toEqual([profileId]);
    expect(asRecord(report.totals)).toMatchObject({ incomeCents: 40_000, expenseCents: 7_000, netCents: 33_000 });
  });

  it("permite consultar o histórico de um perfil inativo da própria família", async () => {
    const profileId = fixture.inactiveProfileA;
    const accounts = itemsOf(await getJson(baseUrl, cookieA, `/accounts?profileId=${profileId}`));
    expect(accounts.map(readMemberProfileId)).toEqual([profileId]);

    const transactions = itemsOf(
      await getJson(
        baseUrl,
        cookieA,
        `/transactions?referenceMonth=2026-07&limit=100&profileId=${profileId}`,
      ),
    );
    expect(transactions.map((item) => readString(item, "description"))).toEqual(["Histórico inativo A"]);

    const report = asRecord(
      await getJson(baseUrl, cookieA, `/reports/monthly?month=2026-07&profileId=${profileId}`),
    );
    expect(itemsOf(report.profiles).map(readId)).toEqual([profileId]);
  });

  it("rejeita perfis pendentes, desconhecidos ou de outra família antes das leituras", async () => {
    const endpoints = [
      "/accounts",
      "/transactions?referenceMonth=2026-07&limit=100",
      "/invoices?limit=50",
      "/recurring",
      "/installments?limit=50",
      "/dashboard?referenceMonth=2026-07",
      "/reports/monthly?month=2026-07",
    ];
    const rejectedProfileIds = [fixture.pendingProfileA, fixture.tenantB.profileId, randomUUID()];

    for (const endpoint of endpoints) {
      const separator = endpoint.includes("?") ? "&" : "?";
      for (const profileId of rejectedProfileIds) {
        await expectStatus(baseUrl, cookieA, `${endpoint}${separator}profileId=${profileId}`, 400);
      }
    }

    await expectStatus(
      baseUrl,
      cookieB,
      `/accounts?profileId=${fixture.activeProfileA}`,
      400,
    );
  });

  it("rejeita profileId forjado em mutações e sempre grava no perfil autor", async () => {
    const forgedProfileIds = [fixture.activeProfileA, fixture.tenantB.profileId];
    for (const profileId of forgedProfileIds) {
      await expectStatus(baseUrl, cookieA, "/accounts", 400, {
        method: "POST",
        body: { name: "Conta forjada", type: "checking", profileId },
      });
      await expectStatus(baseUrl, cookieA, "/transactions", 400, {
        method: "POST",
        body: {
          applicationDate: "2026-07-22",
          referenceMonth: "2026-07-01",
          description: "Lançamento forjado",
          amountCents: 1234,
          type: "expense",
          profileId,
        },
      });
    }

    const createdAccount = await postJson(baseUrl, cookieA, "/accounts", {
      name: `Conta válida ${randomUUID()}`,
      type: "checking",
    });
    expect(readMemberProfileId(createdAccount)).toBe(fixture.tenantA.profileId);

    const createdTransaction = await postJson(baseUrl, cookieA, "/transactions", {
      applicationDate: "2026-09-22",
      referenceMonth: "2026-09-01",
      description: `Lançamento válido ${randomUUID()}`,
      amountCents: 1234,
      type: "expense",
    });
    expect(readMemberProfileId(createdTransaction)).toBe(fixture.tenantA.profileId);

    await expect(
      prisma.account.findUnique({ where: { id: readId(createdAccount) }, select: { memberProfileId: true } }),
    ).resolves.toEqual({ memberProfileId: fixture.tenantA.profileId });
    await expect(
      prisma.transaction.findUnique({
        where: { id: readId(createdTransaction) },
        select: { memberProfileId: true },
      }),
    ).resolves.toEqual({ memberProfileId: fixture.tenantA.profileId });
  });

  it("mantém dashboard e relatório fail-closed diante de relações financeiras inconsistentes", async () => {
    const dashboard = asRecord(
      await getJson(
        baseUrl,
        cookieA,
        "/dashboard?referenceMonth=2026-07&family=true",
      ),
    );
    const dashboardTransactions = itemsOf(dashboard.transactions);
    expect(
      dashboardTransactions.map((item) => readString(item, "description")),
    ).not.toContain("Relações inconsistentes");

    const report = asRecord(
      await getJson(
        baseUrl,
        cookieA,
        "/reports/monthly?month=2026-07&family=true",
      ),
    );
    const reportProfiles = itemsOf(report.profiles);
    expect(reportProfiles.map(readId)).not.toContain(fixture.tenantB.profileId);
    const totals = asRecord(report.totals);
    expect(readNumber(totals, "incomeCents")).toBe(70_000);
    expect(readNumber(totals, "expenseCents")).toBe(7_000);
    expect(
      itemsOf(report.accounts).map((item) => readString(item, "name")),
    ).not.toContain("Cartão B");
    expect(
      itemsOf(report.categories).map((item) => readString(item, "name")),
    ).not.toContain("Categoria B");
  });

  it("não permite atualizar nem excluir recursos financeiros de outro tenant", async () => {
    const mutations: Array<[string, Record<string, unknown>]> = [
      [`/accounts/${fixture.accountB}`, { name: "Tentativa externa" }],
      [`/categories/${fixture.categoryB}`, { name: "Tentativa externa" }],
      [
        `/transactions/${fixture.transactionB}`,
        { description: "Tentativa externa" },
      ],
      [`/invoices/${fixture.invoiceB}`, { status: "closed" }],
      [
        `/recurring/${fixture.recurringB}`,
        { description: "Tentativa externa" },
      ],
      [
        `/installments/${fixture.installmentB}`,
        { description: "Tentativa externa" },
      ],
    ];

    for (const [path, body] of mutations) {
      await expectStatus(baseUrl, cookieA, path, 404, {
        method: "PATCH",
        body,
      });
      await expectStatus(baseUrl, cookieA, path, 404, { method: "DELETE" });
    }

    await expectStatus(
      baseUrl,
      cookieA,
      `/transactions/${fixture.inconsistentTransactionA}`,
      404,
      {
        method: "PATCH",
        body: { description: "Tentativa em relação inconsistente" },
      },
    );
    await expectStatus(
      baseUrl,
      cookieA,
      `/transactions/${fixture.inconsistentTransactionA}`,
      404,
      {
        method: "DELETE",
      },
    );

    await expectStatus(baseUrl, cookieA, "/imports/confirm", 404, {
      method: "POST",
      body: { batchId: fixture.importBatchB, rowIds: [fixture.importRowB] },
    });
    await expectStatus(baseUrl, cookieA, "/imports/discard", 404, {
      method: "POST",
      body: { batchId: fixture.importBatchB },
    });
  });

  it("rejeita conta, categoria e fatura estrangeiras em uma nova mutação do autor", async () => {
    const baseTransaction = {
      applicationDate: "2026-07-20",
      referenceMonth: "2026-07-01",
      description: "Tentativa com relação externa",
      amountCents: 1000,
      type: "expense",
    };

    await expectStatus(baseUrl, cookieA, "/transactions", 400, {
      method: "POST",
      body: { ...baseTransaction, accountId: fixture.accountB },
    });
    await expectStatus(baseUrl, cookieA, "/transactions", 400, {
      method: "POST",
      body: { ...baseTransaction, categoryId: fixture.categoryB },
    });
    await expectStatus(baseUrl, cookieA, "/transactions", 400, {
      method: "POST",
      body: {
        ...baseTransaction,
        accountId: fixture.cardA,
        invoiceId: fixture.invoiceB,
      },
    });
  });

  it("não concede bypass financeiro ao admin de plataforma", async () => {
    const accounts = itemsOf(await getJson(baseUrl, cookieB, "/accounts"));
    expect(accounts.map(readId)).toContain(fixture.accountB);
    expect(accounts.map(readId)).not.toContain(fixture.accountA);

    const transactions = itemsOf(
      await getJson(
        baseUrl,
        cookieB,
        "/transactions?referenceMonth=2026-07&limit=100",
      ),
    );
    expect(transactions.map(readMemberProfileId)).not.toContain(
      fixture.tenantA.profileId,
    );
  });

  it("confirma batches idênticos sem externalId concorrentemente sem duplicar lançamento", async () => {
    const description = `Importação concorrente ${randomUUID()}`;
    const applicationDate = new Date("2026-08-01T00:00:00.000Z");
    const amountCents = 54_321;
    const batches = await Promise.all(
      [1, 2].map((sequence) =>
        prisma.importBatch.create({
          data: {
            id: randomUUID(),
            fileName: `concorrente-${sequence}.csv`,
            type: "nubank_account",
            status: "preview",
            memberProfileId: fixture.tenantA.profileId,
            rows: {
              create: {
                id: randomUUID(),
                rowIndex: 1,
                raw: { sequence },
                date: applicationDate,
                description,
                amountCents,
                status: "new",
              },
            },
          },
        }),
      ),
    );

    const confirmations = await Promise.all(
      batches.map((batch) =>
        postJson(baseUrl, cookieA, "/imports/confirm", { batchId: batch.id }),
      ),
    );

    expect(
      confirmations.reduce(
        (sum, confirmation) => sum + readNumber(confirmation, "imported"),
        0,
      ),
    ).toBe(1);
    await expect(
      prisma.transaction.count({
        where: {
          memberProfileId: fixture.tenantA.profileId,
          applicationDate,
          description,
          amountCents,
        },
      }),
    ).resolves.toBe(1);
  });

  it("rejeita mês inválido antes de materializar recorrências", async () => {
    await expectStatus(baseUrl, cookieA, "/recurring/generate?month=abc", 400, {
      method: "POST",
    });
  });

  it("consome uma tentativa OAuth exatamente uma vez sob callbacks concorrentes", async () => {
    const attempt = await prisma.oAuthAttempt.create({
      data: {
        stateHash: `state-${randomUUID()}`,
        nonceHash: `nonce-${randomUUID()}`,
        browserBindingHash: `browser-${randomUUID()}`,
        pkceVerifierCiphertext: "oa1.integration.iv.ciphertext.tag",
        pkceVerifierKeyVersion: "v1",
        intent: OAuthIntent.login,
        returnPath: "/",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        prisma.oAuthAttempt.updateMany({
          where: {
            id: attempt.id,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { consumedAt: new Date() },
        }),
      ),
    );

    expect(claims.reduce((total, claim) => total + claim.count, 0)).toBe(1);
  });

  it("impede que o mesmo Google subject atravesse usuários ou famílias", async () => {
    const providerSubject = `google-${randomUUID()}`;
    await prisma.userIdentity.create({
      data: {
        provider: "google",
        providerSubject,
        observedEmail: "tenant-a-google@example.test",
        userId: fixture.tenantA.userId,
      },
    });

    await expect(
      prisma.userIdentity.create({
        data: {
          provider: "google",
          providerSubject,
          observedEmail: "tenant-b-google@example.test",
          userId: fixture.tenantB.userId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.userIdentity.create({
        data: {
          provider: "google",
          providerSubject: `another-${providerSubject}`,
          observedEmail: "tenant-a-second@example.test",
          userId: fixture.tenantA.userId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejeita login local iniciado por uma origem externa", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        email: fixture.tenantA.email,
        password: "integration-password",
      }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

async function createFixtures(prisma: PrismaClient): Promise<FixtureIds> {
  const passwordHash = await bcrypt.hash("integration-password", 4);
  const tenantA = await createTenant(
    prisma,
    "tenant-a@example.test",
    "Família A",
    PlatformRole.user,
    passwordHash,
  );
  const tenantB = await createTenant(
    prisma,
    "tenant-b@example.test",
    "Família B",
    PlatformRole.admin,
    passwordHash,
  );

  const inactive = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: "inactive-a@example.test",
        passwordHash,
        name: "Histórico A",
        familyId: tenantA.familyId,
        isActive: false,
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: "Histórico A",
        familyId: tenantA.familyId,
        userId: user.id,
        status: "inactive",
      },
    });
    return { user, profile };
  });

  const activeMember = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: "active-a2@example.test",
        passwordHash,
        name: "Membro ativo A2",
        familyId: tenantA.familyId,
        emailVerifiedAt: new Date(),
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: "Membro ativo A2",
        familyId: tenantA.familyId,
        userId: user.id,
        status: "active",
      },
    });
    return { user, profile };
  });

  const pendingMember = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `pending-${randomUUID()}@invite.invalid`,
        passwordHash,
        name: "Membro pendente A",
        familyId: tenantA.familyId,
        isActive: false,
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: "Membro pendente A",
        familyId: tenantA.familyId,
        userId: user.id,
        status: "pending",
      },
    });
    return { user, profile };
  });

  const [accountA, cardA, activeAccountA, activeCardA, inactiveAccountA, accountB, cardB] =
    await Promise.all([
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Conta A",
          type: "checking",
          memberProfileId: tenantA.profileId,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Cartão A",
          type: "credit_card",
          closingDay: 20,
          dueDay: 28,
          memberProfileId: tenantA.profileId,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Conta A2",
          type: "checking",
          memberProfileId: activeMember.profile.id,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Cartão A2",
          type: "credit_card",
          closingDay: 20,
          dueDay: 28,
          memberProfileId: activeMember.profile.id,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Conta histórica A",
          type: "checking",
          memberProfileId: inactive.profile.id,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Conta B",
          type: "checking",
          memberProfileId: tenantB.profileId,
        },
      }),
      prisma.account.create({
        data: {
          id: randomUUID(),
          name: "Cartão B",
          type: "credit_card",
          closingDay: 20,
          dueDay: 28,
          memberProfileId: tenantB.profileId,
        },
      }),
    ]);
  const [categoryA, categoryB] = await Promise.all([
    prisma.category.create({
      data: {
        id: randomUUID(),
        name: "Categoria A",
        type: "income",
        color: "#111111",
        familyId: tenantA.familyId,
      },
    }),
    prisma.category.create({
      data: {
        id: randomUUID(),
        name: "Categoria B",
        type: "income",
        color: "#222222",
        familyId: tenantB.familyId,
      },
    }),
  ]);
  const referenceMonth = new Date("2026-07-01T00:00:00.000Z");
  const [, activeInvoiceA, invoiceB] = await Promise.all([
    prisma.invoice.create({
      data: {
        id: randomUUID(),
        accountId: cardA.id,
        memberProfileId: tenantA.profileId,
        referenceMonth,
      },
    }),
    prisma.invoice.create({
      data: {
        id: randomUUID(),
        accountId: activeCardA.id,
        memberProfileId: activeMember.profile.id,
        referenceMonth,
      },
    }),
    prisma.invoice.create({
      data: {
        id: randomUUID(),
        accountId: cardB.id,
        memberProfileId: tenantB.profileId,
        referenceMonth,
      },
    }),
  ]);
  const [, activeRecurringA, recurringB] = await Promise.all([
    prisma.recurringTemplate.create({
      data: {
        id: randomUUID(),
        description: "Recorrência A",
        amountCents: 1000,
        type: "expense",
        dayOfMonth: 5,
        startsAt: referenceMonth,
        accountId: accountA.id,
        memberProfileId: tenantA.profileId,
      },
    }),
    prisma.recurringTemplate.create({
      data: {
        id: randomUUID(),
        description: "Recorrência A2",
        amountCents: 1500,
        type: "expense",
        dayOfMonth: 6,
        startsAt: referenceMonth,
        accountId: activeAccountA.id,
        memberProfileId: activeMember.profile.id,
      },
    }),
    prisma.recurringTemplate.create({
      data: {
        id: randomUUID(),
        description: "Recorrência B",
        amountCents: 2000,
        type: "expense",
        dayOfMonth: 5,
        startsAt: referenceMonth,
        accountId: accountB.id,
        memberProfileId: tenantB.profileId,
      },
    }),
  ]);
  const [, activeInstallmentA, installmentB] = await Promise.all([
    prisma.installmentPlan.create({
      data: {
        id: randomUUID(),
        description: "Parcelamento A",
        totalInstallments: 2,
        firstReferenceMonth: referenceMonth,
        monthlyAmountCents: 5000,
        totalAmountCents: 10000,
        startsAt: referenceMonth,
        memberProfileId: tenantA.profileId,
      },
    }),
    prisma.installmentPlan.create({
      data: {
        id: randomUUID(),
        description: "Parcelamento A2",
        totalInstallments: 2,
        paidInstallments: 1,
        firstReferenceMonth: referenceMonth,
        monthlyAmountCents: 7000,
        totalAmountCents: 14000,
        startsAt: referenceMonth,
        memberProfileId: activeMember.profile.id,
      },
    }),
    prisma.installmentPlan.create({
      data: {
        id: randomUUID(),
        description: "Parcelamento B",
        totalInstallments: 2,
        firstReferenceMonth: referenceMonth,
        monthlyAmountCents: 6000,
        totalAmountCents: 12000,
        startsAt: referenceMonth,
        memberProfileId: tenantB.profileId,
      },
    }),
  ]);
  const [, activeImportA, importB] = await Promise.all([
    prisma.importBatch.create({
      data: {
        id: randomUUID(),
        fileName: "a.csv",
        type: "nubank_account",
        memberProfileId: tenantA.profileId,
        rows: {
          create: {
            id: randomUUID(),
            rowIndex: 1,
            raw: {},
            status: "new",
            description: "Import A",
            amountCents: 1000,
            date: referenceMonth,
          },
        },
      },
      include: { rows: true },
    }),
    prisma.importBatch.create({
      data: {
        id: randomUUID(),
        fileName: "a2.csv",
        type: "nubank_account",
        memberProfileId: activeMember.profile.id,
        rows: {
          create: {
            id: randomUUID(),
            rowIndex: 1,
            raw: {},
            status: "new",
            description: "Import A2",
            amountCents: 1500,
            date: referenceMonth,
          },
        },
      },
      include: { rows: true },
    }),
    prisma.importBatch.create({
      data: {
        id: randomUUID(),
        fileName: "b.csv",
        type: "nubank_account",
        memberProfileId: tenantB.profileId,
        rows: {
          create: {
            id: randomUUID(),
            rowIndex: 1,
            raw: {},
            status: "new",
            description: "Import B",
            amountCents: 1000,
            date: referenceMonth,
          },
        },
      },
      include: { rows: true },
    }),
  ]);
  const [, , activeTransactionA, activeNestedTransactionA, transactionB] = await Promise.all([
    createTransaction(
      prisma,
      tenantA.profileId,
      accountA.id,
      categoryA.id,
      "Receita owner A",
      10000,
    ),
    createTransaction(
      prisma,
      inactive.profile.id,
      inactiveAccountA.id,
      categoryA.id,
      "Histórico inativo A",
      20000,
    ),
    createTransaction(
      prisma,
      activeMember.profile.id,
      activeAccountA.id,
      categoryA.id,
      "Receita membro A2",
      40000,
    ),
    prisma.transaction.create({
      data: {
        id: randomUUID(),
        date: referenceMonth,
        applicationDate: new Date("2026-07-12T00:00:00.000Z"),
        referenceMonth,
        description: "Parcela A2 na fatura",
        amountCents: 7000,
        type: "expense",
        status: "confirmed",
        memberProfileId: activeMember.profile.id,
        accountId: activeCardA.id,
        invoiceId: activeInvoiceA.id,
        installmentPlanId: activeInstallmentA.id,
        installmentNumber: 1,
      },
    }),
    createTransaction(
      prisma,
      tenantB.profileId,
      accountB.id,
      categoryB.id,
      "Receita owner B",
      30000,
    ),
  ]);
  const inconsistentTransaction = await prisma.transaction.create({
    data: {
      id: randomUUID(),
      date: referenceMonth,
      applicationDate: new Date("2026-07-15T00:00:00.000Z"),
      referenceMonth,
      description: "Relações inconsistentes",
      amountCents: 999999,
      type: "expense",
      status: "confirmed",
      memberProfileId: tenantA.profileId,
      accountId: cardB.id,
      categoryId: categoryB.id,
      invoiceId: invoiceB.id,
      recurringTemplateId: recurringB.id,
      installmentPlanId: installmentB.id,
      installmentNumber: 1,
    },
  });

  return {
    tenantA,
    tenantB,
    activeProfileA: activeMember.profile.id,
    inactiveProfileA: inactive.profile.id,
    pendingProfileA: pendingMember.profile.id,
    accountA: accountA.id,
    cardA: cardA.id,
    activeAccountA: activeAccountA.id,
    activeCardA: activeCardA.id,
    accountB: accountB.id,
    cardB: cardB.id,
    categoryB: categoryB.id,
    transactionB: transactionB.id,
    activeTransactionA: activeTransactionA.id,
    activeNestedTransactionA: activeNestedTransactionA.id,
    invoiceB: invoiceB.id,
    activeInvoiceA: activeInvoiceA.id,
    recurringB: recurringB.id,
    activeRecurringA: activeRecurringA.id,
    installmentB: installmentB.id,
    activeInstallmentA: activeInstallmentA.id,
    importBatchB: importB.id,
    activeImportBatchA: activeImportA.id,
    importRowB: importB.rows[0].id,
    inconsistentTransactionA: inconsistentTransaction.id,
  };
}

async function createTenant(
  prisma: PrismaClient,
  email: string,
  familyName: string,
  platformRole: PlatformRole,
  passwordHash: string,
): Promise<TenantFixture> {
  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: { id: randomUUID(), name: familyName },
    });
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email,
        passwordHash,
        name: familyName,
        platformRole,
        familyId: family.id,
        emailVerifiedAt: new Date(),
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: familyName,
        userId: user.id,
        familyId: family.id,
      },
    });
    const paidAt = new Date(Date.now() - 60_000);
    const subscription = await tx.subscription.create({
      data: {
        familyId: family.id,
        externalId: `integration_${randomUUID()}`,
        providerSubscriptionId: `subs_${randomUUID()}`,
        providerProductId: "prod_integration_monthly",
        providerStatus: "ACTIVE",
        lastProviderEvent: "subscription.renewed",
        providerUpdatedAt: new Date(paidAt.getTime() + 1_000),
        lastSuccessfulPaymentAt: paidAt,
        accessPaidThrough: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000),
        lastInstallmentNumber: 2,
        entitlementContractVersion: "integration-contract-v1",
        amountCents: 2_990,
        paymentMethod: SubscriptionPaymentMethod.CARD,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: { ownerUserId: user.id, currentSubscriptionId: subscription.id },
    });
    return {
      familyId: family.id,
      userId: user.id,
      profileId: profile.id,
      email,
    };
  });
}

function createTransaction(
  prisma: PrismaClient,
  memberProfileId: string,
  accountId: string,
  categoryId: string,
  description: string,
  amountCents: number,
) {
  const referenceMonth = new Date("2026-07-01T00:00:00.000Z");
  return prisma.transaction.create({
    data: {
      id: randomUUID(),
      date: referenceMonth,
      applicationDate: new Date("2026-07-10T00:00:00.000Z"),
      referenceMonth,
      description,
      amountCents,
      type: "income",
      status: "confirmed",
      memberProfileId,
      accountId,
      categoryId,
    },
  });
}

async function login(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:8181",
    },
    body: JSON.stringify({ email, password: "integration-password" }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return (setCookie as string).split(";", 1)[0];
}

async function getJson(baseUrl: string, cookie: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
    200,
  );
  return response.json() as Promise<unknown>;
}

async function postJson(
  baseUrl: string,
  cookie: string,
  path: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(
    response.status,
    `POST ${path}: ${await response.clone().text()}`,
  ).toBe(201);
  return asRecord(await response.json());
}

async function expectStatus(
  baseUrl: string,
  cookie: string,
  path: string,
  expectedStatus: number,
  options: { method?: string; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  expect(
    response.status,
    `${options.method ?? "GET"} ${path}: ${await response.clone().text()}`,
  ).toBe(expectedStatus);
}

function itemsOf(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.items)) return record.items.map(asRecord);
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Resposta inválida");
  return value as Record<string, unknown>;
}

function readId(value: Record<string, unknown>) {
  return readString(value, "id");
}

function readMemberProfileId(value: Record<string, unknown>) {
  return readString(value, "memberProfileId");
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Campo ${key} ausente`);
  return field;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "number") throw new Error(`Campo ${key} ausente`);
  return field;
}
