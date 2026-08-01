import { Logger, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  it('never exposes an unknown provider error message, stack, code or token in a 500 response', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    const error = new Error('code=secret-code id_token=secret-token');

    new AllExceptionsFilter().catch(error, host);

    expect(status).toHaveBeenCalledWith(500);
    const payload = json.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ statusCode: 500, message: 'Erro interno' });
    expect(JSON.stringify(payload)).not.toContain('secret-code');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });
});
