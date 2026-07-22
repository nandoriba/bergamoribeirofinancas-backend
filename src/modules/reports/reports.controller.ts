import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('monthly')
  monthly(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('family') family?: string,
  ) {
    return this.reportsService.monthly(user, { month, from, to, family: family !== 'false' });
  }
}
