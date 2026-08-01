import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from '../modules/auth/auth.types';
import { TenantContext } from './tenant-context';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  return TenantContext.fromAuthenticatedUser(request.user);
});
