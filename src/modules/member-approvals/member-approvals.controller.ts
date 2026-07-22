import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Roles } from '../../shared/role.decorator';
import { RolesGuard } from '../../shared/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MemberApprovalsService } from './member-approvals.service';

@Controller('member-approvals')
@UseGuards(RolesGuard)
@Roles(UserRole.admin)
export class MemberApprovalsController {
  constructor(private readonly memberApprovalsService: MemberApprovalsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.memberApprovalsService.list(user);
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.memberApprovalsService.approve(user, id);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.memberApprovalsService.reject(user, id);
  }
}
