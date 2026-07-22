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
        JWT_SECRET: 'x'.repeat(32),
        ABACATEPAY_DEV_API_KEY: 'dev-key',
        ABACATEPAY_DEV_MONTHLY_PRODUCT_ID: 'prod-monthly',
      }),
    ).toThrow();
  });
});
