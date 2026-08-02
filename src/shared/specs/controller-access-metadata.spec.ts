import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module';
import { BrowserOriginGuard } from '../../modules/auth/browser-origin.guard';
import { OptionalJwtAuthGuard } from '../../modules/auth/optional-jwt-auth.guard';
import {
  ALLOW_BLOCKED_TENANT_ACCESS_KEY,
  AllowBlockedTenantAccess,
} from '../allow-blocked-tenant-access.decorator';
import { IS_PUBLIC_KEY, Public } from '../public.decorator';
import { TenantOwnerGuard } from '../tenant-owner.guard';

const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';
const ONE_MINUTE_MS = 60_000;

type Handler = (...args: never[]) => unknown;
type ClassType = (abstract new (...args: never[]) => unknown) & {
  readonly name: string;
  readonly prototype: object;
};
type ExpectedAccess = {
  access: 'public' | 'protected';
  allowBlockedTenant?: true;
  ownerOnly?: true;
};
type AppRoute = {
  key: string;
  controller: ClassType;
  handler: Handler;
};

const EXPECTED_ACCESS = {
  'AbacatePayWebhookController.receive': { access: 'public' },

  'AccountsController.create': { access: 'protected' },
  'AccountsController.list': { access: 'protected' },
  'AccountsController.remove': { access: 'protected' },
  'AccountsController.update': { access: 'protected' },

  'AuthController.googleCallback': { access: 'public' },
  'AuthController.login': { access: 'public' },
  'AuthController.logout': {
    access: 'protected',
    allowBlockedTenant: true,
  },
  'AuthController.me': {
    access: 'protected',
    allowBlockedTenant: true,
  },
  'AuthController.methods': { access: 'protected' },
  'AuthController.startGoogle': { access: 'public' },
  'AuthController.unlinkGoogle': { access: 'protected' },

  'CategoriesController.create': { access: 'protected' },
  'CategoriesController.list': { access: 'protected' },
  'CategoriesController.remove': { access: 'protected' },
  'CategoriesController.update': { access: 'protected' },

  'DashboardController.getDashboard': { access: 'protected' },

  'HealthController.check': { access: 'public' },

  'ImportsController.confirm': { access: 'protected' },
  'ImportsController.discard': { access: 'protected' },
  'ImportsController.listBatches': { access: 'protected' },
  'ImportsController.preview': { access: 'protected' },

  'InstallmentsController.create': { access: 'protected' },
  'InstallmentsController.list': { access: 'protected' },
  'InstallmentsController.remove': { access: 'protected' },
  'InstallmentsController.update': { access: 'protected' },

  'InvoicesController.create': { access: 'protected' },
  'InvoicesController.list': { access: 'protected' },
  'InvoicesController.remove': { access: 'protected' },
  'InvoicesController.update': { access: 'protected' },

  'MemberApprovalsController.approve': {
    access: 'protected',
    ownerOnly: true,
  },
  'MemberApprovalsController.list': {
    access: 'protected',
    ownerOnly: true,
  },
  'MemberApprovalsController.reject': {
    access: 'protected',
    ownerOnly: true,
  },

  'MemberInvitesController.confirmEmail': { access: 'public' },
  'MemberInvitesController.create': {
    access: 'protected',
    ownerOnly: true,
  },
  'MemberInvitesController.emailVerificationStatus': { access: 'public' },
  'MemberInvitesController.list': {
    access: 'protected',
    ownerOnly: true,
  },
  'MemberInvitesController.register': { access: 'public' },
  'MemberInvitesController.resendEmail': { access: 'public' },
  'MemberInvitesController.resolve': { access: 'public' },
  'MemberInvitesController.revoke': {
    access: 'protected',
    ownerOnly: true,
  },

  'MembersController.deactivate': {
    access: 'protected',
    ownerOnly: true,
  },
  'MembersController.list': {
    access: 'protected',
    ownerOnly: true,
  },

  'OwnerOnboardingController.confirmEmail': { access: 'public' },
  'OwnerOnboardingController.confirmPasswordReset': { access: 'public' },
  'OwnerOnboardingController.continuePasswordReset': { access: 'public' },
  'OwnerOnboardingController.onboardingConfig': { access: 'public' },
  'OwnerOnboardingController.registerOwner': { access: 'public' },
  'OwnerOnboardingController.requestPasswordReset': { access: 'public' },
  'OwnerOnboardingController.resendEmail': { access: 'public' },

  'PaymentsController.cancelSubscription': {
    access: 'protected',
    allowBlockedTenant: true,
    ownerOnly: true,
  },
  'PaymentsController.createCheckout': {
    access: 'protected',
    allowBlockedTenant: true,
    ownerOnly: true,
  },
  'PaymentsController.getSubscription': {
    access: 'protected',
    allowBlockedTenant: true,
  },
  'PaymentsController.reconcileSubscription': {
    access: 'protected',
    allowBlockedTenant: true,
    ownerOnly: true,
  },

  'ProfilesController.list': { access: 'protected' },

  'RecurringController.create': { access: 'protected' },
  'RecurringController.generate': { access: 'protected' },
  'RecurringController.list': { access: 'protected' },
  'RecurringController.remove': { access: 'protected' },
  'RecurringController.update': { access: 'protected' },

  'ReportsController.monthly': { access: 'protected' },

  'TelegramAuthCodesController.createGroupCode': {
    access: 'protected',
    ownerOnly: true,
  },
  'TelegramAuthCodesController.createMemberCode': { access: 'protected' },
  'TelegramAuthCodesController.memberUsage': {
    access: 'protected',
    ownerOnly: true,
  },
  'TelegramAuthCodesController.status': { access: 'protected' },

  'TelegramWebhookController.receiveWebhook': { access: 'public' },

  'TransactionsController.create': { access: 'protected' },
  'TransactionsController.list': { access: 'protected' },
  'TransactionsController.remove': { access: 'protected' },
  'TransactionsController.update': { access: 'protected' },

  'UsersController.updateTheme': { access: 'protected' },
} satisfies Record<string, ExpectedAccess>;

const reflector = new Reflector();

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isClassType(value: unknown): value is ClassType {
  return (
    typeof value === 'function' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { prototype?: unknown }).prototype === 'object'
  );
}

function arrayMetadata(key: string, target: object): unknown[] {
  const value = Reflect.getMetadata(key, target) as unknown;
  return Array.isArray(value) ? value : [];
}

function registeredControllers(rootModule: ClassType): ClassType[] {
  const controllers = new Set<ClassType>();
  const visited = new Set<unknown>();

  const addControllers = (candidates: unknown) => {
    if (!Array.isArray(candidates)) return;
    for (const candidate of candidates) {
      if (isClassType(candidate)) controllers.add(candidate);
    }
  };

  const visit = (rawReference: unknown) => {
    let reference = rawReference;
    if (isRecord(reference) && typeof reference.forwardRef === 'function') {
      reference = (reference.forwardRef as () => unknown)();
    }
    if (reference === null || reference === undefined || visited.has(reference)) return;
    visited.add(reference);

    if (isRecord(reference) && 'module' in reference) {
      addControllers(reference.controllers);
      if (Array.isArray(reference.imports)) {
        for (const imported of reference.imports) visit(imported);
      }
      visit(reference.module);
      return;
    }
    if (!isClassType(reference)) return;

    addControllers(arrayMetadata(MODULE_METADATA.CONTROLLERS, reference));
    for (const imported of arrayMetadata(MODULE_METADATA.IMPORTS, reference)) {
      visit(imported);
    }
  };

  visit(rootModule);
  return [...controllers].sort((left, right) => left.name.localeCompare(right.name));
}

function controllerHandlers(controller: ClassType): AppRoute[] {
  const methodNames = new Set<string>();
  let prototype: object | null = controller.prototype;

  while (prototype !== null && prototype !== Object.prototype) {
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName !== 'constructor') methodNames.add(methodName);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  const handlers = controller.prototype as unknown as Record<string, unknown>;
  return [...methodNames]
    .sort()
    .flatMap((methodName): AppRoute[] => {
      const handler = handlers[methodName];
      if (
        typeof handler !== 'function' ||
        !Reflect.hasMetadata(METHOD_METADATA, handler)
      ) {
        return [];
      }
      return [
        {
          key: `${controller.name}.${methodName}`,
          controller,
          handler: handler as Handler,
        },
      ];
    });
}

function discoverAppRoutes(rootModule: ClassType): AppRoute[] {
  return registeredControllers(rootModule)
    .flatMap((controller) => controllerHandlers(controller))
    .sort((left, right) => left.key.localeCompare(right.key));
}

const appRoutes = discoverAppRoutes(AppModule);
const routesByKey = new Map(appRoutes.map((route) => [route.key, route]));

if (routesByKey.size !== appRoutes.length) {
  throw new Error('O AppModule registrou chaves de handler duplicadas.');
}

function routeFor(key: string): AppRoute {
  const route = routesByKey.get(key);
  if (!route) throw new Error(`Rota não registrada no AppModule: ${key}`);
  return route;
}

function isPublic(route: AppRoute) {
  return reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
    route.handler,
    route.controller,
  ]);
}

function allowsBlockedTenant(route: AppRoute) {
  return reflector.getAllAndOverride<boolean>(ALLOW_BLOCKED_TENANT_ACCESS_KEY, [
    route.handler,
    route.controller,
  ]);
}

function guardsFor(route: AppRoute) {
  const controllerGuards =
    (Reflect.getMetadata(GUARDS_METADATA, route.controller) as unknown[] | undefined) ?? [];
  const handlerGuards =
    (Reflect.getMetadata(GUARDS_METADATA, route.handler) as unknown[] | undefined) ?? [];
  return [...controllerGuards, ...handlerGuards];
}

function actualAccess(route: AppRoute): ExpectedAccess {
  return {
    access: isPublic(route) === true ? 'public' : 'protected',
    ...(allowsBlockedTenant(route) === true ? { allowBlockedTenant: true as const } : {}),
    ...(guardsFor(route).includes(TenantOwnerGuard) ? { ownerOnly: true as const } : {}),
  };
}

function handlerFor(key: string): Handler {
  return routeFor(key).handler;
}

function expectThrottle(key: string, limit: number) {
  const handler = handlerFor(key);
  expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, handler)).toBe(limit);
  expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, handler)).toBe(ONE_MINUTE_MS);
}

describe('metadados de acesso dos controllers', () => {
  it('Public marca o handler com a chave compartilhada', () => {
    class FixtureController {
      @Public()
      endpoint() {}
    }

    const route = {
      key: 'FixtureController.endpoint',
      controller: FixtureController,
      handler: FixtureController.prototype.endpoint,
    };
    expect(isPublic(route)).toBe(true);
  });

  it('AllowBlockedTenantAccess marca o handler com a chave canônica', () => {
    class FixtureController {
      @AllowBlockedTenantAccess()
      endpoint() {}
    }

    const route = {
      key: 'FixtureController.endpoint',
      controller: FixtureController,
      handler: FixtureController.prototype.endpoint,
    };
    expect(allowsBlockedTenant(route)).toBe(true);
  });

  it('deriva do AppModule exatamente todos os controllers e handlers revisados', () => {
    expect(appRoutes.map((route) => route.key)).toEqual(
      Object.keys(EXPECTED_ACCESS).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_ACCESS))(
    'mantém a classificação explícita de %s',
    (key, expected) => {
      expect(actualAccess(routeFor(key))).toEqual(expected);
    },
  );

  it('fecha o inventário com as contagens de política revisadas', () => {
    const policies: ExpectedAccess[] = Object.values(EXPECTED_ACCESS);
    expect({
      controllers: new Set(appRoutes.map((route) => route.controller)).size,
      handlers: appRoutes.length,
      public: policies.filter((policy) => policy.access === 'public').length,
      protected: policies.filter((policy) => policy.access === 'protected').length,
      allowBlockedTenant: policies.filter((policy) => policy.allowBlockedTenant).length,
      ownerOnly: policies.filter((policy) => policy.ownerOnly).length,
      protectedDefault: policies.filter(
        (policy) =>
          policy.access === 'protected' &&
          !policy.allowBlockedTenant &&
          !policy.ownerOnly,
      ).length,
      blockedOwnerOnly: policies.filter(
        (policy) => policy.allowBlockedTenant && policy.ownerOnly,
      ).length,
    }).toEqual({
      controllers: 21,
      handlers: 71,
      public: 18,
      protected: 53,
      allowBlockedTenant: 6,
      ownerOnly: 13,
      protectedDefault: 37,
      blockedOwnerOnly: 3,
    });
  });

  it('limita tentativas de login a 5 por minuto', () => {
    expectThrottle('AuthController.login', 5);
  });

  it('limita início, callback e desvínculo Google sem estrangular o retorno do provedor', () => {
    expectThrottle('AuthController.startGoogle', 10);
    expectThrottle('AuthController.googleCallback', 60);
    expectThrottle('AuthController.unlinkGoogle', 5);
  });

  it('exige Origin exata nas mutações Google e usa autenticação opcional nos handlers públicos', () => {
    expect(guardsFor(routeFor('AuthController.login'))).toContain(BrowserOriginGuard);
    expect(guardsFor(routeFor('AuthController.startGoogle'))).toEqual(
      expect.arrayContaining([BrowserOriginGuard, OptionalJwtAuthGuard]),
    );
    expect(guardsFor(routeFor('AuthController.googleCallback'))).toContain(
      OptionalJwtAuthGuard,
    );
    expect(guardsFor(routeFor('AuthController.unlinkGoogle'))).toContain(
      BrowserOriginGuard,
    );
  });

  it('limita cadastros de membros a 3 por minuto', () => {
    expectThrottle('MemberInvitesController.register', 3);
  });

  it('limita resolução e verificação pública de convites', () => {
    expectThrottle('MemberInvitesController.resolve', 30);
    expectThrottle('MemberInvitesController.confirmEmail', 10);
    expectThrottle('MemberInvitesController.resendEmail', 3);
    expectThrottle('MemberInvitesController.emailVerificationStatus', 30);
  });

  it('exige Origin exata em todas as mutações e consultas públicas com token de convite', () => {
    for (const key of [
      'MemberInvitesController.create',
      'MemberInvitesController.resolve',
      'MemberInvitesController.register',
      'MemberInvitesController.confirmEmail',
      'MemberInvitesController.resendEmail',
      'MemberInvitesController.emailVerificationStatus',
      'MemberInvitesController.revoke',
    ]) {
      expect(guardsFor(routeFor(key))).toContain(BrowserOriginGuard);
    }
  });

  it('exige Origin exata nas decisões e na inativação de membros', () => {
    for (const key of [
      'MemberApprovalsController.approve',
      'MemberApprovalsController.reject',
      'MembersController.deactivate',
    ]) {
      expect(guardsFor(routeFor(key))).toContain(BrowserOriginGuard);
    }
  });

  it('limita requisições do webhook Telegram a 60 por minuto', () => {
    expectThrottle('TelegramWebhookController.receiveWebhook', 60);
  });

  it('mantém o detalhamento de IA e as mutações de cobrança restritos ao owner', () => {
    for (const key of [
      'TelegramAuthCodesController.memberUsage',
      'PaymentsController.createCheckout',
      'PaymentsController.reconcileSubscription',
      'PaymentsController.cancelSubscription',
    ]) {
      expect(guardsFor(routeFor(key))).toContain(TenantOwnerGuard);
    }
  });
});
