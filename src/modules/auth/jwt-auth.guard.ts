import {
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import {
  ALLOW_PENDING_PAYMENT_ACCESS_KEY,
} from '../../shared/allow-pending-payment-access.decorator';
import { IS_PUBLIC_KEY } from '../../shared/public.decorator';
import type { AuthenticatedUser } from './auth.types';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isAuthenticated = await super.canActivate(context);
    if (!isAuthenticated) return false;

    const allowsPendingPayment = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_PAYMENT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();

    if (
      request.user &&
      request.user.requiredAction !== null &&
      !allowsPendingPayment
    ) {
      throw new ForbiddenException({
        code: 'PAYMENT_REQUIRED',
        message: 'Pagamento pendente',
      });
    }

    return true;
  }
}
