import { Controller, Get, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(
    @CurrentTenant() context: TenantContext,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.getDashboard(context, {
      referenceMonth: query.referenceMonth ?? query.month,
      profileId: query.profileId,
      family: query.family ?? true,
    });
  }
}
