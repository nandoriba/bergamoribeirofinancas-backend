import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IdentityProvider,
  LegalAcceptanceSource,
  PlatformRole,
  Prisma,
  ProfileStatus,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { assertPasswordFitsBcrypt, normalizeEmail } from './auth-security.util';
import { AuthService } from './auth.service';
import type { RegisterOwnerDto } from './dto/register-owner.dto';
import {
  UserActionTokenService,
  type VerificationMetadata,
} from './user-action-token.service';

const SERIALIZABLE_RETRIES = 3;

export class OwnerSignupConflictError extends Error {
  constructor() {
    super('Owner signup identity already exists.');
    this.name = 'OwnerSignupConflictError';
  }
}

export interface GoogleOwnerSignupInput {
  subject: string;
  email: string;
  ownerName: string;
  familyName: string;
  legalAcceptanceVersion: string;
  legalAcceptedAt: Date;
}

@Injectable()
export class OwnerOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly actionTokens: UserActionTokenService,
    private readonly authService: AuthService,
  ) {}

  publicConfig() {
    return {
      ownerSignupEnabled: this.config.get<boolean>('OWNER_SIGNUP_ENABLED') ?? false,
      googleEnabled: this.config.get<boolean>('GOOGLE_OAUTH_ENABLED') ?? false,
      legal: {
        version: this.legalBundleVersion(),
        termsPath: '/termos',
        privacyPath: '/privacidade',
      },
      supportEmail: this.config.get<string>('SUPPORT_EMAIL') ?? '',
    };
  }

  async registerLocalOwner(dto: RegisterOwnerDto): Promise<VerificationMetadata> {
    this.assertOwnerSignupEnabled();
    if ((this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') !== 'resend') {
      throw new ServiceUnavailableException('Cadastro por e-mail indisponível.');
    }
    this.assertLegalVersion(dto.legalAcceptanceVersion);
    assertPasswordFitsBcrypt(dto.password);

    const now = new Date();
    const familyId = randomUUID();
    const userId = randomUUID();
    const profileId = randomUUID();
    const email = normalizeEmail(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const verification = this.actionTokens.prepareEmailVerification(userId, email, now);
    const pendingPaymentExpiresAt = new Date(
      now.getTime() + (this.config.get<number>('PENDING_PAYMENT_TTL_DAYS') ?? 7) * 24 * 60 * 60_000,
    );

    try {
      await this.withSerializableRetry(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (existing) throw new OwnerSignupConflictError();

        await tx.family.create({
          data: {
            id: familyId,
            name: dto.familyName,
            pendingPaymentExpiresAt,
          },
        });
        await tx.user.create({
          data: {
            id: userId,
            email,
            passwordHash,
            name: dto.ownerName,
            platformRole: PlatformRole.user,
            isActive: true,
            emailVerifiedAt: null,
            familyId,
          },
        });
        await tx.memberProfile.create({
          data: {
            id: profileId,
            displayName: dto.ownerName,
            status: ProfileStatus.active,
            userId,
            familyId,
          },
        });
        await tx.legalAcceptance.create({
          data: {
            userId,
            familyId,
            bundleVersion: this.legalBundleVersion(),
            source: LegalAcceptanceSource.local,
            acceptedAt: now,
          },
        });
        await this.actionTokens.createPrepared(tx, verification);
        await tx.family.update({
          where: { id: familyId },
          data: { ownerUserId: userId },
        });
      });
    } catch (error) {
      if (error instanceof OwnerSignupConflictError || isUniqueConflict(error)) {
        throw new ConflictException('Não foi possível concluir o cadastro.');
      }
      throw error;
    }

    this.actionTokens.dispatchPrepared(verification);
    return this.actionTokens.verificationMetadata(verification);
  }

  async confirmEmailVerification(challengeId: string, code: string) {
    const userId = await this.actionTokens.confirmEmailVerification(challengeId, code);
    return this.authService.createSessionForUserId(userId);
  }

  async completeGoogleOwnerSignup(input: GoogleOwnerSignupInput) {
    this.assertOwnerSignupEnabled();
    this.assertLegalVersion(input.legalAcceptanceVersion);
    if (!validSignupName(input.ownerName, 80) || !validSignupName(input.familyName, 100)) {
      throw new OwnerSignupConflictError();
    }

    const now = new Date();
    const acceptanceMaxAgeMs =
      ((this.config.get<number>('OAUTH_ATTEMPT_TTL_SECONDS') ?? 300) + 60) * 1_000;
    if (
      !Number.isFinite(input.legalAcceptedAt.getTime()) ||
      input.legalAcceptedAt > now ||
      input.legalAcceptedAt < new Date(now.getTime() - acceptanceMaxAgeMs)
    ) {
      throw new OwnerSignupConflictError();
    }

    const familyId = randomUUID();
    const userId = randomUUID();
    const profileId = randomUUID();
    const email = normalizeEmail(input.email);
    const pendingPaymentExpiresAt = new Date(
      now.getTime() + (this.config.get<number>('PENDING_PAYMENT_TTL_DAYS') ?? 7) * 24 * 60 * 60_000,
    );

    try {
      await this.withSerializableRetry(async (tx) => {
        const [existingUser, existingIdentity] = await Promise.all([
          tx.user.findUnique({ where: { email }, select: { id: true } }),
          tx.userIdentity.findUnique({
            where: {
              provider_providerSubject: {
                provider: IdentityProvider.google,
                providerSubject: input.subject,
              },
            },
            select: { id: true },
          }),
        ]);
        if (existingUser || existingIdentity) throw new OwnerSignupConflictError();

        await tx.family.create({
          data: {
            id: familyId,
            name: input.familyName,
            pendingPaymentExpiresAt,
          },
        });
        await tx.user.create({
          data: {
            id: userId,
            email,
            passwordHash: null,
            name: input.ownerName,
            platformRole: PlatformRole.user,
            isActive: true,
            emailVerifiedAt: now,
            familyId,
          },
        });
        await tx.memberProfile.create({
          data: {
            id: profileId,
            displayName: input.ownerName,
            status: ProfileStatus.active,
            userId,
            familyId,
          },
        });
        await tx.userIdentity.create({
          data: {
            provider: IdentityProvider.google,
            providerSubject: input.subject,
            observedEmail: email,
            userId,
          },
        });
        await tx.legalAcceptance.create({
          data: {
            userId,
            familyId,
            bundleVersion: this.legalBundleVersion(),
            source: LegalAcceptanceSource.google,
            acceptedAt: input.legalAcceptedAt,
          },
        });
        await tx.family.update({
          where: { id: familyId },
          data: { ownerUserId: userId },
        });
      });
    } catch (error) {
      if (error instanceof OwnerSignupConflictError || isUniqueConflict(error)) {
        throw new OwnerSignupConflictError();
      }
      throw error;
    }

    return this.authService.createSessionForUserId(userId);
  }

  private legalBundleVersion(): string {
    return this.config.get<string>('LEGAL_BUNDLE_VERSION') ?? '2026-08-01';
  }

  private assertLegalVersion(version: string) {
    if (version !== this.legalBundleVersion()) {
      throw new ConflictException('Os documentos legais foram atualizados. Revise e aceite novamente.');
    }
  }

  private assertOwnerSignupEnabled() {
    if (!(this.config.get<boolean>('OWNER_SIGNUP_ENABLED') ?? false)) {
      throw new ServiceUnavailableException('Cadastro temporariamente indisponível.');
    }
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRIES - 1) throw error;
      }
    }
    throw new Error('Unreachable transaction retry state');
  }
}

function validSignupName(value: string, maxLength: number): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return (
    normalized === value &&
    normalized.length >= 2 &&
    normalized.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
  );
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function isRetryableTransactionError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2034');
}
