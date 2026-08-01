import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PlatformRole } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALLOW_PENDING_PAYMENT_ACCESS_KEY } from '../../shared/allow-pending-payment-access.decorator';
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

  it('denies pending-payment sessions by default after JWT authentication', async () => {
    const { context, handler, TestController } = createContext(pendingPaymentUser);
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === IS_PUBLIC_KEY ? undefined : undefined,
      ),
    };
    vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    await expect(guard.canActivate(context)).rejects.toEqual(
      new ForbiddenException({ code: 'PAYMENT_REQUIRED', message: 'Pagamento pendente' }),
    );
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      ALLOW_PENDING_PAYMENT_ACCESS_KEY,
      [handler, TestController],
    );
  });

  it('allows only explicitly annotated protected routes for pending-payment sessions', async () => {
    const { context } = createContext(pendingPaymentUser);
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === ALLOW_PENDING_PAYMENT_ACCESS_KEY ? true : undefined,
      ),
    };
    vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows normal app sessions without requiring opt-in metadata', async () => {
    const { context } = createContext({ ...pendingPaymentUser, requiredAction: null });
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    };
    vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(reflector as unknown as Reflector);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
