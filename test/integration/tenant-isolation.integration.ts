import { OAuthIntent, PlatformRole, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface TenantFixture {
  familyId: string;
  userId: string;
  profileId: string;
  email: string;
}

interface FixtureIds {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
  inactiveProfileA: string;
  accountA: string;
  cardA: string;
  accountB: string;
  cardB: string;
  categoryB: string;
  transactionB: string;
  invoiceB: string;
  recurringB: string;
  installmentB: string;
  importBatchB: string;
  importRowB: string;
  inconsistentTransactionA: string;
}

describe('isolamento PostgreSQL com dois tenants', () => {
  let prisma: PrismaClient;
  let baseUrl: string;
  let fixture: FixtureIds;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }

    prisma = new PrismaClient();
    fixture = await createFixtures(prisma);
    baseUrl = process.env.TEST_API_URL ?? '';
    if (!baseUrl) throw new Error('TEST_API_URL ausente');

    cookieA = await login(baseUrl, fixture.tenantA.email);
    cookieB = await login(baseUrl, fixture.tenantB.email);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('mantém leituras familiares dentro do tenant e preserva histórico inativo', async () => {
    const accounts = itemsOf(await getJson(baseUrl, cookieA, '/accounts'));
    expect(accounts.map(readId)).toContain(fixture.accountA);
    expect(accounts.map(readMemberProfileId)).toContain(fixture.inactiveProfileA);
    expect(accounts.map(readId)).not.toContain(fixture.accountB);

    const categories = itemsOf(await getJson(baseUrl, cookieA, '/categories'));
    expect(categories.map(readId)).not.toContain(fixture.categoryB);

    const transactions = itemsOf(
      await getJson(baseUrl, cookieA, '/transactions?referenceMonth=2026-07&limit=100'),
    );
    const descriptions = transactions.map((item) => readString(item, 'description'));
    expect(descriptions).toContain('Receita owner A');
    expect(descriptions).toContain('Histórico inativo A');
    expect(descriptions).not.toContain('Receita owner B');
    expect(descriptions).not.toContain('Relações inconsistentes');

    const invoices = itemsOf(await getJson(baseUrl, cookieA, '/invoices?limit=50'));
    expect(invoices.map(readId)).not.toContain(fixture.invoiceB);

    const recurring = itemsOf(await getJson(baseUrl, cookieA, '/recurring'));
    expect(recurring.map(readId)).not.toContain(fixture.recurringB);

    const installments = await getJson(baseUrl, cookieA, '/installments?limit=50');
    expect(itemsOf(installments).map(readId)).not.toContain(fixture.installmentB);

    const batches = itemsOf(await getJson(baseUrl, cookieA, '/imports/batches?limit=50'));
    expect(batches.map(readId)).not.toContain(fixture.importBatchB);

    const profiles = itemsOf(await getJson(baseUrl, cookieA, '/profiles'));
    expect(profiles.map(readId)).not.toContain(fixture.inactiveProfileA);
  });

  it('rejeita filtros de perfil de outra família no dashboard, relatório e lançamentos', async () => {
    await expectStatus(
      baseUrl,
      cookieA,
      `/transactions?referenceMonth=2026-07&profileId=${fixture.tenantB.profileId}`,
      400,
    );
    await expectStatus(baseUrl, cookieA, `/dashboard?profileId=${fixture.tenantB.profileId}`, 400);
    await expectStatus(
      baseUrl,
      cookieA,
      `/reports/monthly?month=2026-07&profileId=${fixture.tenantB.profileId}`,
      400,
    );
  });

  it('mantém dashboard e relatório fail-closed diante de relações financeiras inconsistentes', async () => {
    const dashboard = asRecord(await getJson(baseUrl, cookieA, '/dashboard?referenceMonth=2026-07&family=true'));
    const dashboardTransactions = itemsOf(dashboard.transactions);
    expect(dashboardTransactions.map((item) => readString(item, 'description'))).not.toContain('Relações inconsistentes');

    const report = asRecord(await getJson(baseUrl, cookieA, '/reports/monthly?month=2026-07&family=true'));
    const reportProfiles = itemsOf(report.profiles);
    expect(reportProfiles.map(readId)).not.toContain(fixture.tenantB.profileId);
    const totals = asRecord(report.totals);
    expect(readNumber(totals, 'incomeCents')).toBe(30_000);
    expect(readNumber(totals, 'expenseCents')).toBe(1_000);
    expect(itemsOf(report.accounts).map((item) => readString(item, 'name'))).not.toContain('Cartão B');
    expect(itemsOf(report.categories).map((item) => readString(item, 'name'))).not.toContain('Categoria B');
  });

  it('não permite atualizar nem excluir recursos financeiros de outro tenant', async () => {
    const mutations: Array<[string, Record<string, unknown>]> = [
      [`/accounts/${fixture.accountB}`, { name: 'Tentativa externa' }],
      [`/categories/${fixture.categoryB}`, { name: 'Tentativa externa' }],
      [`/transactions/${fixture.transactionB}`, { description: 'Tentativa externa' }],
      [`/invoices/${fixture.invoiceB}`, { status: 'closed' }],
      [`/recurring/${fixture.recurringB}`, { description: 'Tentativa externa' }],
      [`/installments/${fixture.installmentB}`, { description: 'Tentativa externa' }],
    ];

    for (const [path, body] of mutations) {
      await expectStatus(baseUrl, cookieA, path, 404, { method: 'PATCH', body });
      await expectStatus(baseUrl, cookieA, path, 404, { method: 'DELETE' });
    }

    await expectStatus(baseUrl, cookieA, `/transactions/${fixture.inconsistentTransactionA}`, 404, {
      method: 'PATCH',
      body: { description: 'Tentativa em relação inconsistente' },
    });
    await expectStatus(baseUrl, cookieA, `/transactions/${fixture.inconsistentTransactionA}`, 404, {
      method: 'DELETE',
    });

    await expectStatus(baseUrl, cookieA, '/imports/confirm', 404, {
      method: 'POST',
      body: { batchId: fixture.importBatchB, rowIds: [fixture.importRowB] },
    });
    await expectStatus(baseUrl, cookieA, '/imports/discard', 404, {
      method: 'POST',
      body: { batchId: fixture.importBatchB },
    });
  });

  it('rejeita conta, categoria e fatura estrangeiras em uma nova mutação do autor', async () => {
    const baseTransaction = {
      applicationDate: '2026-07-20',
      referenceMonth: '2026-07-01',
      description: 'Tentativa com relação externa',
      amountCents: 1000,
      type: 'expense',
    };

    await expectStatus(baseUrl, cookieA, '/transactions', 400, {
      method: 'POST',
      body: { ...baseTransaction, accountId: fixture.accountB },
    });
    await expectStatus(baseUrl, cookieA, '/transactions', 400, {
      method: 'POST',
      body: { ...baseTransaction, categoryId: fixture.categoryB },
    });
    await expectStatus(baseUrl, cookieA, '/transactions', 400, {
      method: 'POST',
      body: { ...baseTransaction, accountId: fixture.cardA, invoiceId: fixture.invoiceB },
    });
  });

  it('não concede bypass financeiro ao admin de plataforma', async () => {
    const accounts = itemsOf(await getJson(baseUrl, cookieB, '/accounts'));
    expect(accounts.map(readId)).toContain(fixture.accountB);
    expect(accounts.map(readId)).not.toContain(fixture.accountA);

    const transactions = itemsOf(
      await getJson(baseUrl, cookieB, '/transactions?referenceMonth=2026-07&limit=100'),
    );
    expect(transactions.map(readMemberProfileId)).not.toContain(fixture.tenantA.profileId);
  });

  it('confirma batches idênticos sem externalId concorrentemente sem duplicar lançamento', async () => {
    const description = `Importação concorrente ${randomUUID()}`;
    const applicationDate = new Date('2026-08-01T00:00:00.000Z');
    const amountCents = 54_321;
    const batches = await Promise.all(
      [1, 2].map((sequence) =>
        prisma.importBatch.create({
          data: {
            id: randomUUID(),
            fileName: `concorrente-${sequence}.csv`,
            type: 'nubank_account',
            status: 'preview',
            memberProfileId: fixture.tenantA.profileId,
            rows: {
              create: {
                id: randomUUID(),
                rowIndex: 1,
                raw: { sequence },
                date: applicationDate,
                description,
                amountCents,
                status: 'new',
              },
            },
          },
        }),
      ),
    );

    const confirmations = await Promise.all(
      batches.map((batch) => postJson(baseUrl, cookieA, '/imports/confirm', { batchId: batch.id })),
    );

    expect(confirmations.reduce((sum, confirmation) => sum + readNumber(confirmation, 'imported'), 0)).toBe(1);
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

  it('rejeita mês inválido antes de materializar recorrências', async () => {
    await expectStatus(baseUrl, cookieA, '/recurring/generate?month=abc', 400, { method: 'POST' });
  });

  it('consome uma tentativa OAuth exatamente uma vez sob callbacks concorrentes', async () => {
    const attempt = await prisma.oAuthAttempt.create({
      data: {
        stateHash: `state-${randomUUID()}`,
        nonceHash: `nonce-${randomUUID()}`,
        browserBindingHash: `browser-${randomUUID()}`,
        pkceVerifierCiphertext: 'oa1.integration.iv.ciphertext.tag',
        pkceVerifierKeyVersion: 'v1',
        intent: OAuthIntent.login,
        returnPath: '/',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        prisma.oAuthAttempt.updateMany({
          where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() },
        }),
      ),
    );

    expect(claims.reduce((total, claim) => total + claim.count, 0)).toBe(1);
  });

  it('impede que o mesmo Google subject atravesse usuários ou famílias', async () => {
    const providerSubject = `google-${randomUUID()}`;
    await prisma.userIdentity.create({
      data: {
        provider: 'google',
        providerSubject,
        observedEmail: 'tenant-a-google@example.test',
        userId: fixture.tenantA.userId,
      },
    });

    await expect(
      prisma.userIdentity.create({
        data: {
          provider: 'google',
          providerSubject,
          observedEmail: 'tenant-b-google@example.test',
          userId: fixture.tenantB.userId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.userIdentity.create({
        data: {
          provider: 'google',
          providerSubject: `another-${providerSubject}`,
          observedEmail: 'tenant-a-second@example.test',
          userId: fixture.tenantA.userId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejeita login local iniciado por uma origem externa', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ email: fixture.tenantA.email, password: 'integration-password' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

async function createFixtures(prisma: PrismaClient): Promise<FixtureIds> {
  const passwordHash = await bcrypt.hash('integration-password', 4);
  const tenantA = await createTenant(prisma, 'tenant-a@example.test', 'Família A', PlatformRole.user, passwordHash);
  const tenantB = await createTenant(prisma, 'tenant-b@example.test', 'Família B', PlatformRole.admin, passwordHash);

  const inactive = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        email: 'inactive-a@example.test',
        passwordHash,
        name: 'Histórico A',
        familyId: tenantA.familyId,
        isActive: false,
      },
    });
    const profile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: 'Histórico A',
        familyId: tenantA.familyId,
        userId: user.id,
        status: 'inactive',
      },
    });
    return { user, profile };
  });

  const [accountA, cardA, inactiveAccountA, accountB, cardB] = await Promise.all([
    prisma.account.create({ data: { id: randomUUID(), name: 'Conta A', type: 'checking', memberProfileId: tenantA.profileId } }),
    prisma.account.create({
      data: { id: randomUUID(), name: 'Cartão A', type: 'credit_card', closingDay: 20, dueDay: 28, memberProfileId: tenantA.profileId },
    }),
    prisma.account.create({ data: { id: randomUUID(), name: 'Conta histórica A', type: 'checking', memberProfileId: inactive.profile.id } }),
    prisma.account.create({ data: { id: randomUUID(), name: 'Conta B', type: 'checking', memberProfileId: tenantB.profileId } }),
    prisma.account.create({
      data: { id: randomUUID(), name: 'Cartão B', type: 'credit_card', closingDay: 20, dueDay: 28, memberProfileId: tenantB.profileId },
    }),
  ]);
  const [categoryA, categoryB] = await Promise.all([
    prisma.category.create({ data: { id: randomUUID(), name: 'Categoria A', type: 'income', color: '#111111', familyId: tenantA.familyId } }),
    prisma.category.create({ data: { id: randomUUID(), name: 'Categoria B', type: 'income', color: '#222222', familyId: tenantB.familyId } }),
  ]);
  const referenceMonth = new Date('2026-07-01T00:00:00.000Z');
  const [, invoiceB] = await Promise.all([
    prisma.invoice.create({ data: { id: randomUUID(), accountId: cardA.id, memberProfileId: tenantA.profileId, referenceMonth } }),
    prisma.invoice.create({ data: { id: randomUUID(), accountId: cardB.id, memberProfileId: tenantB.profileId, referenceMonth } }),
  ]);
  const [, recurringB] = await Promise.all([
    prisma.recurringTemplate.create({
      data: {
        id: randomUUID(),
        description: 'Recorrência A', amountCents: 1000, type: 'expense', dayOfMonth: 5,
        startsAt: referenceMonth, accountId: accountA.id, memberProfileId: tenantA.profileId,
      },
    }),
    prisma.recurringTemplate.create({
      data: {
        id: randomUUID(),
        description: 'Recorrência B', amountCents: 2000, type: 'expense', dayOfMonth: 5,
        startsAt: referenceMonth, accountId: accountB.id, memberProfileId: tenantB.profileId,
      },
    }),
  ]);
  const [, installmentB] = await Promise.all([
    prisma.installmentPlan.create({
      data: {
        id: randomUUID(),
        description: 'Parcelamento A', totalInstallments: 2, firstReferenceMonth: referenceMonth,
        monthlyAmountCents: 5000, totalAmountCents: 10000, startsAt: referenceMonth,
        memberProfileId: tenantA.profileId,
      },
    }),
    prisma.installmentPlan.create({
      data: {
        id: randomUUID(),
        description: 'Parcelamento B', totalInstallments: 2, firstReferenceMonth: referenceMonth,
        monthlyAmountCents: 6000, totalAmountCents: 12000, startsAt: referenceMonth,
        memberProfileId: tenantB.profileId,
      },
    }),
  ]);
  const [, importB] = await Promise.all([
    prisma.importBatch.create({
      data: {
        id: randomUUID(), fileName: 'a.csv', type: 'nubank_account', memberProfileId: tenantA.profileId,
        rows: { create: { id: randomUUID(), rowIndex: 1, raw: {}, status: 'new', description: 'Import A', amountCents: 1000, date: referenceMonth } },
      },
      include: { rows: true },
    }),
    prisma.importBatch.create({
      data: {
        id: randomUUID(), fileName: 'b.csv', type: 'nubank_account', memberProfileId: tenantB.profileId,
        rows: { create: { id: randomUUID(), rowIndex: 1, raw: {}, status: 'new', description: 'Import B', amountCents: 1000, date: referenceMonth } },
      },
      include: { rows: true },
    }),
  ]);
  const [, , transactionB] = await Promise.all([
    createTransaction(prisma, tenantA.profileId, accountA.id, categoryA.id, 'Receita owner A', 10000),
    createTransaction(prisma, inactive.profile.id, inactiveAccountA.id, categoryA.id, 'Histórico inativo A', 20000),
    createTransaction(prisma, tenantB.profileId, accountB.id, categoryB.id, 'Receita owner B', 30000),
  ]);
  const inconsistentTransaction = await prisma.transaction.create({
    data: {
      id: randomUUID(),
      date: referenceMonth,
      applicationDate: new Date('2026-07-15T00:00:00.000Z'),
      referenceMonth,
      description: 'Relações inconsistentes',
      amountCents: 999999,
      type: 'expense',
      status: 'confirmed',
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
    inactiveProfileA: inactive.profile.id,
    accountA: accountA.id,
    cardA: cardA.id,
    accountB: accountB.id,
    cardB: cardB.id,
    categoryB: categoryB.id,
    transactionB: transactionB.id,
    invoiceB: invoiceB.id,
    recurringB: recurringB.id,
    installmentB: installmentB.id,
    importBatchB: importB.id,
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
    const family = await tx.family.create({ data: { id: randomUUID(), name: familyName } });
    const user = await tx.user.create({
      data: { id: randomUUID(), email, passwordHash, name: familyName, platformRole, familyId: family.id, emailVerifiedAt: new Date() },
    });
    const profile = await tx.memberProfile.create({
      data: { id: randomUUID(), displayName: familyName, userId: user.id, familyId: family.id },
    });
    await tx.family.update({ where: { id: family.id }, data: { ownerUserId: user.id } });
    return { familyId: family.id, userId: user.id, profileId: profile.id, email };
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
  const referenceMonth = new Date('2026-07-01T00:00:00.000Z');
  return prisma.transaction.create({
    data: {
      id: randomUUID(),
      date: referenceMonth,
      applicationDate: new Date('2026-07-10T00:00:00.000Z'),
      referenceMonth,
      description,
      amountCents,
      type: 'income',
      status: 'confirmed',
      memberProfileId,
      accountId,
      categoryId,
    },
  });
}

async function login(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8181' },
    body: JSON.stringify({ email, password: 'integration-password' }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return (setCookie as string).split(';', 1)[0];
}

async function getJson(baseUrl: string, cookie: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return response.json() as Promise<unknown>;
}

async function postJson(baseUrl: string, cookie: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBe(201);
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
    headers: { cookie, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  expect(response.status, `${options.method ?? 'GET'} ${path}: ${await response.clone().text()}`).toBe(expectedStatus);
}

function itemsOf(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.items)) return record.items.map(asRecord);
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resposta inválida');
  return value as Record<string, unknown>;
}

function readId(value: Record<string, unknown>) {
  return readString(value, 'id');
}

function readMemberProfileId(value: Record<string, unknown>) {
  return readString(value, 'memberProfileId');
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Campo ${key} ausente`);
  return field;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== 'number') throw new Error(`Campo ${key} ausente`);
  return field;
}
