import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override handleRequest<TUser>(error: Error | null, user: TUser | false | null): TUser | undefined {
    if (error instanceof UnauthorizedException) return undefined;
    if (error) throw error;
    return user || undefined;
  }
}
