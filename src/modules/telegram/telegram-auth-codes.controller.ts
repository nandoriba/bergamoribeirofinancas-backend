import { Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../shared/current-user.decorator';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TelegramService } from './telegram.service';

@Controller('telegram/auth-codes')
export class TelegramAuthCodesController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('group')
  @UseGuards(TenantOwnerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createGroupCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createGroupAuthCode(user);
  }

  @Post('member')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createMemberCode(@CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createMemberAuthCode(user);
  }
}
