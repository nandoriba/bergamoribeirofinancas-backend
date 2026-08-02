import type { ConfigService } from '@nestjs/config';
import { IdentityProvider, OAuthIntent, PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth.types';
import type { AuthService } from '../auth.service';
import { GoogleOAuthService } from '../google-oauth.service';
import type { GoogleOidcClient, GoogleAuthorizationInput } from '../google-oidc.client';
import type { MemberInviteOnboardingService } from '../member-invite-onboarding.service';
import { OAuthAttemptCryptoService } from '../oauth-attempt-crypto.service';
import { type OwnerOnboardingService, OwnerSignupConflictError } from '../owner-onboarding.service';

const currentUser: AuthenticatedUser = {
  id: 'local-user',
  email: 'local@example.com',
  platformRole: PlatformRole.user,
  tenantRole: 'member',
  familyId: 'family-1',
  profileId: 'profile-1',
  requiredAction: null,
  subscriptionAccess: {
    effectiveStatus: 'active',
    accessAllowed: true,
    reason: 'PAID_ACCESS',
  },
};

const activeSubscription = {
  providerStatus: 'ACTIVE',
  lastProviderEvent: 'subscription.renewed',
  providerUpdatedAt: new Date('2026-07-01T12:00:01.000Z'),
  lastSuccessfulPaymentAt: new Date('2026-07-01T12:00:00.000Z'),
  accessPaidThrough: new Date(Date.now() + 86_400_000),
  paymentFailedAt: null,
  graceUntil: null,
  cancelledAt: null,
  cancelRequestedAt: null,
  cancelledDueTo: null,
  lastInstallmentNumber: 2,
  entitlementContractVersion: 'sandbox-contract-v1',
  billingCycle: 'MONTHLY',
  paymentMethod: 'CARD',
};

function setup(configOverrides: Record<string, unknown> = {}) {
  const configValues: Record<string, unknown> = {
    GOOGLE_OAUTH_ENABLED: true,
    OAUTH_ATTEMPT_SECRET: 'oauth-attempt-test-secret-with-at-least-32-bytes',
    OAUTH_ATTEMPT_KEY_VERSION: 'v1',
    OAUTH_ATTEMPT_TTL_SECONDS: 300,
    COOKIE_SECURE: false,
    WEB_ORIGIN: 'http://127.0.0.1:8181',
    OWNER_SIGNUP_ENABLED: true,
    LEGAL_BUNDLE_VERSION: '2026-08-01',
    ...configOverrides,
  };
  const config = {
    get: vi.fn((key: string) => configValues[key]),
    getOrThrow: vi.fn((key: string) => {
      const value = configValues[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  const crypto = new OAuthAttemptCryptoService(config);
  let authorizationInput: GoogleAuthorizationInput | undefined;
  let storedAttempt: Record<string, unknown> | undefined;

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'family-1' }]),
    user: { findUnique: vi.fn() },
    family: {
      findUnique: vi.fn().mockResolvedValue({ currentSubscription: activeSubscription }),
    },
    userIdentity: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const prisma = {
    oAuthAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        storedAttempt = {
          id: 'attempt-1',
          createdAt: new Date(),
          consumedAt: null,
          memberInviteId: null,
          inviteDisplayName: null,
          legalAcceptanceVersion: null,
          legalAcceptedAt: null,
          signupOwnerName: null,
          signupFamilyName: null,
          ...data,
        };
        return storedAttempt;
      }),
      findUnique: vi.fn(async () => storedAttempt),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
    },
    user: { findUnique: vi.fn() },
    userIdentity: {
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaService;
  const authService = {
    confirmCurrentPassword: vi.fn(),
    createSessionForUserId: vi.fn().mockResolvedValue({
      token: 'new-session-token',
      user: { requiredAction: null },
    }),
  } as unknown as AuthService;
  const ownerOnboarding = {
    completeGoogleOwnerSignup: vi.fn().mockResolvedValue({
      token: 'owner-session-token',
      user: { id: 'owner-user', requiredAction: 'payment' },
    }),
  } as unknown as OwnerOnboardingService;
  const memberInviteOnboarding = {
    prepareGoogleAttempt: vi.fn().mockResolvedValue({
      memberInviteId: 'invite-1',
      inviteDisplayName: 'Maria Ribeiro',
    }),
    completeGoogleAttempt: vi.fn().mockResolvedValue({ status: 'pending_approval' }),
  } as unknown as MemberInviteOnboardingService;
  const oidcClient = {
    isEnabled: vi.fn().mockReturnValue(true),
    createAuthorizationUrl: vi.fn(async (input: GoogleAuthorizationInput) => {
      authorizationInput = input;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', input.state);
      return url.toString();
    }),
    exchangeCode: vi.fn(),
  } as unknown as GoogleOidcClient;

  const service = new GoogleOAuthService(
    prisma,
    authService,
    ownerOnboarding,
    memberInviteOnboarding,
    oidcClient,
    crypto,
    config,
  );
  return {
    authService,
    crypto,
    getAuthorizationInput: () => authorizationInput,
    getStoredAttempt: () => storedAttempt,
    oidcClient,
    memberInviteOnboarding,
    ownerOnboarding,
    prisma,
    service,
    setStoredAttempt: (value: Record<string, unknown>) => {
      storedAttempt = value;
    },
    tx,
  };
}

describe('GoogleOAuthService', () => {
  it('persists only hashes and an encrypted PKCE verifier and issues a transient browser cookie', async () => {
    const { crypto, getAuthorizationInput, getStoredAttempt, service } = setup();

    const result = await service.start({
      intent: OAuthIntent.login,
      returnPath: '/membros',
    });
    const authorization = getAuthorizationInput();
    const stored = getStoredAttempt();
    if (!authorization || !stored) throw new Error('Expected an OAuth attempt');
    const verifier = crypto.decryptPkceVerifier({
      pkceVerifierCiphertext: String(stored.pkceVerifierCiphertext),
      pkceVerifierKeyVersion: String(stored.pkceVerifierKeyVersion),
    });
    const serialized = JSON.stringify(stored);

    expect(stored).toMatchObject({
      intent: OAuthIntent.login,
      authenticatedUserId: null,
      returnPath: '/membros',
    });
    expect(serialized).not.toContain(authorization.state);
    expect(serialized).not.toContain(authorization.nonce);
    expect(serialized).not.toContain(result.bindingCookie.value);
    expect(serialized).not.toContain(verifier);
    expect(result.bindingCookie).toMatchObject({
      name: expect.stringMatching(/^financeiro-oauth-/),
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: 300_000,
      },
    });
  });

  it('purges expired and previously consumed attempts in bounded batches', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.oAuthAttempt.findMany)
      .mockResolvedValueOnce([{ id: 'expired-attempt' }, { id: 'consumed-attempt' }] as never)
      .mockResolvedValueOnce([]);

    await service.cleanupStaleAttempts();

    expect(prisma.oAuthAttempt.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.oAuthAttempt.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['expired-attempt', 'consumed-attempt'] },
        OR: [{ consumedAt: null, expiresAt: { lte: expect.any(Date) } }, { consumedAt: { lte: expect.any(Date) } }],
      },
    });
    expect(prisma.oAuthAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 250 }));
  });

  it('does not block a new OAuth attempt when background cleanup fails', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.oAuthAttempt.findMany).mockRejectedValueOnce(new Error('cleanup unavailable'));

    await expect(service.start({ intent: OAuthIntent.login })).resolves.toEqual(
      expect.objectContaining({
        authorizationUrl: expect.stringContaining('accounts.google.com'),
      }),
    );

    expect(prisma.oAuthAttempt.create).toHaveBeenCalledOnce();
  });

  it.each(['https://attacker.example', '//attacker.example', '/auth/google/callback', '/relatorios?admin=1'])(
    'rejects a return destination outside the exact allowlist: %s',
    async (returnPath) => {
      const { oidcClient, prisma, service } = setup();

      await expect(service.start({ intent: OAuthIntent.login, returnPath })).rejects.toMatchObject({ status: 400 });
      expect(oidcClient.createAuthorizationUrl).not.toHaveBeenCalled();
      expect(prisma.oAuthAttempt.create).not.toHaveBeenCalled();
    },
  );

  it('resolves an invite server-side and persists only its internal id and normalized member name', async () => {
    const { getStoredAttempt, memberInviteOnboarding, service } = setup();
    const inviteToken = 'a'.repeat(43);

    await service.start({
      intent: OAuthIntent.accept_invite,
      inviteToken,
      memberName: 'Maria Ribeiro',
    });

    expect(memberInviteOnboarding.prepareGoogleAttempt).toHaveBeenCalledWith({
      token: inviteToken,
      displayName: 'Maria Ribeiro',
    });
    expect(getStoredAttempt()).toMatchObject({
      intent: OAuthIntent.accept_invite,
      authenticatedUserId: null,
      memberInviteId: 'invite-1',
      inviteDisplayName: 'Maria Ribeiro',
      returnPath: null,
    });
    expect(JSON.stringify(getStoredAttempt())).not.toContain(inviteToken);
  });

  it('rejects incomplete, authenticated or contaminated invite starts before calling the domain', async () => {
    const incomplete = setup();
    await expect(
      incomplete.service.start({
        intent: OAuthIntent.accept_invite,
        inviteToken: 'a'.repeat(43),
      }),
    ).rejects.toMatchObject({ status: 400 });

    const authenticated = setup();
    await expect(
      authenticated.service.start(
        {
          intent: OAuthIntent.accept_invite,
          inviteToken: 'a'.repeat(43),
          memberName: 'Maria Ribeiro',
        },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const contaminated = setup();
    await expect(
      contaminated.service.start({
        intent: OAuthIntent.accept_invite,
        inviteToken: 'a'.repeat(43),
        memberName: 'Maria Ribeiro',
        ownerName: 'Injected Owner',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(incomplete.memberInviteOnboarding.prepareGoogleAttempt).not.toHaveBeenCalled();
    expect(authenticated.memberInviteOnboarding.prepareGoogleAttempt).not.toHaveBeenCalled();
    expect(contaminated.memberInviteOnboarding.prepareGoogleAttempt).not.toHaveBeenCalled();
  });

  it('starts anonymous owner signup with normalized names and server-owned legal facts', async () => {
    const before = Date.now();
    const { getStoredAttempt, service } = setup();

    await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: '  Ana   Silva ',
      familyName: ' Família   Silva ',
      legalAcceptanceVersion: '2026-08-01',
    });

    const stored = getStoredAttempt();
    expect(stored).toMatchObject({
      intent: OAuthIntent.signup_owner,
      authenticatedUserId: null,
      returnPath: null,
      signupOwnerName: 'Ana Silva',
      signupFamilyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
      legalAcceptedAt: expect.any(Date),
    });
    expect((stored?.legalAcceptedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((stored?.legalAcceptedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('fails owner-signup start closed when disabled, stale, incomplete or bound to a session', async () => {
    const disabled = setup({ OWNER_SIGNUP_ENABLED: false });
    await expect(
      disabled.service.start({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana Silva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(disabled.oidcClient.createAuthorizationUrl).not.toHaveBeenCalled();

    const stale = setup();
    await expect(
      stale.service.start({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana Silva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: 'stale-version',
      }),
    ).rejects.toMatchObject({ status: 409 });

    const incomplete = setup();
    await expect(
      incomplete.service.start({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana Silva',
        legalAcceptanceVersion: '2026-08-01',
      }),
    ).rejects.toMatchObject({ status: 400 });

    const malformed = setup();
    await expect(
      malformed.service.start({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana\nSilva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(malformed.prisma.oAuthAttempt.create).not.toHaveBeenCalled();

    const authenticated = setup();
    await expect(
      authenticated.service.start(
        {
          intent: OAuthIntent.signup_owner,
          ownerName: 'Ana Silva',
          familyName: 'Família Silva',
          legalAcceptanceVersion: '2026-08-01',
        },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([{ currentPassword: 'not-allowed' }, { returnPath: '/' }])(
    'rejects extraneous owner-signup context: %o',
    async (extra) => {
      const { prisma, service } = setup();

      await expect(
        service.start({
          intent: OAuthIntent.signup_owner,
          ownerName: 'Ana Silva',
          familyName: 'Família Silva',
          legalAcceptanceVersion: '2026-08-01',
          ...extra,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.oAuthAttempt.create).not.toHaveBeenCalled();
    },
  );

  it('rejects owner-signup fields attached to login or link intents', async () => {
    const login = setup();
    await expect(
      login.service.start({
        intent: OAuthIntent.login,
        ownerName: 'Injected Owner',
      }),
    ).rejects.toMatchObject({ status: 400 });

    const link = setup();
    await expect(
      link.service.start(
        {
          intent: OAuthIntent.link_account,
          currentPassword: 'current-password',
          legalAcceptanceVersion: '2026-08-01',
        },
        currentUser,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(link.authService.confirmCurrentPassword).not.toHaveBeenCalled();
  });

  it('binds link_account to the authenticated user only after checking the current password', async () => {
    const { authService, getStoredAttempt, prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      passwordHash: 'hash',
      identities: [],
    } as never);

    await service.start({ intent: OAuthIntent.link_account, currentPassword: 'current-password' }, currentUser);

    expect(authService.confirmCurrentPassword).toHaveBeenCalledWith('local-user', 'current-password');
    expect(getStoredAttempt()).toMatchObject({
      intent: OAuthIntent.link_account,
      authenticatedUserId: 'local-user',
      returnPath: '/configuracoes',
    });
  });

  it('does not consume or call Google when the browser binding is absent or wrong', async () => {
    const { getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login });
    const state = getAuthorizationInput()?.state;

    const result = await service.complete({
      state,
      code: 'code',
      browserBinding: `${start.bindingCookie.value}x`,
    });

    expect(new URL(result.redirectUrl).searchParams.get('reason')).toBe('failed');
    expect(prisma.oAuthAttempt.updateMany).not.toHaveBeenCalled();
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('logs in only through an existing Google subject and rotates the local session', async () => {
    const { authService, getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.login,
      returnPath: '/contas',
    });
    const nonce = getAuthorizationInput()?.nonce;
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'google-subject',
      email: 'observed@example.com',
      nonce: String(nonce),
    });
    vi.mocked(prisma.userIdentity.findUnique).mockResolvedValue({
      id: 'identity-1',
      user: { id: 'local-user', isActive: true, profile: { status: 'active' } },
    } as never);

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    expect(prisma.oAuthAttempt.updateMany).toHaveBeenCalledOnce();
    expect(oidcClient.exchangeCode).toHaveBeenCalledOnce();
    expect(prisma.userIdentity.update).toHaveBeenCalledWith({
      where: { id: 'identity-1' },
      data: {
        observedEmail: 'observed@example.com',
        lastUsedAt: expect.any(Date),
      },
    });
    expect(authService.createSessionForUserId).toHaveBeenCalledWith('local-user');
    expect(result.token).toBe('new-session-token');
    expect(new URL(result.redirectUrl).pathname).toBe('/contas');
  });

  it('redirects an existing Google login with a payment requirement to the payment boundary', async () => {
    const { authService, getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.login,
      returnPath: '/contas',
    });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'google-subject',
      email: 'observed@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });
    vi.mocked(prisma.userIdentity.findUnique).mockResolvedValue({
      id: 'identity-1',
      user: { id: 'local-user', isActive: true, profile: { status: 'active' } },
    } as never);
    vi.mocked(authService.createSessionForUserId).mockResolvedValue({
      token: 'pending-payment-session',
      user: { requiredAction: 'payment' },
    } as never);

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    expect(result.token).toBe('pending-payment-session');
    expect(new URL(result.redirectUrl).pathname).toBe('/pagamento/pendente');
  });

  it('completes Google owner signup exclusively from persisted attempt facts and verified identity', async () => {
    const {
      getAuthorizationInput,
      getStoredAttempt,
      oidcClient,
      ownerOnboarding,
      service,
    } = setup();
    const start = await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });
    const attempt = getStoredAttempt();
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'verified-google-subject',
      email: 'verified@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    expect(ownerOnboarding.completeGoogleOwnerSignup).toHaveBeenCalledWith({
      subject: 'verified-google-subject',
      email: 'verified@example.com',
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
      legalAcceptedAt: attempt?.legalAcceptedAt,
    });
    expect(result.token).toBe('owner-session-token');
    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/pagamento/pendente');
    expect(redirect.search).toBe('');
    expect(result.redirectUrl).not.toContain('verified-google-subject');
    expect(result.redirectUrl).not.toContain('verified%40example.com');
    expect(result.redirectUrl).not.toContain('Ana');
  });

  it('accepts an invite with the persisted internal reference and never creates a session before approval', async () => {
    const {
      getAuthorizationInput,
      memberInviteOnboarding,
      oidcClient,
      service,
    } = setup();
    const start = await service.start({
      intent: OAuthIntent.accept_invite,
      inviteToken: 'a'.repeat(43),
      memberName: 'Maria Ribeiro',
    });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'invited-google-subject',
      email: 'member@example.com',
      name: 'Ignored Provider Name',
      nonce: String(getAuthorizationInput()?.nonce),
    });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    expect(memberInviteOnboarding.completeGoogleAttempt).toHaveBeenCalledWith({
      memberInviteId: 'invite-1',
      inviteDisplayName: 'Maria Ribeiro',
      identity: {
        subject: 'invited-google-subject',
        email: 'member@example.com',
        name: 'Ignored Provider Name',
        nonce: String(getAuthorizationInput()?.nonce),
      },
    });
    expect(result.token).toBeUndefined();
    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/convite/resultado');
    expect(redirect.searchParams.get('oauth')).toBe('success');
    expect(redirect.searchParams.get('action')).toBe('pending_approval');
    expect(result.redirectUrl).not.toContain('invite-1');
    expect(result.redirectUrl).not.toContain('member%40example.com');
  });

  it('rejects an invite callback if the browser acquired a session after the OAuth start', async () => {
    const { getAuthorizationInput, memberInviteOnboarding, oidcClient, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.accept_invite,
      inviteToken: 'a'.repeat(43),
      memberName: 'Maria Ribeiro',
    });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
      currentUser,
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/convite/resultado');
    expect(redirect.searchParams.get('reason')).toBe('failed');
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
    expect(memberInviteOnboarding.completeGoogleAttempt).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
  });

  it('fails a signup callback if the browser acquired an authenticated session after start', async () => {
    const { getAuthorizationInput, oidcClient, ownerOnboarding, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
      currentUser,
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/cadastro');
    expect(redirect.searchParams.get('reason')).toBe('failed');
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
    expect(ownerOnboarding.completeGoogleOwnerSignup).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
  });

  it('maps a transactional owner-signup conflict to a closed account_exists callback reason', async () => {
    const { getAuthorizationInput, oidcClient, ownerOnboarding, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'existing-google-subject',
      email: 'existing@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });
    vi.mocked(ownerOnboarding.completeGoogleOwnerSignup).mockRejectedValue(new OwnerSignupConflictError());

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/cadastro');
    expect(redirect.searchParams.get('oauth')).toBe('error');
    expect(redirect.searchParams.get('reason')).toBe('account_exists');
    expect(result.token).toBeUndefined();
  });

  it('fails closed without a session when the transactional signup delegate rolls back', async () => {
    const { getAuthorizationInput, oidcClient, ownerOnboarding, service } = setup();
    const start = await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'new-google-subject',
      email: 'new@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });
    vi.mocked(ownerOnboarding.completeGoogleOwnerSignup).mockRejectedValue(new Error('transaction rolled back'));

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.pathname).toBe('/cadastro');
    expect(redirect.searchParams.get('reason')).toBe('failed');
    expect(result.token).toBeUndefined();
  });

  it.each([
    ['access_denied', 'cancelled'],
    ['temporarily_unavailable', 'failed'],
  ] as const)(
    'returns owner-signup provider %s to cadastro as %s without exchanging claims',
    async (providerError, expectedReason) => {
      const { getAuthorizationInput, oidcClient, ownerOnboarding, service } = setup();
      const start = await service.start({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana Silva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
      });

      const result = await service.complete({
        state: getAuthorizationInput()?.state,
        providerError,
        browserBinding: start.bindingCookie.value,
      });

      const redirect = new URL(result.redirectUrl);
      expect(redirect.pathname).toBe('/cadastro');
      expect(redirect.searchParams.get('reason')).toBe(expectedReason);
      expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
      expect(ownerOnboarding.completeGoogleOwnerSignup).not.toHaveBeenCalled();
    },
  );

  it('does not delegate signup when its persisted server-owned facts are incomplete', async () => {
    const { getAuthorizationInput, getStoredAttempt, oidcClient, ownerOnboarding, service, setStoredAttempt } = setup();
    const start = await service.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });
    const attempt = getStoredAttempt();
    if (!attempt) throw new Error('Expected stored attempt');
    setStoredAttempt({ ...attempt, signupFamilyName: null });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'new-google-subject',
      email: 'new@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'one-time-code',
      browserBinding: start.bindingCookie.value,
    });

    expect(new URL(result.redirectUrl).pathname).toBe('/cadastro');
    expect(new URL(result.redirectUrl).searchParams.get('reason')).toBe('failed');
    expect(ownerOnboarding.completeGoogleOwnerSignup).not.toHaveBeenCalled();
  });

  it('never auto-creates or auto-links an unknown subject, even when its email could match locally', async () => {
    const { authService, getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'unknown-subject',
      email: currentUser.email,
      nonce: String(getAuthorizationInput()?.nonce),
    });
    vi.mocked(prisma.userIdentity.findUnique).mockResolvedValue(null);

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'code',
      browserBinding: start.bindingCookie.value,
    });

    expect(new URL(result.redirectUrl).searchParams.get('reason')).toBe('not_linked');
    expect(prisma.userIdentity.update).not.toHaveBeenCalled();
    expect(authService.createSessionForUserId).not.toHaveBeenCalled();
  });

  it('allows exactly one callback claim and does not exchange a replayed code', async () => {
    const { getAuthorizationInput, getStoredAttempt, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login });
    vi.mocked(prisma.oAuthAttempt.updateMany).mockResolvedValue({ count: 0 });

    await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'replayed-code',
      browserBinding: start.bindingCookie.value,
    });

    const attempt = getStoredAttempt();
    expect(prisma.oAuthAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'attempt-1',
        stateHash: attempt?.stateHash,
        browserBindingHash: attempt?.browserBindingHash,
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    });
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('claims a provider cancellation once without exchanging a code', async () => {
    const { getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login });

    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      providerError: 'access_denied',
      browserBinding: start.bindingCookie.value,
    });

    expect(prisma.oAuthAttempt.updateMany).toHaveBeenCalledOnce();
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
    expect(new URL(result.redirectUrl).searchParams.get('reason')).toBe('cancelled');
  });

  it('fails expired attempts before the atomic claim and provider exchange', async () => {
    const { getAuthorizationInput, getStoredAttempt, oidcClient, prisma, service, setStoredAttempt } = setup();
    const start = await service.start({ intent: OAuthIntent.login });
    const stored = getStoredAttempt();
    if (!stored) throw new Error('Expected stored attempt');
    setStoredAttempt({ ...stored, expiresAt: new Date(Date.now() - 1_000) });

    await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'code',
      browserBinding: start.bindingCookie.value,
    });

    expect(prisma.oAuthAttempt.updateMany).not.toHaveBeenCalled();
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('consumes but rejects an ID token whose nonce does not match the attempt', async () => {
    const { getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login });
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'google-subject',
      email: 'observed@example.com',
      nonce: 'another-nonce',
    });

    await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'code',
      browserBinding: start.bindingCookie.value,
    });

    expect(prisma.oAuthAttempt.updateMany).toHaveBeenCalledOnce();
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it('requires an active local session for the same user at callback and never changes tenant or primary email', async () => {
    const { authService, getAuthorizationInput, oidcClient, prisma, service, tx } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      passwordHash: 'hash',
      identities: [],
    } as never);
    const start = await service.start(
      { intent: OAuthIntent.link_account, currentPassword: 'current-password' },
      currentUser,
    );
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'google-subject',
      email: 'different-google-email@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'local-user',
      isActive: true,
      familyId: 'family-1',
      profile: { status: 'active' },
    });
    tx.userIdentity.findUnique.mockResolvedValue(null);

    const mismatched = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'code',
      browserBinding: start.bindingCookie.value,
      currentUser: { ...currentUser, id: 'another-user' },
    });
    expect(new URL(mismatched.redirectUrl).searchParams.get('reason')).toBe('failed');
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();

    vi.mocked(prisma.oAuthAttempt.updateMany).mockResolvedValue({ count: 1 });
    const stored = service.bindingCookieName(getAuthorizationInput()?.state);
    expect(stored).toBe(start.bindingCookie.name);
    const result = await service.complete({
      state: getAuthorizationInput()?.state,
      code: 'code',
      browserBinding: start.bindingCookie.value,
      currentUser,
    });

    expect(tx.userIdentity.create).toHaveBeenCalledWith({
      data: {
        provider: IdentityProvider.google,
        providerSubject: 'google-subject',
        observedEmail: 'different-google-email@example.com',
        userId: 'local-user',
      },
    });
    expect(authService.createSessionForUserId).toHaveBeenCalledWith('local-user');
    expect(result.token).toBe('new-session-token');
  });

  it('reports when unlink would remove the only access method', async () => {
    const { authService, prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      passwordHash: null,
      identities: [{ observedEmail: 'google@example.com' }],
    } as never);

    await expect(service.getMethods('local-user')).resolves.toEqual({
      password: { enabled: false },
      google: {
        linked: true,
        observedEmail: 'google@example.com',
        canUnlink: false,
        unlinkBlockedReason: 'local_password_required',
      },
    });

    vi.mocked(authService.confirmCurrentPassword).mockRejectedValue(new Error('Senha atual inválida'));
    await expect(service.unlink('local-user', 'current-password')).rejects.toThrow('Senha atual inválida');
    expect(prisma.userIdentity.deleteMany).not.toHaveBeenCalled();
  });

  it('scopes a valid unlink to the current user and rotates the session', async () => {
    const { authService, service, tx } = setup();

    tx.user.findUnique.mockResolvedValue({
      passwordHash: 'local-password-hash',
    });
    tx.userIdentity.deleteMany.mockResolvedValue({ count: 1 });
    const result = await service.unlink('local-user', 'current-password');
    expect(authService.confirmCurrentPassword).toHaveBeenCalledWith('local-user', 'current-password');
    expect(tx.userIdentity.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'local-user', provider: IdentityProvider.google },
    });
    expect(authService.createSessionForUserId).toHaveBeenCalledWith('local-user');
    expect(result.token).toBe('new-session-token');
  });
});
