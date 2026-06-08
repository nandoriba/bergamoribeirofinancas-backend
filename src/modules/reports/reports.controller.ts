import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('monthly')
  monthly(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('family') family?: string,
  ) {
    return this.reportsService.monthly(user, { month, family: family !== 'false' });
  }
}
