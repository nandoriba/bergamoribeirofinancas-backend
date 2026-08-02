import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { OptionalJwtAuthGuard } from '../optional-jwt-auth.guard';

describe('OptionalJwtAuthGuard', () => {
  const guard = new OptionalJwtAuthGuard();

  it('treats an expired or stale authenticated principal as an anonymous request', () => {
    expect(guard.handleRequest(new UnauthorizedException('Sessão inválida'), false)).toBeUndefined();
    expect(guard.handleRequest(null, false)).toBeUndefined();
  });

  it('preserves a valid optional principal and rethrows non-authentication failures', () => {
    const user = { id: 'user-1' };

    expect(guard.handleRequest(null, user)).toBe(user);
    expect(() => guard.handleRequest(new Error('database unavailable'), false)).toThrow(
      'database unavailable',
    );
  });
});
