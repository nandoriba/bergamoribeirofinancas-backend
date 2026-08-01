import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { IdentityProvider, OAuthIntent, Prisma } from '@prisma/client';
import type { CookieOptions } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { timingSafeStringEqual } from '../../shared/timing-safe-string-equal';
import type { AuthenticatedUser } from './auth.types';
import { AuthService } from './auth.service';
import type { StartGoogleOAuthDto } from './dto/start-google-oauth.dto';
import { GoogleOidcClient, type VerifiedGoogleIdentity } from './google-oidc.client';
import { OAuthAttemptCryptoService } from './oauth-attempt-crypto.service';
import { OwnerOnboardingService, OwnerSignupConflictError } from './owner-onboarding.service';

const GOOGLE_PROVIDER = IdentityProvider.google;
const RANDOM_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AUTHORIZATION_CODE_LENGTH = 4_096;
const OAUTH_ATTEMPT_CLEANUP_BATCH_SIZE = 250;
const OAUTH_ATTEMPT_CLEANUP_MAX_BATCHES = 4;
const OAUTH_ATTEMPT_CLEANUP_INTERVAL_MS = 60_000;
const CONSUMED_ATTEMPT_RETENTION_MS = 10 * 60 * 1_000;
const ALLOWED_LOGIN_RETURN_PATHS = new Set([
  '/',
  '/lancamentos',
  '/importar',
  '/categorias',
  '/faturas',
  '/recorrentes',
  '/parcelamentos',
  '/relatorios',
  '/configuracoes',
  '/contas',
]);

type CallbackReason = 'not_linked' | 'account_exists' | 'cancelled' | 'failed';

interface GoogleOAuthAttemptContext {
  authenticatedUserId: string | null;
  returnPath: string | null;
  signupOwnerName: string | null;
  signupFamilyName: string | null;
  legalAcceptanceVersion: string | null;
  legalAcceptedAt: Date | null;
}

class GoogleOAuthFlowError extends Error {
  constructor(readonly reason: CallbackReason) {
    super('Fluxo OAuth não concluído.');
    this.name = 'GoogleOAuthFlowError';
  }
}

export interface GoogleOAuthStartResult {
  authorizationUrl: string;
  bindingCookie: {
    name: string;
    value: string;
    options: CookieOptions;
  };
}

export interface GoogleOAuthCallbackInput {
  state?: string;
  code?: string;
  providerError?: string;
  browserBinding?: string;
  currentUser?: AuthenticatedUser;
}

export interface GoogleOAuthCallbackResult {
  redirectUrl: string;
  token?: string;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private cleanupInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly ownerOnboarding: OwnerOnboardingService,
    private readonly oidcClient: GoogleOidcClient,
    private readonly crypto: OAuthAttemptCryptoService,
    private readonly config: ConfigService,
  ) {}

  async start(dto: StartGoogleOAuthDto, currentUser?: AuthenticatedUser): Promise<GoogleOAuthStartResult> {
    if (!this.oidcClient.isEnabled()) {
      throw new ServiceUnavailableException('Login com Google indisponível.');
    }

    const attemptContext = await this.validateStartContext(dto, currentUser);
    const secrets = this.crypto.generateAttemptSecrets();
    const persistedSecrets = this.crypto.prepareForPersistence(secrets);
    const authorizationUrl = await this.oidcClient.createAuthorizationUrl({
      state: secrets.state,
      nonce: secrets.nonce,
      codeChallenge: secrets.pkceChallenge,
    });
    const ttlSeconds = this.config.get<number>('OAUTH_ATTEMPT_TTL_SECONDS') ?? 300;

    // A manutenção é best-effort e nunca participa do caminho crítico de criação da tentativa.
    void this.runCleanup(false);
    await this.prisma.oAuthAttempt.create({
      data: {
        ...persistedSecrets,
        intent: dto.intent,
        ...attemptContext,
        expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
      },
    });

    return {
      authorizationUrl,
      bindingCookie: {
        name: this.crypto.cookieNameForState(secrets.state),
        value: secrets.browserBinding,
        options: this.bindingCookieOptions(ttlSeconds * 1_000),
      },
    };
  }

  async complete(input: GoogleOAuthCallbackInput): Promise<GoogleOAuthCallbackResult> {
    let errorPath = '/login';

    try {
      const state = this.validRandomValue(input.state);
      const stateHash = this.crypto.hashState(state);
      const attempt = await this.prisma.oAuthAttempt.findUnique({
        where: { stateHash },
      });
      if (!attempt) throw new GoogleOAuthFlowError('failed');

      errorPath =
        attempt.intent === OAuthIntent.link_account
          ? '/configuracoes'
          : attempt.intent === OAuthIntent.signup_owner
            ? '/cadastro'
            : '/login';
      const browserBinding = this.validRandomValue(input.browserBinding);
      const browserBindingHash = this.crypto.hashBrowserBinding(browserBinding);
      if (
        !timingSafeStringEqual(attempt.browserBindingHash, browserBindingHash) ||
        attempt.consumedAt ||
        attempt.expiresAt <= new Date()
      ) {
        throw new GoogleOAuthFlowError('failed');
      }

      if (
        attempt.intent === OAuthIntent.link_account &&
        (!input.currentUser || input.currentUser.id !== attempt.authenticatedUserId)
      ) {
        throw new GoogleOAuthFlowError('failed');
      }
      if (attempt.intent === OAuthIntent.signup_owner && input.currentUser) {
        throw new GoogleOAuthFlowError('failed');
      }

      const claimed = await this.prisma.oAuthAttempt.updateMany({
        where: {
          id: attempt.id,
          stateHash,
          browserBindingHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) throw new GoogleOAuthFlowError('failed');

      if (input.providerError) {
        throw new GoogleOAuthFlowError(input.providerError === 'access_denied' ? 'cancelled' : 'failed');
      }

      const code = this.validAuthorizationCode(input.code);
      const codeVerifier = this.crypto.decryptPkceVerifier({
        pkceVerifierCiphertext: attempt.pkceVerifierCiphertext,
        pkceVerifierKeyVersion: attempt.pkceVerifierKeyVersion,
      });
      const identity = await this.oidcClient.exchangeCode({
        code,
        codeVerifier,
      });
      if (!this.crypto.nonceMatchesHash(identity.nonce, attempt.nonceHash)) {
        throw new GoogleOAuthFlowError('failed');
      }

      if (attempt.intent === OAuthIntent.login) {
        const session = await this.completeLogin(identity);
        return {
          token: session.token,
          redirectUrl: this.frontendUrl(
            session.user.requiredAction === 'payment' ? '/pagamento/pendente' : (attempt.returnPath ?? '/'),
          ),
        };
      }

      if (
        attempt.intent === OAuthIntent.signup_owner &&
        attempt.signupOwnerName &&
        attempt.signupFamilyName &&
        attempt.legalAcceptanceVersion &&
        attempt.legalAcceptedAt
      ) {
        try {
          const session = await this.ownerOnboarding.completeGoogleOwnerSignup({
            subject: identity.subject,
            email: identity.email,
            ownerName: attempt.signupOwnerName,
            familyName: attempt.signupFamilyName,
            legalAcceptanceVersion: attempt.legalAcceptanceVersion,
            legalAcceptedAt: attempt.legalAcceptedAt,
          });
          return {
            token: session.token,
            redirectUrl: this.frontendUrl('/pagamento/pendente'),
          };
        } catch (error) {
          if (error instanceof OwnerSignupConflictError) {
            throw new GoogleOAuthFlowError('account_exists');
          }
          throw error;
        }
      }

      if (attempt.intent === OAuthIntent.link_account && attempt.authenticatedUserId) {
        const session = await this.completeLink(attempt.authenticatedUserId, identity);
        return {
          token: session.token,
          redirectUrl: this.frontendUrl('/configuracoes', {
            oauth: 'success',
            action: 'linked',
          }),
        };
      }

      throw new GoogleOAuthFlowError('failed');
    } catch (error) {
      const reason = error instanceof GoogleOAuthFlowError ? error.reason : 'failed';
      return {
        redirectUrl: this.frontendUrl(errorPath, { oauth: 'error', reason }),
      };
    }
  }

  async getMethods(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        identities: {
          where: { provider: GOOGLE_PROVIDER },
          select: { observedEmail: true },
          take: 1,
        },
      },
    });
    if (!user) throw new UnauthorizedException();

    const googleIdentity = user.identities[0];
    const passwordEnabled = Boolean(user.passwordHash);
    return {
      password: { enabled: passwordEnabled },
      google: {
        linked: Boolean(googleIdentity),
        observedEmail: googleIdentity?.observedEmail,
        canUnlink: Boolean(googleIdentity && passwordEnabled),
        unlinkBlockedReason: googleIdentity && !passwordEnabled ? 'local_password_required' : undefined,
      },
    };
  }

  async unlink(userId: string, currentPassword: string) {
    await this.authService.confirmCurrentPassword(userId, currentPassword);

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { passwordHash: true },
        });
        if (!user?.passwordHash) throw new ConflictException('Mantenha ao menos um método de acesso.');

        return tx.userIdentity.deleteMany({
          where: { userId, provider: GOOGLE_PROVIDER },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (deleted.count !== 1) throw new ConflictException('Conta Google não vinculada.');

    return this.authService.createSessionForUserId(userId);
  }

  @Interval('oauth-attempt-cleanup', OAUTH_ATTEMPT_CLEANUP_INTERVAL_MS)
  async cleanupStaleAttempts(): Promise<void> {
    await this.runCleanup(true);
  }

  private async runCleanup(logFailure: boolean): Promise<void> {
    if (this.cleanupInProgress) return;
    this.cleanupInProgress = true;

    try {
      await this.deleteStaleAttemptBatches(OAUTH_ATTEMPT_CLEANUP_MAX_BATCHES);
    } catch (error) {
      if (logFailure) {
        const errorType = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn(`OAuth attempt cleanup failed (${errorType})`);
      }
    } finally {
      this.cleanupInProgress = false;
    }
  }

  bindingCookieName(state: unknown): string | undefined {
    if (typeof state !== 'string' || !RANDOM_VALUE_PATTERN.test(state)) return undefined;
    return this.crypto.cookieNameForState(state);
  }

  bindingCookieOptions(maxAge?: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
      sameSite: 'lax',
      path: '/',
      ...(maxAge === undefined ? {} : { maxAge }),
    };
  }

  private async validateStartContext(
    dto: StartGoogleOAuthDto,
    currentUser?: AuthenticatedUser,
  ): Promise<GoogleOAuthAttemptContext> {
    if (dto.intent === OAuthIntent.login) {
      if (currentUser || dto.currentPassword || this.hasOwnerSignupFields(dto)) {
        throw new BadRequestException('Dados incompatíveis com o fluxo de login.');
      }
      return this.attemptContext({
        returnPath: this.resolveLoginReturnPath(dto.returnPath),
      });
    }

    if (dto.intent === OAuthIntent.link_account) {
      if (!currentUser) throw new UnauthorizedException();
      if (!dto.currentPassword) throw new BadRequestException('Confirme sua senha atual.');
      if (this.hasOwnerSignupFields(dto)) {
        throw new BadRequestException('Dados incompatíveis com o vínculo de conta.');
      }
      if (dto.returnPath && dto.returnPath !== '/configuracoes') {
        throw new BadRequestException('Destino de retorno inválido.');
      }
      await this.authService.confirmCurrentPassword(currentUser.id, dto.currentPassword);
      const methods = await this.getMethods(currentUser.id);
      if (methods.google.linked) throw new ConflictException('Conta Google já vinculada.');
      return this.attemptContext({
        authenticatedUserId: currentUser.id,
        returnPath: '/configuracoes',
      });
    }

    if (dto.intent === OAuthIntent.signup_owner) {
      if (!(this.config.get<boolean>('OWNER_SIGNUP_ENABLED') ?? false)) {
        throw new ServiceUnavailableException('Cadastro temporariamente indisponível.');
      }
      if (currentUser || dto.currentPassword !== undefined || dto.returnPath !== undefined) {
        throw new BadRequestException('Dados incompatíveis com o cadastro.');
      }

      const ownerName = this.normalizedSignupName(dto.ownerName, 80);
      const familyName = this.normalizedSignupName(dto.familyName, 100);
      const currentLegalVersion = this.config.get<string>('LEGAL_BUNDLE_VERSION') ?? '2026-08-01';
      if (!ownerName || !familyName) {
        throw new BadRequestException('Informe os nomes do responsável e da família.');
      }
      if (dto.legalAcceptanceVersion !== currentLegalVersion) {
        throw new ConflictException('Revise os dados e documentos legais antes de continuar.');
      }

      return this.attemptContext({
        signupOwnerName: ownerName,
        signupFamilyName: familyName,
        legalAcceptanceVersion: currentLegalVersion,
        legalAcceptedAt: new Date(),
      });
    }

    throw new BadRequestException('Intenção OAuth indisponível nesta etapa.');
  }

  private attemptContext(overrides: Partial<GoogleOAuthAttemptContext> = {}): GoogleOAuthAttemptContext {
    return {
      authenticatedUserId: null,
      returnPath: null,
      signupOwnerName: null,
      signupFamilyName: null,
      legalAcceptanceVersion: null,
      legalAcceptedAt: null,
      ...overrides,
    };
  }

  private hasOwnerSignupFields(dto: StartGoogleOAuthDto): boolean {
    return dto.ownerName !== undefined || dto.familyName !== undefined || dto.legalAcceptanceVersion !== undefined;
  }

  private normalizedSignupName(value: string | undefined, maxLength: number): string | undefined {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (normalized.length < 2 || normalized.length > maxLength) {
      return undefined;
    }
    return normalized;
  }

  private resolveLoginReturnPath(returnPath?: string) {
    if (!returnPath) return '/';
    if (!ALLOWED_LOGIN_RETURN_PATHS.has(returnPath)) {
      throw new BadRequestException('Destino de retorno inválido.');
    }
    return returnPath;
  }

  private async completeLogin(identity: VerifiedGoogleIdentity) {
    const linkedIdentity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: GOOGLE_PROVIDER,
          providerSubject: identity.subject,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            isActive: true,
            profile: { select: { status: true } },
          },
        },
      },
    });

    if (!linkedIdentity) throw new GoogleOAuthFlowError('not_linked');
    if (!linkedIdentity.user.isActive || linkedIdentity.user.profile?.status !== 'active') {
      throw new GoogleOAuthFlowError('failed');
    }

    await this.prisma.userIdentity.update({
      where: { id: linkedIdentity.id },
      data: { observedEmail: identity.email, lastUsedAt: new Date() },
    });
    return this.authService.createSessionForUserId(linkedIdentity.user.id);
  }

  private async completeLink(userId: string, identity: VerifiedGoogleIdentity) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              isActive: true,
              profile: { select: { status: true } },
            },
          });
          if (!user || !user.isActive || user.profile?.status !== 'active') {
            throw new GoogleOAuthFlowError('failed');
          }

          const [subjectIdentity, userIdentity] = await Promise.all([
            tx.userIdentity.findUnique({
              where: {
                provider_providerSubject: {
                  provider: GOOGLE_PROVIDER,
                  providerSubject: identity.subject,
                },
              },
            }),
            tx.userIdentity.findUnique({
              where: { userId_provider: { userId, provider: GOOGLE_PROVIDER } },
            }),
          ]);

          if (subjectIdentity || userIdentity) {
            throw new GoogleOAuthFlowError('failed');
          }

          await tx.userIdentity.create({
            data: {
              provider: GOOGLE_PROVIDER,
              providerSubject: identity.subject,
              observedEmail: identity.email,
              userId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch {
      throw new GoogleOAuthFlowError('failed');
    }

    return this.authService.createSessionForUserId(userId);
  }

  private async deleteStaleAttemptBatches(maxBatches: number) {
    const now = new Date();
    const consumedBefore = new Date(now.getTime() - CONSUMED_ATTEMPT_RETENTION_MS);
    const staleWhere: Prisma.OAuthAttemptWhereInput = {
      OR: [{ consumedAt: null, expiresAt: { lte: now } }, { consumedAt: { lte: consumedBefore } }],
    };

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const attempts = await this.prisma.oAuthAttempt.findMany({
        where: staleWhere,
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: OAUTH_ATTEMPT_CLEANUP_BATCH_SIZE,
      });
      if (attempts.length === 0) return;

      await this.prisma.oAuthAttempt.deleteMany({
        where: {
          id: { in: attempts.map((attempt) => attempt.id) },
          ...staleWhere,
        },
      });
      if (attempts.length < OAUTH_ATTEMPT_CLEANUP_BATCH_SIZE) return;
    }
  }

  private validRandomValue(value?: string) {
    if (!value || !RANDOM_VALUE_PATTERN.test(value)) throw new GoogleOAuthFlowError('failed');
    return value;
  }

  private validAuthorizationCode(value?: string) {
    if (!value || value.length > MAX_AUTHORIZATION_CODE_LENGTH || /[\r\n]/.test(value)) {
      throw new GoogleOAuthFlowError('failed');
    }
    return value;
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
