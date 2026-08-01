import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ALLOW_BLOCKED_TENANT_ACCESS_KEY } from "../../shared/allow-blocked-tenant-access.decorator";
import { IS_PUBLIC_KEY } from "../../shared/public.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets))
      return true;
    if (
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_BLOCKED_TENANT_ACCESS_KEY,
        targets,
      )
    ) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const decision = request.user?.subscriptionAccess;
    if (decision?.accessAllowed === true) return true;

    const code =
      decision?.effectiveStatus === "cancelled"
        ? "SUBSCRIPTION_CANCELLED"
        : decision?.effectiveStatus === "suspended"
          ? "SUBSCRIPTION_SUSPENDED"
          : decision?.effectiveStatus === "pending_payment"
            ? "PAYMENT_REQUIRED"
            : "SUBSCRIPTION_ACCESS_UNAVAILABLE";

    throw new ForbiddenException({
      code,
      message: "A assinatura não permite acesso a este recurso.",
    });
  }
}
