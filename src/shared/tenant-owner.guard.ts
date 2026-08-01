import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../modules/auth/auth.types';

@Injectable()
export class TenantOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return request.user?.tenantRole === 'owner';
  }
}
