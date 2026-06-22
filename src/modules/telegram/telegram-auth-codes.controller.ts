import { Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Roles } from '../../shared/role.decorator';
import { RolesGuard } from '../../shared/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TelegramService } from './telegram.service';

@Controller('telegram/auth-codes')
@UseGuards(JwtAuthGuard)
export class TelegramAuthCodesController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('group')
  @UseGuards(RolesGuard, ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Roles(UserRole.admin)
  createGroupCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createGroupAuthCode(user);
  }

  @Post('member')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createMemberCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createMemberAuthCode(user);
  }
}
