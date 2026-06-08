import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Roles } from '../../shared/role.decorator';
import { RolesGuard } from '../../shared/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { RegisterWithInviteDto } from './dto/register-with-invite.dto';
import { MemberInvitesService } from './member-invites.service';

@Controller('member-invites')
export class MemberInvitesController {
  constructor(private readonly memberInvitesService: MemberInvitesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMemberInviteDto) {
    return this.memberInvitesService.create(user, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.memberInvitesService.list(user);
  }

  @Get(':token')
  getPublic(@Param('token') token: string) {
    return this.memberInvitesService.getPublic(token);
  }

  @Post('register')
  register(@Body() dto: RegisterWithInviteDto) {
    return this.memberInvitesService.register(dto);
  }
}

