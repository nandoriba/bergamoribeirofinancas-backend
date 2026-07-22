import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('referenceMonth') referenceMonth?: string,
    @Query('month') month?: string,
    @Query('profileId') profileId?: string,
    @Query('family') family?: string,
  ) {
    return this.dashboardService.getDashboard(user, {
      referenceMonth: referenceMonth || month,
      profileId,
      family: family !== 'false',
    });
  }
}
