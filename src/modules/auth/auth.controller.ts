import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser } from '../../shared/current-user.decorator';
import { Public } from '../../shared/public.decorator';
import { BrowserOriginGuard } from './browser-origin.guard';
import { LoginDto } from './dto/login.dto';
import { StartGoogleOAuthDto } from './dto/start-google-oauth.dto';
import { UnlinkGoogleDto } from './dto/unlink-google.dto';
import { GoogleOAuthService, type GoogleOAuthCallbackResult } from './google-oauth.service';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
  ) {}

  @Post('login')
  @Public()
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.authService.login(dto.email, dto.password);
    this.authService.setSessionCookie(response, result.token);
    return { user: result.user };
  }

  @Post('google/start')
  @Public()
  @UseGuards(BrowserOriginGuard, OptionalJwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async startGoogle(
    @Body() dto: StartGoogleOAuthDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.googleOAuthService.start(dto, user);
    response.cookie(result.bindingCookie.name, result.bindingCookie.value, result.bindingCookie.options);
    response.setHeader('Cache-Control', 'no-store');
    return { authorizationUrl: result.authorizationUrl };
  }

  @Get('google/callback')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async googleCallback(
    @Query('state') rawState: unknown,
    @Query('code') rawCode: unknown,
    @Query('error') rawProviderError: unknown,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const state = singleQueryValue(rawState);
    const cookieName = this.googleOAuthService.bindingCookieName(state);
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const browserBinding = cookieName ? singleQueryValue(cookies?.[cookieName]) : undefined;

    response.setHeader('Cache-Control', 'no-store');
    let result: GoogleOAuthCallbackResult;
    try {
      result = await this.googleOAuthService.complete({
        state,
        code: singleQueryValue(rawCode),
        providerError: singleQueryValue(rawProviderError),
        browserBinding,
        currentUser: user,
      });
    } finally {
      if (cookieName) response.clearCookie(cookieName, this.googleOAuthService.bindingCookieOptions());
    }

    if (result.token) this.authService.setSessionCookie(response, result.token);
    return response.redirect(303, result.redirectUrl);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  @Get('methods')
  methods(@CurrentUser() user: AuthenticatedUser) {
    return this.googleOAuthService.getMethods(user.id);
  }

  @Post('google/unlink')
  @UseGuards(BrowserOriginGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async unlinkGoogle(
    @Body() dto: UnlinkGoogleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.googleOAuthService.unlink(user.id, dto.currentPassword);
    this.authService.setSessionCookie(response, session.token);
    return { ok: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    this.authService.clearSessionCookie(response);
    return { ok: true };
  }
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
