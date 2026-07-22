import { Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Roles } from '../../shared/role.decorator';
import { RolesGuard } from '../../shared/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TelegramService } from './telegram.service';

@Controller('telegram/auth-codes')
export class TelegramAuthCodesController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('group')
  @UseGuards(RolesGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Roles(UserRole.admin)
  createGroupCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createGroupAuthCode(user);
  }

  @Post('member')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createMemberCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createMemberAuthCode(user);
  }
}
