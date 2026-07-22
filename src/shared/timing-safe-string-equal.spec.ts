import { describe, expect, it } from 'vitest';

import { timingSafeStringEqual } from './timing-safe-string-equal';

describe('timingSafeStringEqual', () => {
  it('retorna true para strings idênticas', () => {
    expect(timingSafeStringEqual('telegram-webhook-secret', 'telegram-webhook-secret')).toBe(true);
  });

  it('retorna false para strings diferentes com o mesmo comprimento', () => {
    expect(timingSafeStringEqual('telegram-webhook-secret-a', 'telegram-webhook-secret-b')).toBe(false);
  });

  it('retorna false sem lançar erro quando os comprimentos diferem', () => {
    expect(() => timingSafeStringEqual('short', 'a-longer-secret')).not.toThrow();
    expect(timingSafeStringEqual('short', 'a-longer-secret')).toBe(false);
  });

  it('retorna false quando um ou ambos os valores estão ausentes', () => {
    expect(timingSafeStringEqual(undefined, 'secret')).toBe(false);
    expect(timingSafeStringEqual('secret', undefined)).toBe(false);
    expect(timingSafeStringEqual(undefined, undefined)).toBe(false);
  });
});
