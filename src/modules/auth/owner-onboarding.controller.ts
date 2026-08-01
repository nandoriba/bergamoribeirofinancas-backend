import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../shared/public.decorator';
import { AuthService } from './auth.service';
import { BrowserOriginGuard } from './browser-origin.guard';
import { ConfirmEmailVerificationDto } from './dto/confirm-email-verification.dto';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResendEmailVerificationDto } from './dto/resend-email-verification.dto';
import { OwnerOnboardingService } from './owner-onboarding.service';
import { UserActionTokenService } from './user-action-token.service';

@Controller('auth')
export class OwnerOnboardingController {
  constructor(
    private readonly onboarding: OwnerOnboardingService,
    private readonly actionTokens: UserActionTokenService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('onboarding/config')
  @Public()
  onboardingConfig(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.onboarding.publicConfig();
  }

  @Post('signup/owner')
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async registerOwner(@Body() dto: RegisterOwnerDto) {
    const verification = await this.onboarding.registerLocalOwner(dto);
    return { verification };
  }

  @Post('email-verification/confirm')
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async confirmEmail(
    @Body() dto: ConfirmEmailVerificationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.onboarding.confirmEmailVerification(dto.challengeId, dto.code);
    this.authService.setSessionCookie(response, session.token);
    response.setHeader('Cache-Control', 'no-store');
    return { user: session.user };
  }

  @Post('email-verification/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async resendEmail(@Body() dto: ResendEmailVerificationDto) {
    const verification = await this.actionTokens.resendEmailVerification(dto.challengeId);
    return { verification };
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    await this.actionTokens.requestPasswordReset(dto.email);
    return { ok: true } as const;
  }

  @Get('password-reset/continue')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async continuePasswordReset(
    @Query('token') rawToken: unknown,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const token = typeof rawToken === 'string' && rawToken.length <= 128 ? rawToken : '';
    const valid = await this.actionTokens.validatePasswordResetToken(token);

    if (valid) {
      this.actionTokens.setPasswordResetCookie(response, token, valid.expiresAt);
      return response.redirect(303, this.frontendUrl('/redefinir-senha'));
    }

    this.actionTokens.clearPasswordResetCookie(response);
    return response.redirect(303, this.frontendUrl('/redefinir-senha', { status: 'invalid' }));
  }

  @Post('password-reset/confirm')
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async confirmPasswordReset(
    @Body() dto: ConfirmPasswordResetDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const rawToken = cookies?.[this.actionTokens.passwordResetCookieName()];
    await this.actionTokens.confirmPasswordReset(
      typeof rawToken === 'string' ? rawToken : '',
      dto.password,
      dto.passwordConfirmation,
    );
    this.actionTokens.clearPasswordResetCookie(response);
    this.authService.clearSessionCookie(response);
    response.setHeader('Cache-Control', 'no-store');
    return { ok: true } as const;
  }

  private frontendUrl(path: string, query?: Record<string, string>) {
    const origin = this.config.getOrThrow<string>('WEB_ORIGIN').split(',')[0]?.trim();
    if (!origin) throw new Error('WEB_ORIGIN ausente');
    const url = new URL(origin);
    url.pathname = path;
    url.search = '';
    url.hash = '';
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }
}
