import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import type { TenantContext } from '../../shared/tenant-context';

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService,
  ) {}

  listFamilyProfiles(context: TenantContext) {
    return this.prisma.memberProfile.findMany({
      where: {
        ...this.tenantScope.byFamily(context),
        // Perfis inativos preservam histórico financeiro; solicitações pendentes não entram no seletor.
        status: { in: ['active', 'inactive'] },
      },
      select: {
        id: true,
        displayName: true,
        status: true,
      },
      orderBy: { displayName: 'asc' },
    });
  }
}
