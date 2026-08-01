import { describe, expect, it } from 'vitest';

import { validateConfig } from './configuration';

describe('validateConfig', () => {
  const requiredConfig = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/finances',
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
      ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod-monthly',
    });

    expect(config.ABACATEPAY_DEV_API_KEY).toBe('dev-key');
    expect(config.ABACATEPAY_DEV_MONTHLY_PRODUCT_ID).toBe('prod-monthly');
  });

  it('rejeita credenciais de sandbox em produção', () => {
    expect(() =>
      validateConfig({
        ...requiredConfig,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_DEV_API_KEY: 'dev-key',
        ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod-monthly',
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
});
