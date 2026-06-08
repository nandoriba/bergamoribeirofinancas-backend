import { Controller, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Roles } from '../../shared/role.decorator';
import { RolesGuard } from '../../shared/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobsService } from './jobs.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('monthly-openings')
  @Roles('admin')
  generateOpenings(@CurrentUser() user: AuthenticatedUser, @Query('month') month?: string) {
    return this.jobsService.generateMonthlyOpenings(user.familyId, month);
  }
}
