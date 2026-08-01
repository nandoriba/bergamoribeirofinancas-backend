import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AllowBlockedTenantAccess } from '../../shared/allow-blocked-tenant-access.decorator';
import { CurrentUser } from '../../shared/current-user.decorator';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaymentsService } from './payments.service';
import { SubscriptionCancellationService } from './subscription-cancellation.service';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly cancellation: SubscriptionCancellationService,
  ) {}

  @Get('subscription')
  @AllowBlockedTenantAccess()
  getSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.getSubscriptionSummary(user);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @AllowBlockedTenantAccess()
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  createCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _input: CreateCheckoutDto,
  ) {
    return this.payments.createCheckout(user);
  }

  @Post('subscription/reconcile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @AllowBlockedTenantAccess()
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  reconcileSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.reconcileSubscription(user);
  }

  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @AllowBlockedTenantAccess()
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  async cancelSubscription(@CurrentUser() user: AuthenticatedUser) {
    await this.cancellation.cancel(user);
    return this.payments.getSubscriptionSummary(user);
  }
}
