import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  EmailOutboxStatus,
  IdentityProvider,
  PasswordResetRequestStatus,
  PrismaClient,
  UserActionTokenPurpose,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';
import { ActionTokenCryptoService } from '../../src/modules/auth/action-token-crypto.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { EmailOutboxService } from '../../src/modules/auth/email-outbox.service';
import { OwnerOnboardingService } from '../../src/modules/auth/owner-onboarding.service';
import { UserActionTokenService } from '../../src/modules/auth/user-action-token.service';

const WEB_ORIGIN = 'http://127.0.0.1:8181';
const LOCAL_PASSWORD = 'integration-password-2026';
const RESET_PASSWORD = 'integration-reset-2026';

describe('onboarding de owner com PostgreSQL real', () => {
  let prisma: PrismaClient;
  let crypto: ActionTokenCryptoService;
  let actionTokens: UserActionTokenService;
  let onboarding: OwnerOnboardingService;
  let baseUrl: string;

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }

    prisma = new PrismaClient();
    baseUrl = process.env.TEST_API_URL ?? '';
    if (!baseUrl) throw new Error('TEST_API_URL ausente');

    const config = new ConfigService({
      OWNER_SIGNUP_ENABLED: true,
      EMAIL_PROVIDER: 'resend',
      ACTION_TOKEN_SECRET: 'a'.repeat(48),
      EMAIL_OUTBOX_SECRET: 'b'.repeat(48),
      EMAIL_OUTBOX_KEY_VERSION: 'integration-v1',
      EMAIL_VERIFICATION_TTL_MINUTES: 15,
      PASSWORD_RESET_TTL_MINUTES: 30,
      ACTION_TOKEN_MAX_ATTEMPTS: 5,
      ACTION_TOKEN_HOURLY_LIMIT: 5,
      ACTION_TOKEN_DAILY_LIMIT: 10,
      EMAIL_RESEND_COOLDOWN_SECONDS: 60,
      PENDING_PAYMENT_TTL_DAYS: 7,
      LEGAL_BUNDLE_VERSION: '2026-08-01',
      WEB_ORIGIN,
      PUBLIC_API_ORIGIN: baseUrl,
      COOKIE_SECURE: false,
      JWT_SECRET: 'integration-owner-jwt-secret'.padEnd(40, '!'),
      JWT_EXPIRES_IN: '7d',
    });
    const prismaService = prisma as unknown as PrismaService;
    crypto = new ActionTokenCryptoService(config);
    const outbox = {
      kick: vi.fn(),
    } as unknown as EmailOutboxService;
    actionTokens = new UserActionTokenService(prismaService, crypto, outbox, config);
    const authService = new AuthService(
      prismaService,
      new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') }),
      config,
    );
    onboarding = new OwnerOnboardingService(prismaService, config, actionTokens, authService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('cria tenant, owner, aceite, desafio e outbox atomicamente e mantém o financeiro bloqueado', async () => {
    const suffix = randomUUID();
    const email = `Owner-${suffix}@Example.com`;
    const verification = await onboarding.registerLocalOwner({
      ownerName: 'Owner Integração',
      familyName: 'Família Integração',
      email,
      password: LOCAL_PASSWORD,
      legalAcceptanceVersion: '2026-08-01',
    });

    const token = await prisma.userActionToken.findUniqueOrThrow({
      where: { id: verification.challengeId },
      include: { emailOutbox: true, user: { include: { profile: true, family: true } } },
    });
    const outbox = token.emailOutbox;
    expect(outbox?.status).toBe(EmailOutboxStatus.pending);
    expect(token.user.email).toBe(email.toLowerCase());
    expect(token.user.emailVerifiedAt).toBeNull();
    expect(token.user.isActive).toBe(true);
    expect(token.user.profile?.status).toBe('active');
    expect(token.user.family.ownerUserId).toBe(token.user.id);
    expect(token.user.family.pendingPaymentExpiresAt).not.toBeNull();

    const acceptance = await prisma.legalAcceptance.findUniqueOrThrow({
      where: {
        userId_bundleVersion: {
          userId: token.user.id,
          bundleVersion: '2026-08-01',
        },
      },
    });
    expect(acceptance.familyId).toBe(token.user.familyId);
    expect(acceptance.source).toBe('local');

    expect(outbox?.payloadCiphertext).toBeTruthy();
    const payload = crypto.decryptOutboxPayload(outbox!.id, {
      payloadCiphertext: outbox!.payloadCiphertext!,
      payloadKeyVersion: outbox!.payloadKeyVersion,
    });
    expect(payload.kind).toBe('email_verification');
    if (payload.kind !== 'email_verification') throw new Error('Payload inesperado');
    expect(outbox?.payloadCiphertext).not.toContain(payload.code);
    expect(token.secretHash).not.toBe(payload.code);

    const confirmations = await Promise.allSettled([
      actionTokens.confirmEmailVerification(token.id, payload.code),
      actionTokens.confirmEmailVerification(token.id, payload.code),
    ]);
    expect(confirmations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(confirmations.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const cookie = await login(baseUrl, token.user.email, LOCAL_PASSWORD, 201);
    const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as Record<string, unknown>;
    expect(me.requiredAction).toBe('payment');
    expect(typeof me.pendingPaymentExpiresAt).toBe('string');

    const accountsResponse = await fetch(`${baseUrl}/accounts`, { headers: { cookie } });
    expect(accountsResponse.status).toBe(403);
    const blocked = (await accountsResponse.json()) as Record<string, unknown>;
    expect(blocked.code).toBe('PAYMENT_REQUIRED');

    const resetRequestedAt = new Date();
    await actionTokens.requestPasswordReset(token.user.email);
    await actionTokens.dispatchPasswordResetRequests();
    const reset = await latestPayload(token.user.id, UserActionTokenPurpose.password_reset);
    await expectResetRequestCompleted(resetRequestedAt);
    expect(reset.payload.kind).toBe('password_reset');
    if (reset.payload.kind !== 'password_reset') throw new Error('Payload inesperado');
    await expect(actionTokens.validatePasswordResetToken(reset.payload.resetToken)).resolves.toBeDefined();
    await actionTokens.confirmPasswordReset(
      reset.payload.resetToken,
      RESET_PASSWORD,
      RESET_PASSWORD,
    );

    const staleSession = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    expect(staleSession.status).toBe(401);
    await login(baseUrl, token.user.email, LOCAL_PASSWORD, 401);
    await login(baseUrl, token.user.email, RESET_PASSWORD, 201);
  });

  it('resolve cadastros concorrentes e variantes canônicas de e-mail em um único tenant', async () => {
    const suffix = randomUUID();
    const canonicalEmail = `concurrent-${suffix}@example.com`;
    const first = onboarding.registerLocalOwner({
      ownerName: 'Owner Concorrente',
      familyName: 'Família Concorrente A',
      email: `  ${canonicalEmail.toUpperCase()}  `,
      password: LOCAL_PASSWORD,
      legalAcceptanceVersion: '2026-08-01',
    });
    const second = onboarding.registerLocalOwner({
      ownerName: 'Outro Owner',
      familyName: 'Família Concorrente B',
      email: canonicalEmail,
      password: LOCAL_PASSWORD,
      legalAcceptanceVersion: '2026-08-01',
    });

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const users = await prisma.user.findMany({
      where: { email: canonicalEmail },
      include: { family: true },
    });
    expect(users).toHaveLength(1);
    expect(users[0]?.family.ownerUserId).toBe(users[0]?.id);
    expect(
      await prisma.family.count({ where: { id: users[0]?.familyId } }),
    ).toBe(1);
  });

  it('permite que owner Google-only defina senha sem remover a identidade', async () => {
    const suffix = randomUUID();
    const email = `google-only-${suffix}@example.com`;
    const session = await onboarding.completeGoogleOwnerSignup({
      subject: `google-subject-${suffix}`,
      email,
      ownerName: 'Owner Google',
      familyName: 'Família Google',
      legalAcceptanceVersion: '2026-08-01',
      legalAcceptedAt: new Date(),
    });
    expect(session.user.requiredAction).toBe('payment');

    const created = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { identities: true },
    });
    expect(created.passwordHash).toBeNull();
    expect(created.identities).toEqual([
      expect.objectContaining({ provider: IdentityProvider.google }),
    ]);

    const resetRequestedAt = new Date();
    await actionTokens.requestPasswordReset(email);
    await actionTokens.dispatchPasswordResetRequests();
    const reset = await latestPayload(created.id, UserActionTokenPurpose.password_reset);
    await expectResetRequestCompleted(resetRequestedAt);
    if (reset.payload.kind !== 'password_reset') throw new Error('Payload inesperado');
    await actionTokens.confirmPasswordReset(
      reset.payload.resetToken,
      RESET_PASSWORD,
      RESET_PASSWORD,
    );

    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
      include: { identities: true },
    });
    expect(updated.passwordHash).toBeTruthy();
    expect(updated.authVersion).toBe(1);
    expect(updated.identities).toHaveLength(1);
    expect(updated.identities[0]?.provider).toBe(IdentityProvider.google);
  });

  async function latestPayload(userId: string, purpose: UserActionTokenPurpose) {
    await vi.waitFor(async () => {
      const queued = await prisma.userActionToken.findFirst({ where: { userId, purpose } });
      expect(queued).not.toBeNull();
    }, { timeout: 2_000 });
    const token = await prisma.userActionToken.findFirstOrThrow({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      include: { emailOutbox: true },
    });
    const outbox = token.emailOutbox;
    if (!outbox?.payloadCiphertext) throw new Error('Outbox cifrada ausente');
    return {
      token,
      payload: crypto.decryptOutboxPayload(outbox.id, {
        payloadCiphertext: outbox.payloadCiphertext,
        payloadKeyVersion: outbox.payloadKeyVersion,
      }),
    };
  }

  async function expectResetRequestCompleted(createdAfter: Date) {
    await vi.waitFor(async () => {
      const request = await prisma.passwordResetRequest.findFirst({
        where: { createdAt: { gte: createdAfter } },
        orderBy: { createdAt: 'desc' },
      });
      expect(request).toMatchObject({
        status: PasswordResetRequestStatus.completed,
        emailCiphertext: null,
        nextAttemptAt: null,
        lockedAt: null,
        completedAt: expect.any(Date),
      });
    }, { timeout: 2_000 });
  }
});

async function login(
  baseUrl: string,
  email: string,
  password: string,
  expectedStatus: number,
): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status, await response.clone().text()).toBe(expectedStatus);
  const setCookie = response.headers.get('set-cookie');
  if (expectedStatus !== 201) return '';
  expect(setCookie).toBeTruthy();
  return (setCookie as string).split(';', 1)[0] ?? '';
}
