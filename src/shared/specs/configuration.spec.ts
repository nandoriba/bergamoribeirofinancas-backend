import { describe, expect, it } from 'vitest';

import { validateConfig } from '../configuration';

describe('validateConfig', () => {
  const requiredConfig = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/finances',
  };
  const abacatePayDevConfig = {
    ABACATEPAY_ENABLED: 'true',
    ABACATEPAY_DEV_API_KEY: 'dev-key',
    ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod_monthly',
    ABACATEPAY_MONTHLY_AMOUNT_CENTS: '2990',
  };

  it('rejeita secrets JWT menores que 32 caracteres', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(31),
      }),
    ).toThrow();
  });

  it('aceita um secret JWT com exatamente 32 caracteres', () => {
    const jwtSecret = 'x'.repeat(32);

    expect(
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: jwtSecret,
      }).JWT_SECRET,
    ).toBe(jwtSecret);
  });

  it('trata configuração vazia do sandbox como ausente', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
      ABACATEPAY_DEV_API_KEY: '',
      ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: '   ',
    });

    expect(config.ABACATEPAY_DEV_API_KEY).toBeUndefined();
    expect(config.ABACATEPAY_DEV_MONTHLY_PRODUCT_ID).toBeUndefined();
  });

  it('aceita credenciais do sandbox fora de produção', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
      ABACATEPAY_DEV_API_KEY: 'dev-key',
      ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod_monthly',
    });

    expect(config.ABACATEPAY_DEV_API_KEY).toBe('dev-key');
    expect(config.ABACATEPAY_DEV_MONTHLY_PRODUCT_ID).toBe('prod_monthly');
  });

  it('rejeita credenciais de sandbox em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_DEV_API_KEY: 'dev-key',
        ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod_monthly',
      }),
    ).toThrow();
  });

  it('exige cookies Secure em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
        JWT_SECRET: 'x'.repeat(32),
      }),
    ).toThrow();
  });

  it('falha cedo quando o Google OAuth é habilitado sem credenciais completas', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        GOOGLE_OAUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
      }),
    ).toThrow();
  });

  it('aceita configuração Google completa em desenvolvimento', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
      GOOGLE_OAUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8180/auth/google/callback',
      OAUTH_ATTEMPT_SECRET: 'o'.repeat(32),
    });

    expect(config.GOOGLE_OAUTH_ENABLED).toBe(true);
    expect(config.OAUTH_ATTEMPT_TTL_SECONDS).toBe(300);
  });

  it.each([
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://app.example.com?debug=true',
    'https://user@app.example.com',
    'ftp://app.example.com',
    'https://app.example.com,,https://admin.example.com',
  ])('rejeita WEB_ORIGIN não canônica: %s', (webOrigin) => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        WEB_ORIGIN: webOrigin,
      }),
    ).toThrow();
  });

  it('exige WEB_ORIGIN HTTPS público e explícito em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
      }),
    ).toThrow();

    expect(
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        WEB_ORIGIN: 'https://app.example.com',
      }).WEB_ORIGIN,
    ).toBe('https://app.example.com');
  });

  it('rejeita redirect Google sem HTTPS em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        GOOGLE_OAUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        GOOGLE_REDIRECT_URI: 'http://api.example.com/auth/google/callback',
        OAUTH_ATTEMPT_SECRET: 'o'.repeat(32),
      }),
    ).toThrow();
  });

  it('mantém cadastro público fechado por padrão', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
    });

    expect(config.OWNER_SIGNUP_ENABLED).toBe(false);
    expect(config.EMAIL_PROVIDER).toBe('disabled');
    expect(config.ABACATEPAY_ENABLED).toBe(false);
  });

  it('carrega franquia e pricing decimal auditável da IA com defaults do plano', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
    });

    expect(config).toMatchObject({
      TELEGRAM_AI_PLAN_CODE: 'monthly-card-v1',
      TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT: 200,
      TELEGRAM_AI_WARNING_PERCENT: 80,
      OPENAI_PRICING_VERSION: 'openai-gpt-4o-mini-2026-08-01',
      OPENAI_INPUT_USD_PER_MILLION_TOKENS: '0.15',
      OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: '0.60',
    });
  });

  it.each([
    ['limite zero', { TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT: '0' }],
    ['alerta sem proximidade', { TELEGRAM_AI_WARNING_PERCENT: '100' }],
    ['preço negativo', { OPENAI_INPUT_USD_PER_MILLION_TOKENS: '-0.15' }],
    ['preço exponencial', { OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: '6e-1' }],
    ['versão de pricing inválida', { OPENAI_PRICING_VERSION: 'pricing com espaço' }],
  ])('rejeita configuração inválida de consumo da IA: %s', (_label, invalid) => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...invalid,
      }),
    ).toThrow();
  });

  it('falha cedo quando a AbacatePay é habilitada sem produto, chave ou preço', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it('aceita checkout CARD mensal com credenciais exclusivas do ambiente de teste', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
      ...abacatePayDevConfig,
    });

    expect(config).toMatchObject({
      ABACATEPAY_ENABLED: true,
      ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod_monthly',
      ABACATEPAY_MONTHLY_AMOUNT_CENTS: 2990,
      ABACATEPAY_RETRY_MAX: 3,
      ABACATEPAY_RETRY_EVERY_DAYS: 2,
    });
  });

  it('rejeita valor mensal que não cabe no inteiro persistido pelo PostgreSQL', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...abacatePayDevConfig,
        ABACATEPAY_MONTHLY_AMOUNT_CENTS: '2147483648',
      }),
    ).toThrow();
  });

  it('aceita somente as credenciais e o produto mensais de produção no ambiente produtivo', () => {
    const config = validateConfig({
      ...requiredConfig,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_SECRET: 'x'.repeat(32),
      WEB_ORIGIN: 'https://app.example.com',
      ABACATEPAY_ENABLED: 'true',
      ABACATEPAY_PROD_API_KEY: 'prod-key',
      ABACATEPAY_PROD_MONTHLY_PRODUCT_ID: 'prod_monthly_live',
      ABACATEPAY_MONTHLY_AMOUNT_CENTS: '2990',
    });

    expect(config).toMatchObject({
      ABACATEPAY_ENABLED: true,
      ABACATEPAY_PROD_MONTHLY_PRODUCT_ID: 'prod_monthly_live',
      ABACATEPAY_MONTHLY_AMOUNT_CENTS: 2990,
    });
    expect(config.ABACATEPAY_DEV_API_KEY).toBeUndefined();
  });

  it('rejeita identificador de produto que não segue o contrato prod_', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...abacatePayDevConfig,
        ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'monthly-plan',
      }),
    ).toThrow();
  });

  it('rejeita lease que possa expirar durante consulta e criação do checkout', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_TIMEOUT_MS: '30000',
        ABACATEPAY_CHECKOUT_LOCK_SECONDS: '60',
      }),
    ).toThrow();
  });

  it('rejeita credenciais de produção fora de produção e URL de API não oficial', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_PROD_API_KEY: 'prod-secret',
      }),
    ).toThrow();

    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_DEV_API_URL: 'https://evil.example/v2',
      }),
    ).toThrow();
  });

  it('rejeita credenciais de desenvolvimento no ambiente de produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        WEB_ORIGIN: 'https://app.example.com',
        ABACATEPAY_DEV_API_KEY: 'dev-key',
        ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod_monthly',
      }),
    ).toThrow();
  });

  it('falha cedo quando cadastro público é ativado sem e-mail e suporte', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        OWNER_SIGNUP_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it('falha cedo quando Resend não possui todos os segredos e remetente', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_secret',
      }),
    ).toThrow();
  });

  it('rejeita onboarding enquanto esta build não suporta contrato positivo comprovado', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        OWNER_SIGNUP_ENABLED: 'true',
        EMAIL_PROVIDER: 'resend',
        ACTION_TOKEN_SECRET: 'a'.repeat(32),
        EMAIL_OUTBOX_SECRET: 'e'.repeat(32),
        RESEND_API_KEY: 're_secret',
        EMAIL_FROM: 'Finanças <hello@example.com>',
        SUPPORT_EMAIL: 'support@example.com',
        PUBLIC_API_ORIGIN: 'http://127.0.0.1:8180',
        ...abacatePayDevConfig,
        ABACATEPAY_WEBHOOK_ENABLED: 'true',
        ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: 'true',
        ABACATEPAY_DEV_WEBHOOK_SECRET: 'w'.repeat(32),
        ABACATEPAY_ENTITLEMENT_ENABLED: 'true',
        ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION: 'sandbox-contract-v1',
      }),
    ).toThrow();
  });

  it('mantém webhook e entitlement desabilitados por padrão', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
    });

    expect(config).toMatchObject({
      ABACATEPAY_WEBHOOK_ENABLED: false,
      ABACATEPAY_WEBHOOK_HMAC_MODE: 'registered_secret',
      ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: false,
      ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED: false,
      ABACATEPAY_ENTITLEMENT_ENABLED: false,
      RETENTION_CANCELLED_MONTHS: 12,
      RETENTION_PURGE_MAX_AGE_HOURS: 48,
    });
  });

  it('mantém o cadastro bloqueado sem prova de expiração do checkout pendente', () => {
    try {
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        OWNER_SIGNUP_ENABLED: 'true',
        EMAIL_PROVIDER: 'resend',
        ACTION_TOKEN_SECRET: 'a'.repeat(32),
        EMAIL_OUTBOX_SECRET: 'e'.repeat(32),
        RESEND_API_KEY: 're_secret',
        EMAIL_FROM: 'Finanças <hello@example.com>',
        SUPPORT_EMAIL: 'support@example.com',
        PUBLIC_API_ORIGIN: 'http://127.0.0.1:8180',
        ...abacatePayDevConfig,
        ABACATEPAY_WEBHOOK_ENABLED: 'true',
        ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: 'true',
        ABACATEPAY_DEV_WEBHOOK_SECRET: 'w'.repeat(32),
        ABACATEPAY_ENTITLEMENT_ENABLED: 'true',
        ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION: 'sandbox-contract-v1',
      });
      throw new Error('A configuração deveria ter sido rejeitada.');
    } catch (error) {
      const issues = (error as { issues?: Array<{ path?: unknown[] }> }).issues;
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED'],
          }),
        ]),
      );
    }
  });

  it('rejeita webhook sem confirmação e secret registrado do ambiente', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...abacatePayDevConfig,
        ABACATEPAY_WEBHOOK_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it('aceita shadow webhook sem habilitar entitlement positivo', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
      ...abacatePayDevConfig,
      ABACATEPAY_WEBHOOK_ENABLED: 'true',
      ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: 'true',
      ABACATEPAY_DEV_WEBHOOK_SECRET: 'h'.repeat(32),
    });

    expect(config).toMatchObject({
      ABACATEPAY_WEBHOOK_ENABLED: true,
      ABACATEPAY_ENTITLEMENT_ENABLED: false,
    });
  });

  it('rejeita entitlement sem versão do contrato mensal e modos HMAC alternativos', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...abacatePayDevConfig,
        ABACATEPAY_WEBHOOK_ENABLED: 'true',
        ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: 'true',
        ABACATEPAY_DEV_WEBHOOK_SECRET: 'h'.repeat(32),
        ABACATEPAY_ENTITLEMENT_ENABLED: 'true',
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ...abacatePayDevConfig,
        ABACATEPAY_WEBHOOK_ENABLED: 'true',
        ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: 'true',
        ABACATEPAY_DEV_WEBHOOK_SECRET: 'h'.repeat(32),
        ABACATEPAY_ENTITLEMENT_ENABLED: 'true',
        ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION: 'unproven-v1',
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_WEBHOOK_HMAC_MODE: 'public_key',
      }),
    ).toThrow();
  });

  it('rejeita cooldown que possa sobreviver ao código ou link emitido', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        EMAIL_VERIFICATION_TTL_MINUTES: '5',
        PASSWORD_RESET_TTL_MINUTES: '10',
        EMAIL_RESEND_COOLDOWN_SECONDS: '600',
      }),
    ).toThrow();
  });

  it('valida limites persistentes por destinatário e aplica defaults seguros', () => {
    const config = validateConfig({
      ...requiredConfig,
      JWT_SECRET: 'x'.repeat(32),
    });
    expect(config).toMatchObject({
      ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT: 3,
      ACTION_TOKEN_RECIPIENT_DAILY_LIMIT: 10,
    });
    expect(() =>
      validateConfig({
        ...requiredConfig,
        JWT_SECRET: 'x'.repeat(32),
        ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT: '4',
        ACTION_TOKEN_RECIPIENT_DAILY_LIMIT: '3',
      }),
    ).toThrow();
  });

  it.each(['version with spaces', '../legal', '', 'x'.repeat(65)])(
    'rejeita versão legal ambígua ou fora do limite: %s',
    (version) => {
      expect(() =>
        validateConfig({
          ...requiredConfig,
          JWT_SECRET: 'x'.repeat(32),
          LEGAL_BUNDLE_VERSION: version,
        }),
      ).toThrow();
    },
  );

  it('exige PUBLIC_API_ORIGIN HTTPS público quando e-mail está ativo em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        WEB_ORIGIN: 'https://app.example.com',
        EMAIL_PROVIDER: 'resend',
        ACTION_TOKEN_SECRET: 'a'.repeat(32),
        EMAIL_OUTBOX_SECRET: 'e'.repeat(32),
        RESEND_API_KEY: 're_secret',
        EMAIL_FROM: 'hello@example.com',
        PUBLIC_API_ORIGIN: 'http://127.0.0.1:8180',
      }),
    ).toThrow();
  });
});
