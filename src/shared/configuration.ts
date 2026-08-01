import { z } from 'zod';

const optionalNonBlankString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(32).optional(),
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
  ABACATEPAY_DEV_API_KEY: optionalNonBlankString,
  ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: optionalNonBlankString,
});

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

  for (const key of ['ABACATEPAY_DEV_API_KEY', 'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID'] as const) {
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
