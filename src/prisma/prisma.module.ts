import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { TenantScopeService } from './tenant-scope.service';

@Global()
@Module({
  providers: [PrismaService, TenantScopeService],
  exports: [PrismaService, TenantScopeService],
})
export class PrismaModule {}
