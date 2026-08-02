import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { MembersModule } from '../modules/members/members.module';
import { SubscriptionAccessGuard } from '../modules/payments/subscription-access.guard';

describe('guards globais do AppModule', () => {
  it('registra o módulo de gestão de membros', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? []) as unknown[];

    expect(imports).toContain(MembersModule);
  });

  it('registra rate limiting antes da autenticação JWT', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? []) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const globalGuardClasses = providers
      .filter((provider) => provider?.provide === APP_GUARD)
      .map((provider) => provider.useClass);

    expect(globalGuardClasses).toEqual([
      ThrottlerGuard,
      JwtAuthGuard,
      SubscriptionAccessGuard,
    ]);
  });
});
