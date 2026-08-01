import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Public } from '../../shared/public.decorator';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { ConfirmInviteEmailDto } from './dto/confirm-invite-email.dto';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { RegisterWithInviteDto } from './dto/register-with-invite.dto';
import { ResendInviteEmailDto } from './dto/resend-invite-email.dto';
import { ResolveMemberInviteDto } from './dto/resolve-member-invite.dto';
import { MemberInvitesService } from './member-invites.service';

@Controller('member-invites')
export class MemberInvitesController {
  constructor(private readonly memberInvitesService: MemberInvitesService) {}

  @Post()
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMemberInviteDto) {
    return this.memberInvitesService.create(user, dto);
  }

  @Get()
  @UseGuards(TenantOwnerGuard)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.memberInvitesService.list(user);
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  resolve(@Body() dto: ResolveMemberInviteDto) {
    return this.memberInvitesService.resolve(dto.token);
  }

  @Post('register')
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  register(@Body() dto: RegisterWithInviteDto) {
    return this.memberInvitesService.register(dto);
  }

  @Post('email-verification/confirm')
  @HttpCode(HttpStatus.OK)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  confirmEmail(@Body() dto: ConfirmInviteEmailDto) {
    return this.memberInvitesService.confirmEmail(dto.challengeId, dto.code);
  }

  @Post('email-verification/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  resendEmail(@Body() dto: ResendInviteEmailDto) {
    return this.memberInvitesService.resendEmail(dto.challengeId);
  }

  @Post('email-verification/status')
  @HttpCode(HttpStatus.OK)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  emailVerificationStatus(@Body() dto: ResendInviteEmailDto) {
    return this.memberInvitesService.emailVerificationStatus(dto.challengeId);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BrowserOriginGuard, TenantOwnerGuard)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.memberInvitesService.revoke(user, id);
  }
}
