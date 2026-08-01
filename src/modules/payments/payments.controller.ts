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

import { AllowPendingPaymentAccess } from '../../shared/allow-pending-payment-access.decorator';
import { CurrentUser } from '../../shared/current-user.decorator';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('subscription')
  @AllowPendingPaymentAccess()
  getSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.getSubscriptionSummary(user);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @AllowPendingPaymentAccess()
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  createCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _input: CreateCheckoutDto,
  ) {
    return this.payments.createCheckout(user);
  }
}
