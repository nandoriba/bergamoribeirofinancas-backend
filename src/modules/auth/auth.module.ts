import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { ActionTokenCryptoService } from './action-token-crypto.service';
import { BrowserOriginGuard } from './browser-origin.guard';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleOidcClient } from './google-oidc.client';
import { MemberInviteOnboardingService } from './member-invite-onboarding.service';
import { OAuthAttemptCryptoService } from './oauth-attempt-crypto.service';
import { OwnerOnboardingController } from './owner-onboarding.controller';
import { OwnerOnboardingService } from './owner-onboarding.service';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { EmailOutboxService } from './email-outbox.service';
import { ResendEmailProvider } from './resend-email.provider';
import { TRANSACTIONAL_EMAIL_PROVIDER } from './transactional-email.provider';
import { UserActionTokenService } from './user-action-token.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '7d',
        },
      }),
    }),
  ],
  controllers: [AuthController, OwnerOnboardingController],
  providers: [
    AuthService,
    ActionTokenCryptoService,
    BrowserOriginGuard,
    EmailOutboxService,
    GoogleOAuthService,
    GoogleOidcClient,
    JwtStrategy,
    MemberInviteOnboardingService,
    OAuthAttemptCryptoService,
    OwnerOnboardingService,
    OptionalJwtAuthGuard,
    ResendEmailProvider,
    UserActionTokenService,
    {
      provide: TRANSACTIONAL_EMAIL_PROVIDER,
      useExisting: ResendEmailProvider,
    },
  ],
  exports: [AuthService, BrowserOriginGuard, MemberInviteOnboardingService],
})
export class AuthModule {}
