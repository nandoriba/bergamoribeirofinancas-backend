import { describe, expect, it } from 'vitest';

import {
  nestApplicationOptions,
  webhookSafeNestApplicationOptions,
} from './nest-application-options';

describe('nestApplicationOptions', () => {
  it('preserva o corpo bruto e mantém buffer dos logs de inicialização', () => {
    expect(nestApplicationOptions).toMatchObject({
      rawBody: true,
      bufferLogs: true,
    });
  });

  it('desativa o parser implícito no bootstrap seguro do webhook', () => {
    expect(webhookSafeNestApplicationOptions).toMatchObject({
      rawBody: true,
      bufferLogs: true,
      bodyParser: false,
    });
  });
});
