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
        // Este endpoint alimenta o seletor de perfis disponíveis, não o histórico financeiro.
        status: 'active',
      },
      select: {
        id: true,
        displayName: true,
        status: true,
        user: {
          select: {
            email: true,
            platformRole: true,
          },
        },
      },
      orderBy: { displayName: 'asc' },
    });
  }
}
