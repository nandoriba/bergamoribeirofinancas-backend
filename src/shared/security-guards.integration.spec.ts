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
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AddressInfo } from 'node:net';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
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
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
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
