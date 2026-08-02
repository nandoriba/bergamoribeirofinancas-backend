import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { BrowserOriginGuard } from '../browser-origin.guard';

function setup(origin?: string) {
  const config = {
    getOrThrow: vi.fn().mockReturnValue('https://app.example.com,http://127.0.0.1:8181'),
  } as unknown as ConfigService;
  const request = { get: vi.fn().mockReturnValue(origin) };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard: new BrowserOriginGuard(config), context };
}

describe('BrowserOriginGuard', () => {
  it.each(['https://app.example.com', 'http://127.0.0.1:8181'])('accepts configured exact origin %s', (origin) => {
    const { guard, context } = setup(origin);

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each([undefined, 'null', 'https://attacker.example', 'https://app.example.com.attacker.example'])(
    'rejects absent or cross-site origin %s',
    (origin) => {
      const { guard, context } = setup(origin);

      expect(() => guard.canActivate(context)).toThrow(new ForbiddenException('Origem não permitida'));
    },
  );
});
