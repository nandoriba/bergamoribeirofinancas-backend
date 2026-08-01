import { Controller, Get, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { MonthlyReportQueryDto } from './dto/monthly-report-query.dto';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('monthly')
  monthly(
    @CurrentTenant() context: TenantContext,
    @Query() query: MonthlyReportQueryDto,
  ) {
    return this.reportsService.monthly(context, {
      month: query.month,
      from: query.from,
      to: query.to,
      profileId: query.profileId,
      family: query.family ?? true,
    });
  }
}
