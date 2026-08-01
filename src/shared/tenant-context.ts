import { UnauthorizedException } from '@nestjs/common';
import type { PlatformRole } from '@prisma/client';

import type { AuthenticatedUser, TenantRole } from '../modules/auth/auth.types';

/**
 * Contexto de autorização de tenant criado somente a partir da sessão revalidada.
 * IDs recebidos em rota ou payload nunca devem ser usados para construir este objeto.
 */
export class TenantContext {
  readonly userId: string;
  readonly familyId: string;
  readonly authorProfileId: string;
  readonly platformRole: PlatformRole;
  readonly tenantRole: TenantRole;

  private constructor(user: AuthenticatedUser) {
    this.userId = user.id;
    this.familyId = user.familyId;
    this.authorProfileId = user.profileId;
    this.platformRole = user.platformRole;
    this.tenantRole = user.tenantRole;
    Object.freeze(this);
  }

  static fromAuthenticatedUser(user?: AuthenticatedUser): TenantContext {
    if (
      !user?.id ||
      !user.familyId ||
      !user.profileId ||
      !user.platformRole ||
      (user.tenantRole !== 'owner' && user.tenantRole !== 'member')
    ) {
      throw new UnauthorizedException('Sessão de tenant inválida');
    }

    return new TenantContext(user);
  }
}
