import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuthController } from '../modules/auth/auth.controller';
import { BrowserOriginGuard } from '../modules/auth/browser-origin.guard';
import { OptionalJwtAuthGuard } from '../modules/auth/optional-jwt-auth.guard';
import { HealthController } from '../modules/health/health.controller';
import { MemberApprovalsController } from '../modules/member-approvals/member-approvals.controller';
import { MemberInvitesController } from '../modules/member-invites/member-invites.controller';
import { ProfilesController } from '../modules/profiles/profiles.controller';
import { PaymentsController } from '../modules/payments/payments.controller';
import { AbacatePayWebhookController } from '../modules/payments/webhooks/abacatepay-webhook.controller';
import { TelegramAuthCodesController } from '../modules/telegram/telegram-auth-codes.controller';
import { TelegramWebhookController } from '../modules/telegram/telegram-webhook.controller';
import { UsersController } from '../modules/users/users.controller';
import {
  ALLOW_PENDING_PAYMENT_ACCESS_KEY,
  AllowPendingPaymentAccess,
} from './allow-pending-payment-access.decorator';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { TenantOwnerGuard } from './tenant-owner.guard';

const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';
const ONE_MINUTE_MS = 60_000;

type ControllerType = abstract new (...args: never[]) => unknown;

const reflector = new Reflector();

function isPublic(controller: ControllerType, handler: (...args: never[]) => unknown) {
  return reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]);
}

function allowsPendingPayment(controller: ControllerType, handler: (...args: never[]) => unknown) {
  return reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PAYMENT_ACCESS_KEY, [handler, controller]);
}

function expectThrottle(handler: (...args: never[]) => unknown, limit: number) {
  expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, handler)).toBe(limit);
  expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, handler)).toBe(ONE_MINUTE_MS);
}

function guardsFor(controller: ControllerType, handler: (...args: never[]) => unknown) {
  const controllerGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
  const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
  return [...controllerGuards, ...handlerGuards];
}

describe('metadados de acesso dos controllers', () => {
  it('Public marca o handler com a chave compartilhada', () => {
    class FixtureController {
      @Public()
      endpoint() {}
    }

    expect(isPublic(FixtureController, FixtureController.prototype.endpoint)).toBe(true);
  });

  it('AllowPendingPaymentAccess marca o handler com a chave compartilhada', () => {
    class FixtureController {
      @AllowPendingPaymentAccess()
      endpoint() {}
    }

    expect(
      allowsPendingPayment(FixtureController, FixtureController.prototype.endpoint),
    ).toBe(true);
  });

  it('libera para tenant bloqueado somente sessão, logout e cobrança revisada', () => {
    expect(allowsPendingPayment(AuthController, AuthController.prototype.me)).toBe(true);
    expect(allowsPendingPayment(AuthController, AuthController.prototype.logout)).toBe(true);
    expect(
      allowsPendingPayment(
        PaymentsController,
        PaymentsController.prototype.getSubscription,
      ),
    ).toBe(true);
    expect(
      allowsPendingPayment(
        PaymentsController,
        PaymentsController.prototype.createCheckout,
      ),
    ).toBe(true);
    expect(
      allowsPendingPayment(
        PaymentsController,
        PaymentsController.prototype.reconcileSubscription,
      ),
    ).toBe(true);
    expect(
      allowsPendingPayment(
        PaymentsController,
        PaymentsController.prototype.cancelSubscription,
      ),
    ).toBe(true);
    expect(allowsPendingPayment(AuthController, AuthController.prototype.methods)).toBeUndefined();
    expect(allowsPendingPayment(UsersController, UsersController.prototype.updateTheme)).toBeUndefined();
  });

  it.each([
    ['login', AuthController, AuthController.prototype.login],
    ['início Google OAuth', AuthController, AuthController.prototype.startGoogle],
    ['callback Google OAuth', AuthController, AuthController.prototype.googleCallback],
    ['consulta de convite', MemberInvitesController, MemberInvitesController.prototype.getPublic],
    ['cadastro de membro', MemberInvitesController, MemberInvitesController.prototype.register],
    ['webhook do Telegram', TelegramWebhookController, TelegramWebhookController.prototype.receiveWebhook],
    [
      'webhook autenticado da AbacatePay',
      AbacatePayWebhookController,
      AbacatePayWebhookController.prototype.receive,
    ],
    ['healthcheck', HealthController, HealthController.prototype.check],
  ] as const)('marca %s como público', (_label, controller, handler) => {
    expect(isPublic(controller, handler)).toBe(true);
  });

  it.each([
    ['sessão atual', AuthController, AuthController.prototype.me],
    ['métodos de acesso', AuthController, AuthController.prototype.methods],
    ['desvínculo Google', AuthController, AuthController.prototype.unlinkGoogle],
    ['logout', AuthController, AuthController.prototype.logout],
    ['criação de convite', MemberInvitesController, MemberInvitesController.prototype.create],
    ['listagem de convites', MemberInvitesController, MemberInvitesController.prototype.list],
    ['aprovações de membros', MemberApprovalsController, MemberApprovalsController.prototype.list],
    ['listagem de perfis', ProfilesController, ProfilesController.prototype.list],
    ['atualização de tema', UsersController, UsersController.prototype.updateTheme],
    ['código do grupo Telegram', TelegramAuthCodesController, TelegramAuthCodesController.prototype.createGroupCode],
    [
      'código de membro Telegram',
      TelegramAuthCodesController,
      TelegramAuthCodesController.prototype.createMemberCode,
    ],
  ] as const)('não marca a rota protegida %s como pública', (_label, controller, handler) => {
    expect(isPublic(controller, handler)).toBeUndefined();
  });

  it('limita tentativas de login a 5 por minuto', () => {
    expectThrottle(AuthController.prototype.login, 5);
  });

  it('limita início, callback e desvínculo Google sem estrangular o retorno do provedor', () => {
    expectThrottle(AuthController.prototype.startGoogle, 10);
    expectThrottle(AuthController.prototype.googleCallback, 60);
    expectThrottle(AuthController.prototype.unlinkGoogle, 5);
  });

  it('exige Origin exata nas mutações Google e usa autenticação opcional nos handlers públicos', () => {
    expect(guardsFor(AuthController, AuthController.prototype.login)).toContain(BrowserOriginGuard);
    expect(guardsFor(AuthController, AuthController.prototype.startGoogle)).toEqual(
      expect.arrayContaining([BrowserOriginGuard, OptionalJwtAuthGuard]),
    );
    expect(guardsFor(AuthController, AuthController.prototype.googleCallback)).toContain(OptionalJwtAuthGuard);
    expect(guardsFor(AuthController, AuthController.prototype.unlinkGoogle)).toContain(BrowserOriginGuard);
  });

  it('limita cadastros de membros a 3 por minuto', () => {
    expectThrottle(MemberInvitesController.prototype.register, 3);
  });

  it('limita requisições do webhook Telegram a 60 por minuto', () => {
    expectThrottle(TelegramWebhookController.prototype.receiveWebhook, 60);
  });

  it.each([
    ['criação de convite', MemberInvitesController, MemberInvitesController.prototype.create],
    ['listagem de convites', MemberInvitesController, MemberInvitesController.prototype.list],
    ['listagem de aprovações', MemberApprovalsController, MemberApprovalsController.prototype.list],
    ['aprovação de membro', MemberApprovalsController, MemberApprovalsController.prototype.approve],
    ['rejeição de membro', MemberApprovalsController, MemberApprovalsController.prototype.reject],
    ['código do grupo Telegram', TelegramAuthCodesController, TelegramAuthCodesController.prototype.createGroupCode],
  ] as const)('protege %s com TenantOwnerGuard', (_label, controller, handler) => {
    expect(guardsFor(controller, handler)).toContain(TenantOwnerGuard);
  });

  it.each([
    ['consulta pública de convite', MemberInvitesController, MemberInvitesController.prototype.getPublic],
    ['cadastro público por convite', MemberInvitesController, MemberInvitesController.prototype.register],
    [
      'código Telegram do próprio membro',
      TelegramAuthCodesController,
      TelegramAuthCodesController.prototype.createMemberCode,
    ],
  ] as const)('não exige owner para %s', (_label, controller, handler) => {
    expect(guardsFor(controller, handler)).not.toContain(TenantOwnerGuard);
  });
});
