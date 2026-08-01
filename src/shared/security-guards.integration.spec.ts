import {
  Controller,
  Get,
  type INestApplication,
  Injectable,
  Module,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AddressInfo } from 'node:net';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../modules/payments/subscription-access.guard';
import { SubscriptionAccessPolicy } from '../modules/payments/subscription-access.policy';
import { AllowBlockedTenantAccess } from './allow-blocked-tenant-access.decorator';
import { nestApplicationOptions } from './nest-application-options';
import { Public } from './public.decorator';

@Injectable()
class FixtureJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: 'x'.repeat(32),
    });
  }

  validate(payload: Record<string, unknown>) {
    return payload;
  }
}

@Controller('security-fixture')
class SecurityFixtureController {
  @Get('public')
  @Public()
  publicRoute() {
    return { ok: true };
  }

  @Get('protected-by-default')
  protectedByDefault() {
    return { ok: true };
  }

  @Get('billing-allowlist')
  @AllowBlockedTenantAccess()
  billingAllowlist() {
    return { ok: true };
  }

  @Get('limited')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  limited() {
    return { ok: true };
  }

  @Post('raw-body')
  @Public()
  rawBody(@Req() request: RawBodyRequest<Request>) {
    return { rawBody: request.rawBody?.toString('utf8') };
  }
}

@Module({
  imports: [PassportModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [SecurityFixtureController],
  providers: [
    FixtureJwtStrategy,
    SubscriptionAccessPolicy,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SubscriptionAccessGuard },
  ],
})
class SecurityFixtureModule {}

describe('guards globais de segurança', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({ imports: [SecurityFixtureModule] }).compile();
    app = testingModule.createNestApplication(nestApplicationOptions);
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/security-fixture`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('libera sem JWT somente rotas explicitamente públicas', async () => {
    const publicResponse = await fetch(`${baseUrl}/public`);
    const protectedResponse = await fetch(`${baseUrl}/protected-by-default`);

    expect(publicResponse.status).toBe(200);
    expect(protectedResponse.status).toBe(401);
  });

  it('aplica paywall default-deny depois da autenticação e respeita somente a allowlist', async () => {
    const activeToken = token({
      effectiveStatus: 'active',
      accessAllowed: true,
      reason: 'PAID_ACCESS',
    });
    const pendingToken = token({
      effectiveStatus: 'pending_payment',
      accessAllowed: false,
      reason: 'FIRST_PAYMENT_UNCONFIRMED',
    });

    const active = await fetch(`${baseUrl}/protected-by-default`, {
      headers: { authorization: `Bearer ${activeToken}` },
    });
    const blocked = await fetch(`${baseUrl}/protected-by-default`, {
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    const billing = await fetch(`${baseUrl}/billing-allowlist`, {
      headers: { authorization: `Bearer ${pendingToken}` },
    });

    expect(active.status).toBe(200);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(billing.status).toBe(200);
  });

  it('não dá bypass a admin e bloqueia principal sem snapshot de assinatura', async () => {
    const adminBlocked = await fetch(`${baseUrl}/protected-by-default`, {
      headers: {
        authorization: `Bearer ${token({
          effectiveStatus: 'cancelled',
          accessAllowed: false,
          reason: 'CANCELLATION_CONFIRMED',
        }, 'admin')}`,
      },
    });
    const missingSnapshot = await fetch(`${baseUrl}/protected-by-default`, {
      headers: { authorization: `Bearer ${token(undefined)}` },
    });

    expect(adminBlocked.status).toBe(403);
    expect(missingSnapshot.status).toBe(403);
  });

  it('retorna 429 após o limite configurado da rota', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/limited`),
      fetch(`${baseUrl}/limited`),
      fetch(`${baseUrl}/limited`),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
  });

  it('preserva os bytes exatos do JSON para validar assinatura de webhook', async () => {
    const body = '{ "update_id": 1, "message": { "text": "olá" } }';
    const response = await fetch(`${baseUrl}/raw-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ rawBody: body });
  });
});

function token(
  subscriptionAccess?: Record<string, unknown>,
  platformRole = 'user',
): string {
  return new JwtService({ secret: 'x'.repeat(32) }).sign({
    sub: 'user-1',
    platformRole,
    subscriptionAccess,
  });
}
