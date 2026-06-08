import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('profileId') profileId?: string,
    @Query('family') family?: string,
  ) {
    return this.dashboardService.getDashboard(user, {
      month,
      profileId,
      family: family !== 'false',
    });
  }
}
