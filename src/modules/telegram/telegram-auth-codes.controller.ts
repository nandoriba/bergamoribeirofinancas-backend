import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramAuthCodesController {
  constructor(private readonly telegramService: TelegramService) {}

  @Get('status')
  status(@CurrentTenant() context: TenantContext) {
    return this.telegramService.getStatus(context);
  }

  @Post('auth-codes/group')
  @UseGuards(TenantOwnerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createGroupCode(@CurrentTenant() context: TenantContext) {
    return this.telegramService.createGroupAuthCode(context);
  }

  @Post('auth-codes/member')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createMemberCode(@CurrentTenant() context: TenantContext) {
    return this.telegramService.createMemberAuthCode(context);
  }
}
