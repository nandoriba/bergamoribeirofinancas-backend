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
});
