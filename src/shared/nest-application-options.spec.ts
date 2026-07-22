import { describe, expect, it } from 'vitest';

import { nestApplicationOptions } from './nest-application-options';

describe('nestApplicationOptions', () => {
  it('preserva o corpo bruto e mantém buffer dos logs de inicialização', () => {
    expect(nestApplicationOptions).toMatchObject({
      rawBody: true,
      bufferLogs: true,
    });
  });
});
