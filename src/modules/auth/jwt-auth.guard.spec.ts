import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PlatformRole } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../../shared/public.decorator';
import type { AuthenticatedUser } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createContext(user?: AuthenticatedUser) {
    class TestController {}
    const handler = () => undefined;
    const request = { user };
    const context = {
      getHandler: vi.fn(() => handler),
      getClass: vi.fn(() => TestController),
      switchToHttp: vi.fn(() => ({ getRequest: () => request })),
    } as unknown as ExecutionContext;

    return { context, handler, request, TestController };
  }

  const pendingPaymentUser: AuthenticatedUser = {
    id: 'user-1',
    email: 'owner@example.com',
    platformRole: PlatformRole.user,
    tenantRole: 'owner',
    familyId: 'family-1',
    profileId: 'profile-1',
    requiredAction: 'payment',
  };

  it('libera endpoint público sem invocar o Passport', async () => {
    const { context, handler, TestController } = createContext();
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    };
    const passportCanActivate = vi
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockResolvedValue(true);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    expect(await guard.canActivate(context)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [handler, TestController]);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('delega endpoint não público ao guard JWT do Passport', async () => {
    const { context, handler, TestController } = createContext();
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    };
    const passportCanActivate = vi
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockResolvedValue(false);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    expect(await guard.canActivate(context)).toBe(false);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [handler, TestController]);
    expect(passportCanActivate).toHaveBeenCalledOnce();
    expect(passportCanActivate).toHaveBeenCalledWith(context);
  });

  it('autentica sessão bloqueada sem aplicar política de assinatura neste guard', async () => {
    const { context } = createContext(pendingPaymentUser);
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    };
    vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
