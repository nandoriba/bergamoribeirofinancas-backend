import { z } from 'zod';

const optionalNonBlankString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(32).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().email().optional(),
);

const optionalPositiveInteger = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.coerce.number().int().positive().max(2_147_483_647).optional(),
);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8180),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  WEB_ORIGIN: z.string().default('http://127.0.0.1:8181'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GOOGLE_OAUTH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GOOGLE_CLIENT_ID: optionalNonBlankString,
  GOOGLE_CLIENT_SECRET: optionalNonBlankString,
  GOOGLE_REDIRECT_URI: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  OAUTH_ATTEMPT_SECRET: optionalSecret,
  OAUTH_ATTEMPT_KEY_VERSION: z.string().trim().min(1).max(32).default('v1'),
  OAUTH_ATTEMPT_TTL_SECONDS: z.coerce.number().int().min(120).max(600).default(300),
  OWNER_SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LEGAL_BUNDLE_VERSION: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).default('2026-08-01'),
  PENDING_PAYMENT_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  EMAIL_PROVIDER: z.enum(['disabled', 'resend']).default('disabled'),
  ACTION_TOKEN_SECRET: optionalSecret,
  EMAIL_OUTBOX_SECRET: optionalSecret,
  EMAIL_OUTBOX_KEY_VERSION: z.string().trim().min(1).max(32).default('v1'),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(10).max(120).default(30),
  ACTION_TOKEN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  ACTION_TOKEN_HOURLY_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
  ACTION_TOKEN_DAILY_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT: z.coerce.number().int().min(1).max(20).default(3),
  ACTION_TOKEN_RECIPIENT_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  EMAIL_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(600).default(60),
  EMAIL_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  RESEND_API_KEY: optionalNonBlankString,
  EMAIL_FROM: optionalNonBlankString,
  SUPPORT_EMAIL: optionalEmail,
  PUBLIC_API_ORIGIN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().default('http://127.0.0.1:8180'),
  ),
  INITIAL_ADMIN_EMAIL: z.string().email().default('admin@casaribeiro.local'),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).default('change-me-local'),
  INITIAL_ADMIN_NAME: z.string().default('Administrador Casa Ribeiro'),
  FAMILY_NAME: z.string().default('Casa Ribeiro'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_PUBLIC_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_DEV_POLLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AI_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  TELEGRAM_AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  TELEGRAM_PENDING_TTL_HOURS: z.coerce.number().int().positive().default(24),
  TELEGRAM_UNDO_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  TELEGRAM_MESSAGE_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  TELEGRAM_UPDATE_RECOVERY_MINUTES: z.coerce.number().int().positive().default(5),
  ABACATEPAY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ABACATEPAY_DEV_API_KEY: optionalNonBlankString,
  ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: optionalNonBlankString,
  ABACATEPAY_DEV_API_URL: z.string().url().default('https://api.abacatepay.com/v2'),
  ABACATEPAY_PROD_API_KEY: optionalNonBlankString,
  ABACATEPAY_PROD_MONTHLY_PRODUCT_ID: optionalNonBlankString,
  ABACATEPAY_PROD_API_URL: z.string().url().default('https://api.abacatepay.com/v2'),
  ABACATEPAY_MONTHLY_AMOUNT_CENTS: optionalPositiveInteger,
  ABACATEPAY_PLAN_NAME: z.string().trim().min(1).max(120).default('Plano familiar'),
  ABACATEPAY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  ABACATEPAY_RETRY_MAX: z.coerce.number().int().min(1).max(10).default(3),
  ABACATEPAY_RETRY_EVERY_DAYS: z.coerce.number().int().min(1).max(30).default(2),
  ABACATEPAY_CHECKOUT_LOCK_SECONDS: z.coerce.number().int().min(30).max(600).default(90),
  ABACATEPAY_WEBHOOK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ABACATEPAY_WEBHOOK_HMAC_MODE: z.literal('registered_secret').default('registered_secret'),
  ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ABACATEPAY_DEV_WEBHOOK_SECRET: optionalSecret,
  ABACATEPAY_PROD_WEBHOOK_SECRET: optionalSecret,
  ABACATEPAY_ENTITLEMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  ),
  ABACATEPAY_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
  RETENTION_CANCELLED_MONTHS: z.coerce.number().int().min(1).max(120).default(12),
  RETENTION_PURGE_BATCH_SIZE: z.coerce.number().int().min(1).max(250).default(50),
  RETENTION_PURGE_LEASE_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  RETENTION_PURGE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(48).default(48),
});

// Positive entitlement requires a versioned implementation backed by a real
// sandbox trace for HMAC, monthly boundaries, end-of-month and late retry.
// The empty allowlist makes an accidental flag flip fail during startup.
const supportedEntitlementContractVersions = new Set<string>();

const schema = baseSchema.superRefine((config, context) => {
  const webOrigins = config.WEB_ORIGIN.split(',').map((origin) => origin.trim());
  const parsedWebOrigins: URL[] = [];
  if (webOrigins.some((origin) => !origin)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_ORIGIN'],
      message: 'WEB_ORIGIN deve conter apenas origins não vazias separadas por vírgula.',
    });
  }

  for (const origin of webOrigins.filter(Boolean)) {
    try {
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        origin !== url.origin ||
        url.username ||
        url.password
      ) {
        throw new Error('Origin não canônica');
      }
      parsedWebOrigins.push(url);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_ORIGIN'],
        message: 'Cada WEB_ORIGIN deve ser uma origin HTTP(S) canônica, sem path, query, hash ou credenciais.',
      });
    }
  }

  if (new Set(webOrigins).size !== webOrigins.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_ORIGIN'],
      message: 'WEB_ORIGIN não deve repetir origins.',
    });
  }

  if (config.GOOGLE_OAUTH_ENABLED) {
    for (const key of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REDIRECT_URI',
      'OAUTH_ATTEMPT_SECRET',
    ] as const) {
      if (!config[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Configuração obrigatória quando o Google OAuth está habilitado.',
        });
      }
    }

    if (config.GOOGLE_REDIRECT_URI) {
      const redirectUri = new URL(config.GOOGLE_REDIRECT_URI);
      if (redirectUri.pathname !== '/auth/google/callback' || redirectUri.search || redirectUri.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_REDIRECT_URI'],
          message: 'O redirect URI deve apontar exatamente para /auth/google/callback e não conter query ou hash.',
        });
      }

      if (config.NODE_ENV === 'production' && redirectUri.protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_REDIRECT_URI'],
          message: 'O redirect URI do Google deve usar HTTPS em produção.',
        });
      }
    }
  }

  let publicApiOrigin: URL | undefined;
  try {
    publicApiOrigin = new URL(config.PUBLIC_API_ORIGIN);
    if (
      config.PUBLIC_API_ORIGIN !== publicApiOrigin.origin ||
      !['http:', 'https:'].includes(publicApiOrigin.protocol) ||
      publicApiOrigin.username ||
      publicApiOrigin.password
    ) {
      throw new Error('Origin não canônica');
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_API_ORIGIN'],
      message: 'PUBLIC_API_ORIGIN deve ser uma origin HTTP(S) canônica.',
    });
  }

  if (config.EMAIL_PROVIDER === 'resend') {
    for (const key of [
      'ACTION_TOKEN_SECRET',
      'EMAIL_OUTBOX_SECRET',
      'RESEND_API_KEY',
      'EMAIL_FROM',
    ] as const) {
      if (!config[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Configuração obrigatória para envio transacional por e-mail.',
        });
      }
    }

    if (config.EMAIL_FROM && !validEmailSender(config.EMAIL_FROM)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_FROM'],
        message: 'EMAIL_FROM deve conter um endereço de e-mail válido.',
      });
    }
  }

  if (config.OWNER_SIGNUP_ENABLED) {
    if (config.EMAIL_PROVIDER !== 'resend') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'O cadastro público exige o provedor de e-mail transacional Resend.',
      });
    }
    if (!config.SUPPORT_EMAIL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPPORT_EMAIL'],
        message: 'O cadastro público exige um canal de suporte explícito.',
      });
    }
    if (!config.ABACATEPAY_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_ENABLED'],
        message: 'O cadastro público exige checkout AbacatePay configurado.',
      });
    }
    if (!config.ABACATEPAY_ENTITLEMENT_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_ENTITLEMENT_ENABLED'],
        message: 'O cadastro público exige o contrato autoritativo de entitlement habilitado.',
      });
    }
    if (!config.ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED'],
        message:
          'O cadastro público exige prova no sandbox de expiração ou invalidação segura do checkout pendente.',
      });
    }
  }

  for (const key of ['ABACATEPAY_DEV_API_URL', 'ABACATEPAY_PROD_API_URL'] as const) {
    if (!isCanonicalAbacatePayApiUrl(config[key])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'A URL da AbacatePay deve ser exatamente a base HTTPS oficial /v2.',
      });
    }
  }

  for (const key of [
    'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID',
    'ABACATEPAY_PROD_MONTHLY_PRODUCT_ID',
  ] as const) {
    if (config[key] && !/^prod[_-][A-Za-z0-9_-]+$/.test(config[key])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'O produto mensal deve usar um identificador prod_ ou prod- válido da AbacatePay.',
      });
    }
  }

  if (config.ABACATEPAY_ENABLED) {
    if (!config.ABACATEPAY_MONTHLY_AMOUNT_CENTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_MONTHLY_AMOUNT_CENTS'],
        message: 'Informe o valor mensal esperado em centavos.',
      });
    }

    const requiredKeys =
      config.NODE_ENV === 'production'
        ? (['ABACATEPAY_PROD_API_KEY', 'ABACATEPAY_PROD_MONTHLY_PRODUCT_ID'] as const)
        : (['ABACATEPAY_DEV_API_KEY', 'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID'] as const);
    for (const key of requiredKeys) {
      if (!config[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Configuração obrigatória quando a integração AbacatePay está habilitada.',
        });
      }
    }
  }

  if (config.ABACATEPAY_WEBHOOK_ENABLED) {
    if (!config.ABACATEPAY_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_WEBHOOK_ENABLED'],
        message: 'O webhook exige a integração AbacatePay habilitada.',
      });
    }
    if (!config.ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED'],
        message: 'Confirme explicitamente o contrato de secret cadastrado e HMAC antes de habilitar.',
      });
    }
    const webhookSecret =
      config.NODE_ENV === 'production'
        ? config.ABACATEPAY_PROD_WEBHOOK_SECRET
        : config.ABACATEPAY_DEV_WEBHOOK_SECRET;
    if (!webhookSecret) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          config.NODE_ENV === 'production'
            ? 'ABACATEPAY_PROD_WEBHOOK_SECRET'
            : 'ABACATEPAY_DEV_WEBHOOK_SECRET',
        ],
        message: 'Informe um secret de webhook exclusivo para o ambiente atual.',
      });
    }
  }

  if (config.ABACATEPAY_ENTITLEMENT_ENABLED) {
    if (!config.ABACATEPAY_WEBHOOK_ENABLED || !config.ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_ENTITLEMENT_ENABLED'],
        message: 'Entitlement exige webhook habilitado e versão do contrato mensal comprovado.',
      });
    }
    if (
      config.ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION &&
      !supportedEntitlementContractVersions.has(config.ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION'],
        message:
          'Esta build não possui uma versão de contrato mensal comprovada e habilitável.',
      });
    }
  }

  if (
    config.ABACATEPAY_CHECKOUT_LOCK_SECONDS * 1_000 <
    config.ABACATEPAY_TIMEOUT_MS * 2 + 15_000
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ABACATEPAY_CHECKOUT_LOCK_SECONDS'],
      message: 'O lease do checkout deve cobrir consulta, criação, timeouts e margem operacional.',
    });
  }

  if (config.RETENTION_PURGE_LEASE_SECONDS < config.ABACATEPAY_CHECKOUT_LOCK_SECONDS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RETENTION_PURGE_LEASE_SECONDS'],
      message: 'A janela de segurança da retenção deve cobrir o lease do checkout.',
    });
  }

  if (
    config.NODE_ENV !== 'production' &&
    (config.ABACATEPAY_PROD_API_KEY ||
      config.ABACATEPAY_PROD_MONTHLY_PRODUCT_ID ||
      config.ABACATEPAY_PROD_WEBHOOK_SECRET)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ABACATEPAY_PROD_API_KEY'],
      message: 'Credenciais de produção não podem ser carregadas fora de produção.',
    });
  }

  if (config.ACTION_TOKEN_DAILY_LIMIT < config.ACTION_TOKEN_HOURLY_LIMIT) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACTION_TOKEN_DAILY_LIMIT'],
      message: 'O limite diário não pode ser menor que o limite por hora.',
    });
  }

  if (
    config.ACTION_TOKEN_RECIPIENT_DAILY_LIMIT <
    config.ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACTION_TOKEN_RECIPIENT_DAILY_LIMIT'],
      message: 'O limite diário por destinatário não pode ser menor que o limite por hora.',
    });
  }

  const shortestActionTokenTtlSeconds =
    Math.min(
      config.EMAIL_VERIFICATION_TTL_MINUTES,
      config.PASSWORD_RESET_TTL_MINUTES,
    ) * 60;
  if (config.EMAIL_RESEND_COOLDOWN_SECONDS >= shortestActionTokenTtlSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_RESEND_COOLDOWN_SECONDS'],
      message: 'O cooldown de reenvio deve ser menor que os TTLs de verificação e reset.',
    });
  }

  if (config.NODE_ENV !== 'production') return;

  for (const origin of parsedWebOrigins) {
    if (
      origin.protocol !== 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_ORIGIN'],
        message: 'WEB_ORIGIN deve usar HTTPS público em produção.',
      });
    }
  }

  if (!config.COOKIE_SECURE) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECURE'],
      message: 'Cookies de produção devem usar Secure.',
    });
  }

  if (
    config.EMAIL_PROVIDER === 'resend' &&
    publicApiOrigin &&
    (publicApiOrigin.protocol !== 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(publicApiOrigin.hostname))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_API_ORIGIN'],
      message: 'PUBLIC_API_ORIGIN deve usar HTTPS público em produção.',
    });
  }

  for (const key of [
    'ABACATEPAY_DEV_API_KEY',
    'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID',
    'ABACATEPAY_DEV_WEBHOOK_SECRET',
  ] as const) {
    if (config[key]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'Credenciais de sandbox não podem ser carregadas em produção.',
      });
    }
  }
});

export type AppConfig = z.infer<typeof schema>;

export function validateConfig(config: Record<string, unknown>) {
  return schema.parse(config);
}

export function configuration() {
  return validateConfig(process.env);
}

function validEmailSender(value: string): boolean {
  const trimmed = value.trim();
  const friendly = /^[^<>]{1,100}\s<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
  const address = friendly?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(trimmed) ? trimmed : undefined);
  return Boolean(address && z.string().email().safeParse(address).success);
}

function isCanonicalAbacatePayApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.abacatepay.com' &&
      url.port === '' &&
      url.pathname === '/v2' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      value === url.toString().replace(/\/$/, '')
    );
  } catch {
    return false;
  }
}
