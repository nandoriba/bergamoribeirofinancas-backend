import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../../shared/public.decorator';
import type { AuthService } from './auth.service';
import { BrowserOriginGuard } from './browser-origin.guard';
import { OwnerOnboardingController } from './owner-onboarding.controller';
import type { OwnerOnboardingService } from './owner-onboarding.service';
import type { UserActionTokenService } from './user-action-token.service';

const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

function setup() {
  const onboarding = {
    publicConfig: vi.fn().mockReturnValue({ ownerSignupEnabled: false }),
    registerLocalOwner: vi.fn(),
    confirmEmailVerification: vi.fn(),
  } as unknown as OwnerOnboardingService;
  const actionTokens = {
    resendEmailVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    validatePasswordResetToken: vi.fn(),
    setPasswordResetCookie: vi.fn(),
    clearPasswordResetCookie: vi.fn(),
    passwordResetCookieName: vi.fn().mockReturnValue('financeiro-password-reset'),
    confirmPasswordReset: vi.fn(),
  } as unknown as UserActionTokenService;
  const authService = {
    setSessionCookie: vi.fn(),
    clearSessionCookie: vi.fn(),
  } as unknown as AuthService;
  const config = {
    getOrThrow: vi.fn().mockReturnValue('https://app.example.com'),
  } as unknown as ConfigService;
  const response = {
    setHeader: vi.fn(),
    redirect: vi.fn(),
  } as unknown as Response;
  const controller = new OwnerOnboardingController(
    onboarding,
    actionTokens,
    authService,
    config,
  );
  return { actionTokens, authService, controller, onboarding, response };
}

describe('OwnerOnboardingController transport', () => {
  it('marks every onboarding route public, throttles it and protects browser POSTs by Origin', () => {
    const reflector = new Reflector();
    const publicRoutes = [
      'onboardingConfig',
      'registerOwner',
      'confirmEmail',
      'resendEmail',
      'requestPasswordReset',
      'continuePasswordReset',
      'confirmPasswordReset',
    ] as const;
    const throttledRoutes = [
      ['registerOwner', 3],
      ['confirmEmail', 10],
      ['resendEmail', 3],
      ['requestPasswordReset', 3],
      ['continuePasswordReset', 30],
      ['confirmPasswordReset', 5],
    ] as const;

    for (const method of publicRoutes) {
      const handler = OwnerOnboardingController.prototype[method];
      expect(
        reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, OwnerOnboardingController]),
      ).toBe(true);
    }
    for (const [method, limit] of throttledRoutes) {
      const handler = OwnerOnboardingController.prototype[method];
      expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, handler)).toBe(limit);
      expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, handler)).toBe(60_000);
    }

    for (const method of [
      'registerOwner',
      'confirmEmail',
      'resendEmail',
      'requestPasswordReset',
      'confirmPasswordReset',
    ] as const) {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        OwnerOnboardingController.prototype[method],
      ) as unknown[];
      expect(guards).toContain(BrowserOriginGuard);
    }
    expect(
      Reflect.getMetadata(GUARDS_METADATA, OwnerOnboardingController.prototype.continuePasswordReset),
    ).toBeUndefined();
  });

  it('returns public config with no-store', () => {
    const { controller, response } = setup();

    expect(controller.onboardingConfig(response)).toEqual({ ownerSignupEnabled: false });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('returns only verification metadata after registration', async () => {
    const { controller, onboarding } = setup();
    const verification = {
      challengeId: 'token-1',
      destinationMasked: 'ow***@e***.com',
      resendAvailableAt: new Date(),
      expiresAt: new Date(),
    };
    vi.mocked(onboarding.registerLocalOwner).mockResolvedValue(verification);
    const dto = {
      ownerName: 'Owner',
      familyName: 'Family',
      email: 'owner@example.com',
      password: 'strong-password',
      legalAcceptanceVersion: '2026-08-01',
    };

    await expect(controller.registerOwner(dto)).resolves.toEqual({ verification });
  });

  it('exchanges a verification code for an HttpOnly session and no-store response', async () => {
    const { authService, controller, onboarding, response } = setup();
    vi.mocked(onboarding.confirmEmailVerification).mockResolvedValue({
      token: 'session-token',
      user: { id: 'user-1' },
    } as never);

    await expect(
      controller.confirmEmail({ challengeId: 'token-1', code: '123456' }, response),
    ).resolves.toEqual({ user: { id: 'user-1' } });
    expect(authService.setSessionCookie).toHaveBeenCalledWith(response, 'session-token');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('uses 202 for resend and reset request without exposing account state', async () => {
    const { actionTokens, controller } = setup();
    vi.mocked(actionTokens.resendEmailVerification).mockResolvedValue({ challengeId: 'new-token' } as never);

    await expect(controller.resendEmail({ challengeId: 'old-token' })).resolves.toEqual({
      verification: { challengeId: 'new-token' },
    });
    await expect(controller.requestPasswordReset({ email: 'owner@example.com' })).resolves.toEqual({
      ok: true,
    });
    expect(actionTokens.requestPasswordReset).toHaveBeenCalledWith('owner@example.com');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, OwnerOnboardingController.prototype.resendEmail)).toBe(202);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, OwnerOnboardingController.prototype.requestPasswordReset),
    ).toBe(202);
  });

  it('exchanges a valid reset link into a scoped cookie and redirects with 303', async () => {
    const { actionTokens, controller, response } = setup();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    vi.mocked(actionTokens.validatePasswordResetToken).mockResolvedValue({ expiresAt });

    await controller.continuePasswordReset('raw-token', response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(actionTokens.setPasswordResetCookie).toHaveBeenCalledWith(
      response,
      'raw-token',
      expiresAt,
    );
    expect(response.redirect).toHaveBeenCalledWith(
      303,
      'https://app.example.com/redefinir-senha',
    );
  });

  it('clears reset state and redirects malformed links with a generic status', async () => {
    const { actionTokens, controller, response } = setup();
    vi.mocked(actionTokens.validatePasswordResetToken).mockResolvedValue(undefined);

    await controller.continuePasswordReset(['not', 'a-string'], response);

    expect(actionTokens.validatePasswordResetToken).toHaveBeenCalledWith('');
    expect(actionTokens.clearPasswordResetCookie).toHaveBeenCalledWith(response);
    expect(response.redirect).toHaveBeenCalledWith(
      303,
      'https://app.example.com/redefinir-senha?status=invalid',
    );
  });

  it('consumes only the HttpOnly reset cookie and clears reset and old session cookies', async () => {
    const { actionTokens, authService, controller, response } = setup();
    const request = {
      cookies: { 'financeiro-password-reset': 'raw-token' },
    } as unknown as Request;

    await expect(
      controller.confirmPasswordReset(
        { password: 'new-password-123', passwordConfirmation: 'new-password-123' },
        request,
        response,
      ),
    ).resolves.toEqual({ ok: true });
    expect(actionTokens.confirmPasswordReset).toHaveBeenCalledWith(
      'raw-token',
      'new-password-123',
      'new-password-123',
    );
    expect(actionTokens.clearPasswordResetCookie).toHaveBeenCalledWith(response);
    expect(authService.clearSessionCookie).toHaveBeenCalledWith(response);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
