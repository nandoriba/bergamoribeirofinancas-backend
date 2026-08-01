import type { Request, Response } from 'express';
import { OAuthIntent, PlatformRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuthController } from './auth.controller';
import type { AuthenticatedUser } from './auth.types';
import type { AuthService } from './auth.service';
import type { GoogleOAuthService } from './google-oauth.service';

const user: AuthenticatedUser = {
  id: 'user-1',
  email: 'person@example.com',
  platformRole: PlatformRole.user,
  tenantRole: 'owner',
  familyId: 'family-1',
  profileId: 'profile-1',
  requiredAction: null,
};

function setup() {
  const authService = {
    setSessionCookie: vi.fn(),
  } as unknown as AuthService;
  const googleOAuthService = {
    start: vi.fn(),
    complete: vi.fn(),
    bindingCookieName: vi.fn().mockReturnValue('financeiro-oauth-cookie'),
    bindingCookieOptions: vi.fn().mockReturnValue({ httpOnly: true, sameSite: 'lax', path: '/' }),
  } as unknown as GoogleOAuthService;
  const response = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn().mockReturnValue(undefined),
    setHeader: vi.fn(),
  } as unknown as Response;

  return {
    authService,
    controller: new AuthController(authService, googleOAuthService),
    googleOAuthService,
    response,
  };
}

describe('AuthController Google OAuth transport', () => {
  it('returns only the authorization URL and keeps the browser binding in an HttpOnly cookie', async () => {
    const { controller, googleOAuthService, response } = setup();
    vi.mocked(googleOAuthService.start).mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      bindingCookie: {
        name: 'financeiro-oauth-cookie',
        value: 'browser-secret',
        options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 300_000 },
      },
    });

    const result = await controller.startGoogle({ intent: OAuthIntent.login }, undefined, response);

    expect(result).toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    });
    expect(response.cookie).toHaveBeenCalledWith(
      'financeiro-oauth-cookie',
      'browser-secret',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    expect(JSON.stringify(result)).not.toContain('browser-secret');
  });

  it('clears the per-attempt cookie, rotates the session and redirects with 303', async () => {
    const { authService, controller, googleOAuthService, response } = setup();
    vi.mocked(googleOAuthService.complete).mockResolvedValue({
      token: 'rotated-session',
      redirectUrl: 'http://127.0.0.1:8181/',
    });
    const request = {
      cookies: { 'financeiro-oauth-cookie': 'browser-secret' },
    } as unknown as Request;
    vi.mocked(response.redirect).mockImplementation(() => {
      expect(response.clearCookie).toHaveBeenCalledOnce();
      expect(authService.setSessionCookie).toHaveBeenCalledOnce();
      return undefined as never;
    });

    await controller.googleCallback('state-value', 'authorization-code', undefined, user, request, response);

    expect(googleOAuthService.complete).toHaveBeenCalledWith({
      state: 'state-value',
      code: 'authorization-code',
      providerError: undefined,
      browserBinding: 'browser-secret',
      currentUser: user,
    });
    expect(authService.setSessionCookie).toHaveBeenCalledWith(response, 'rotated-session');
    expect(response.redirect).toHaveBeenCalledWith(303, 'http://127.0.0.1:8181/');
    expect(response.clearCookie).toHaveBeenCalledWith(
      'financeiro-oauth-cookie',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('still clears the transient cookie if an unexpected callback failure escapes', async () => {
    const { controller, googleOAuthService, response } = setup();
    vi.mocked(googleOAuthService.complete).mockRejectedValue(new Error('unexpected'));
    const request = {
      cookies: { 'financeiro-oauth-cookie': 'browser-secret' },
    } as unknown as Request;

    await expect(
      controller.googleCallback('state-value', 'code', undefined, undefined, request, response),
    ).rejects.toThrow('unexpected');
    expect(response.clearCookie).toHaveBeenCalledOnce();
  });
});
