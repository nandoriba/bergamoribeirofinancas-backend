import type { ConfigService } from '@nestjs/config';
import { IdentityProvider, OAuthIntent, PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';
import type { AuthService } from './auth.service';
import { GoogleOAuthService } from './google-oauth.service';
import type { GoogleOidcClient, GoogleAuthorizationInput } from './google-oidc.client';
import { OAuthAttemptCryptoService } from './oauth-attempt-crypto.service';

const currentUser: AuthenticatedUser = {
  id: 'local-user',
  email: 'local@example.com',
  platformRole: PlatformRole.user,
  tenantRole: 'member',
  familyId: 'family-1',
  profileId: 'profile-1',
};

function setup() {
  const configValues: Record<string, unknown> = {
    GOOGLE_OAUTH_ENABLED: true,
    OAUTH_ATTEMPT_SECRET: 'oauth-attempt-test-secret-with-at-least-32-bytes',
    OAUTH_ATTEMPT_KEY_VERSION: 'v1',
    OAUTH_ATTEMPT_TTL_SECONDS: 300,
    COOKIE_SECURE: false,
    WEB_ORIGIN: 'http://127.0.0.1:8181',
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
    user: { findUnique: vi.fn() },
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
          legalAcceptanceVersion: null,
          legalAcceptedAt: null,
          ...data,
        };
        return storedAttempt;
      }),
      findUnique: vi.fn(async () => storedAttempt),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    createSessionForUserId: vi.fn().mockResolvedValue({ token: 'new-session-token', user: {} }),
  } as unknown as AuthService;
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

  const service = new GoogleOAuthService(prisma, authService, oidcClient, crypto, config);
  return {
    authService,
    crypto,
    getAuthorizationInput: () => authorizationInput,
    getStoredAttempt: () => storedAttempt,
    oidcClient,
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

    const result = await service.start({ intent: OAuthIntent.login, returnPath: '/relatorios' });
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
      returnPath: '/relatorios',
    });
    expect(serialized).not.toContain(authorization.state);
    expect(serialized).not.toContain(authorization.nonce);
    expect(serialized).not.toContain(result.bindingCookie.value);
    expect(serialized).not.toContain(verifier);
    expect(result.bindingCookie).toMatchObject({
      name: expect.stringMatching(/^financeiro-oauth-/),
      options: { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 300_000 },
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
        OR: [
          { consumedAt: null, expiresAt: { lte: expect.any(Date) } },
          { consumedAt: { lte: expect.any(Date) } },
        ],
      },
    });
    expect(prisma.oAuthAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 250 }),
    );
  });

  it('does not block a new OAuth attempt when background cleanup fails', async () => {
    const { prisma, service } = setup();
    vi.mocked(prisma.oAuthAttempt.findMany).mockRejectedValueOnce(new Error('cleanup unavailable'));

    await expect(service.start({ intent: OAuthIntent.login })).resolves.toEqual(
      expect.objectContaining({ authorizationUrl: expect.stringContaining('accounts.google.com') }),
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

  it('keeps future signup and invite intents closed until their domain slices are implemented', async () => {
    const { service } = setup();

    await expect(service.start({ intent: OAuthIntent.signup_owner })).rejects.toMatchObject({ status: 400 });
    await expect(service.start({ intent: OAuthIntent.accept_invite })).rejects.toMatchObject({ status: 400 });
  });

  it('binds link_account to the authenticated user only after checking the current password', async () => {
    const { authService, getStoredAttempt, prisma, service } = setup();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ passwordHash: 'hash', identities: [] } as never);

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

    const result = await service.complete({ state, code: 'code', browserBinding: `${start.bindingCookie.value}x` });

    expect(new URL(result.redirectUrl).searchParams.get('reason')).toBe('failed');
    expect(prisma.oAuthAttempt.updateMany).not.toHaveBeenCalled();
    expect(oidcClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('logs in only through an existing Google subject and rotates the local session', async () => {
    const { authService, getAuthorizationInput, oidcClient, prisma, service } = setup();
    const start = await service.start({ intent: OAuthIntent.login, returnPath: '/contas' });
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
      data: { observedEmail: 'observed@example.com', lastUsedAt: expect.any(Date) },
    });
    expect(authService.createSessionForUserId).toHaveBeenCalledWith('local-user');
    expect(result.token).toBe('new-session-token');
    expect(new URL(result.redirectUrl).pathname).toBe('/contas');
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
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ passwordHash: 'hash', identities: [] } as never);
    const start = await service.start(
      { intent: OAuthIntent.link_account, currentPassword: 'current-password' },
      currentUser,
    );
    vi.mocked(oidcClient.exchangeCode).mockResolvedValue({
      subject: 'google-subject',
      email: 'different-google-email@example.com',
      nonce: String(getAuthorizationInput()?.nonce),
    });
    tx.user.findUnique.mockResolvedValue({ id: 'local-user', isActive: true, profile: { status: 'active' } });
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

    tx.user.findUnique.mockResolvedValue({ passwordHash: 'local-password-hash' });
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
