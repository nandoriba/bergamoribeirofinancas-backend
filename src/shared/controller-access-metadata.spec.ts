import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuthController } from '../modules/auth/auth.controller';
import { HealthController } from '../modules/health/health.controller';
import { MemberApprovalsController } from '../modules/member-approvals/member-approvals.controller';
import { MemberInvitesController } from '../modules/member-invites/member-invites.controller';
import { ProfilesController } from '../modules/profiles/profiles.controller';
import { TelegramAuthCodesController } from '../modules/telegram/telegram-auth-codes.controller';
import { TelegramWebhookController } from '../modules/telegram/telegram-webhook.controller';
import { UsersController } from '../modules/users/users.controller';
import { IS_PUBLIC_KEY, Public } from './public.decorator';

const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';
const ONE_MINUTE_MS = 60_000;

type ControllerType = abstract new (...args: never[]) => unknown;

const reflector = new Reflector();

function isPublic(controller: ControllerType, handler: (...args: never[]) => unknown) {
  return reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]);
}

function expectThrottle(handler: (...args: never[]) => unknown, limit: number) {
  expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, handler)).toBe(limit);
  expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, handler)).toBe(ONE_MINUTE_MS);
}

describe('metadados de acesso dos controllers', () => {
  it('Public marca o handler com a chave compartilhada', () => {
    class FixtureController {
      @Public()
      endpoint() {}
    }

    expect(isPublic(FixtureController, FixtureController.prototype.endpoint)).toBe(true);
  });

  it.each([
    ['login', AuthController, AuthController.prototype.login],
    ['consulta de convite', MemberInvitesController, MemberInvitesController.prototype.getPublic],
    ['cadastro de membro', MemberInvitesController, MemberInvitesController.prototype.register],
    ['webhook do Telegram', TelegramWebhookController, TelegramWebhookController.prototype.receiveWebhook],
    ['healthcheck', HealthController, HealthController.prototype.check],
  ] as const)('marca %s como público', (_label, controller, handler) => {
    expect(isPublic(controller, handler)).toBe(true);
  });

  it.each([
    ['sessão atual', AuthController, AuthController.prototype.me],
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

  it('limita cadastros de membros a 3 por minuto', () => {
    expectThrottle(MemberInvitesController.prototype.register, 3);
  });

  it('limita requisições do webhook Telegram a 60 por minuto', () => {
    expectThrottle(TelegramWebhookController.prototype.receiveWebhook, 60);
  });
});
