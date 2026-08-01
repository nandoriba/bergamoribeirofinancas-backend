import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { BrowserOriginGuard } from './browser-origin.guard';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleOidcClient } from './google-oidc.client';
import { OAuthAttemptCryptoService } from './oauth-attempt-crypto.service';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
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
  controllers: [AuthController],
  providers: [
    AuthService,
    BrowserOriginGuard,
    GoogleOAuthService,
    GoogleOidcClient,
    JwtStrategy,
    OAuthAttemptCryptoService,
    OptionalJwtAuthGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
