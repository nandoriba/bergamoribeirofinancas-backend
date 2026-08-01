import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IdentityProvider,
  PlatformRole,
  Prisma,
  ProfileStatus,
  UserActionTokenPurpose,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import {
  evaluateSubscriptionProjection,
  SUBSCRIPTION_ACCESS_SELECT,
} from '../payments/subscription-access.projection';
import {
  INVITE_EMAIL_CONTINUATION_PATH,
} from './action-token-crypto.service';
import {
  assertPasswordFitsBcrypt,
  isInternalPendingEmail,
  maskEmail,
  normalizeEmail,
  pendingInviteEmail,
} from './auth-security.util';
import {
  type PreparedActionToken,
  UserActionTokenService,
  type VerificationMetadata,
} from './user-action-token.service';

const SERIALIZABLE_RETRIES = 3;
const INVITE_TOKEN_PATTERN = /^(?:[A-Fa-f0-9]{48}|[A-Za-z0-9_-]{43})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UsableInvite {
  id: string;
  familyId: string;
  email: string | null;
  expiresAt: Date;
  family: {
    name: string;
    currentSubscription: Parameters<typeof evaluateSubscriptionProjection>[0];
  };
}

export interface PrepareGoogleInviteAttemptInput {
  token: string;
  displayName: string;
}

export interface PreparedGoogleInviteAttempt {
  memberInviteId: string;
  inviteDisplayName: string;
}

export interface CompleteGoogleInviteAttemptInput {
  memberInviteId: string;
  inviteDisplayName: string;
  identity: {
    subject: string;
    email: string;
  };
}

export interface RegisterLocalInviteInput {
  token: string;
  name: string;
  email: string;
  password: string;
}

type InviteContinuation =
  | { status: 'verify_email'; verification: VerificationMetadata }
  | { status: 'pending_approval' };

@Injectable()
export class MemberInviteOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly actionTokens: UserActionTokenService,
  ) {}

  async resolve(token: string) {
    if (!INVITE_TOKEN_PATTERN.test(token)) {
      throw new NotFoundException('Convite inválido ou expirado.');
    }

    const resolved = await this.withSerializableRetry(async (tx) => {
      const now = new Date();
      const invite = await tx.memberInvite.findUnique({
        where: { token },
        select: {
          id: true,
          familyId: true,
          email: true,
          status: true,
          expiresAt: true,
          family: {
            select: {
              name: true,
              currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
            },
          },
        },
      });
      if (
        !invite ||
        !evaluateSubscriptionProjection(
          invite.family.currentSubscription,
          () => now,
        ).accessAllowed
      ) {
        return undefined;
      }

      const presentation = this.invitePresentation(invite);
      if (invite.status === 'active') {
        return invite.expiresAt > now ? presentation : undefined;
      }
      if (invite.status !== 'used') return undefined;

      const continuation = await this.resolveUsedInviteContinuation(
        tx,
        invite,
      );
      return continuation ? { ...presentation, continuation } : undefined;
    });

    if (!resolved) throw new NotFoundException('Convite inválido ou expirado.');
    return resolved;
  }

  async registerLocal(input: RegisterLocalInviteInput): Promise<{
    status: 'verify_email';
    verification: VerificationMetadata;
  }> {
    if ((this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') !== 'resend') {
      throw new ServiceUnavailableException('Aceite por e-mail temporariamente indisponível.');
    }

    const initialInvite = await this.findUsableInviteByToken(input.token);
    if (!initialInvite) throw invalidInviteError();

    const name = normalizedDisplayName(input.name);
    const email = validCanonicalEmail(input.email);
    if (!name || !email) throw invalidInviteError();
    assertPasswordFitsBcrypt(input.password);

    const userId = randomUUID();
    const profileId = randomUUID();
    const approvalId = randomUUID();
    const passwordHash = await bcrypt.hash(input.password, 12);
    let verification: PreparedActionToken | undefined;

    try {
      await this.withSerializableRetry(async (tx) => {
        const locked = await this.lockAndLoadInvite(
          tx,
          initialInvite.id,
          initialInvite.familyId,
        );
        const { invite, now } = locked;
        this.assertInviteAcceptable(invite, email, now);
        await this.assertNoPendingApprovalForEmail(tx, invite.familyId, email);
        await this.assertIdentityAvailable(tx, email);
        await this.actionTokens.assertEmailVerificationRecipientQuota(tx, email, now);
        await this.consumeInvite(tx, invite.id, invite.familyId, now);
        const prepared = this.actionTokens.prepareEmailVerification(
          userId,
          email,
          now,
          INVITE_EMAIL_CONTINUATION_PATH,
        );

        await tx.user.create({
          data: {
            id: userId,
            email: pendingInviteEmail(userId),
            passwordHash,
            name,
            platformRole: PlatformRole.user,
            isActive: false,
            emailVerifiedAt: null,
            familyId: invite.familyId,
          },
        });
        await tx.memberProfile.create({
          data: {
            id: profileId,
            displayName: name,
            status: ProfileStatus.pending,
            userId,
            familyId: invite.familyId,
          },
        });
        await tx.memberApproval.create({
          data: {
            id: approvalId,
            requestedName: name,
            requestedEmail: email,
            inviteId: invite.id,
            familyId: invite.familyId,
            userId,
          },
        });
        await this.actionTokens.createPrepared(tx, prepared);
        verification = prepared;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw inviteConflictError();
      throw error;
    }

    if (!verification) throw new Error('Verificação do convite não foi persistida.');
    this.actionTokens.dispatchPrepared(verification);
    return {
      status: 'verify_email',
      verification: this.actionTokens.verificationMetadata(verification),
    };
  }

  async confirmLocalEmail(challengeId: string, code: string) {
    await this.actionTokens.confirmPendingInviteEmailVerification(challengeId, code);
    return { status: 'pending_approval' as const };
  }

  async resendLocalEmail(challengeId: string) {
    const result =
      await this.actionTokens.resendPendingInviteEmailVerification(challengeId);
    return {
      status: 'verify_email' as const,
      ...result,
    };
  }

  statusLocalEmail(challengeId: string) {
    return this.actionTokens.pendingInviteEmailVerificationStatus(challengeId);
  }

  async prepareGoogleAttempt(
    input: PrepareGoogleInviteAttemptInput,
  ): Promise<PreparedGoogleInviteAttempt> {
    const invite = await this.findUsableInviteByToken(input.token);
    const inviteDisplayName = normalizedDisplayName(input.displayName);
    if (!invite || !inviteDisplayName) throw invalidInviteError();

    return {
      memberInviteId: invite.id,
      inviteDisplayName,
    };
  }

  async completeGoogleAttempt(input: CompleteGoogleInviteAttemptInput) {
    const initialInvite = await this.prisma.memberInvite.findUnique({
      where: { id: input.memberInviteId },
      select: { id: true, familyId: true },
    });
    const name = normalizedDisplayName(input.inviteDisplayName);
    const email = validCanonicalEmail(input.identity.email);
    if (
      !initialInvite ||
      !name ||
      !email ||
      !input.identity.subject ||
      input.identity.subject.length > 255
    ) {
      throw invalidInviteError();
    }

    const userId = randomUUID();
    const profileId = randomUUID();
    const approvalId = randomUUID();

    try {
      await this.withSerializableRetry(async (tx) => {
        const locked = await this.lockAndLoadInvite(
          tx,
          initialInvite.id,
          initialInvite.familyId,
        );
        const { invite, now } = locked;
        this.assertInviteAcceptable(invite, email, now);
        await this.assertNoPendingApprovalForEmail(tx, invite.familyId, email);
        await this.assertIdentityAvailable(tx, email, input.identity.subject);
        await this.consumeInvite(tx, invite.id, invite.familyId, now);

        await tx.user.create({
          data: {
            id: userId,
            email,
            passwordHash: null,
            name,
            platformRole: PlatformRole.user,
            isActive: false,
            emailVerifiedAt: now,
            familyId: invite.familyId,
          },
        });
        await tx.memberProfile.create({
          data: {
            id: profileId,
            displayName: name,
            status: ProfileStatus.pending,
            userId,
            familyId: invite.familyId,
          },
        });
        await tx.userIdentity.create({
          data: {
            provider: IdentityProvider.google,
            providerSubject: input.identity.subject,
            observedEmail: email,
            userId,
          },
        });
        await tx.memberApproval.create({
          data: {
            id: approvalId,
            requestedName: name,
            requestedEmail: email,
            inviteId: invite.id,
            familyId: invite.familyId,
            userId,
          },
        });
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw inviteConflictError();
      throw error;
    }

    return { status: 'pending_approval' as const };
  }

  private async findUsableInviteByToken(token: string): Promise<UsableInvite | undefined> {
    if (!INVITE_TOKEN_PATTERN.test(token)) return undefined;
    const invite = await this.prisma.memberInvite.findUnique({
      where: { token },
      select: {
        id: true,
        familyId: true,
        email: true,
        status: true,
        expiresAt: true,
        family: {
          select: {
            name: true,
            currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
          },
        },
      },
    });
    if (!this.usableInvite(invite, new Date())) return undefined;
    return invite;
  }

  private invitePresentation(invite: UsableInvite) {
    return {
      familyName: invite.family.name,
      emailHint: invite.email ? maskEmail(invite.email) : undefined,
      emailRestricted: Boolean(invite.email),
      expiresAt: invite.expiresAt,
      methods: {
        local: (this.config.get<string>('EMAIL_PROVIDER') ?? 'disabled') === 'resend',
        google: this.config.get<boolean>('GOOGLE_OAUTH_ENABLED') ?? false,
      },
    };
  }

  private async resolveUsedInviteContinuation(
    tx: Prisma.TransactionClient,
    invite: UsableInvite,
  ): Promise<InviteContinuation | undefined> {
    const approval = await tx.memberApproval.findUnique({
      where: { inviteId: invite.id },
      select: {
        id: true,
        inviteId: true,
        familyId: true,
        userId: true,
        status: true,
        requestedEmail: true,
      },
    });
    const requestedEmail = approval
      ? validCanonicalEmail(approval.requestedEmail)
      : undefined;
    if (
      !approval ||
      approval.status !== 'pending' ||
      approval.inviteId !== invite.id ||
      approval.familyId !== invite.familyId ||
      !approval.userId ||
      !requestedEmail ||
      (invite.email !== null && normalizeEmail(invite.email) !== requestedEmail)
    ) {
      return undefined;
    }

    const user = await tx.user.findUnique({
      where: { id: approval.userId },
      select: {
        id: true,
        familyId: true,
        email: true,
        passwordHash: true,
        platformRole: true,
        isActive: true,
        emailVerifiedAt: true,
        profile: { select: { familyId: true, status: true } },
        identities: { select: { id: true }, take: 1 },
      },
    });
    if (
      !user ||
      user.id !== approval.userId ||
      user.familyId !== invite.familyId ||
      user.platformRole !== PlatformRole.user ||
      user.isActive ||
      !user.profile ||
      user.profile.familyId !== invite.familyId ||
      user.profile.status !== ProfileStatus.pending
    ) {
      return undefined;
    }

    if (user.emailVerifiedAt) {
      return normalizeEmail(user.email) === requestedEmail
        ? { status: 'pending_approval' }
        : undefined;
    }
    if (
      normalizeEmail(user.email) !== pendingInviteEmail(user.id) ||
      !user.passwordHash ||
      user.identities.length !== 0
    ) {
      return undefined;
    }

    const verificationToken = await tx.userActionToken.findFirst({
      where: {
        userId: user.id,
        purpose: UserActionTokenPurpose.email_verification,
        consumedAt: null,
        deliveryEmail: { equals: requestedEmail, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        purpose: true,
        userId: true,
        deliveryEmail: true,
        expiresAt: true,
        createdAt: true,
        consumedAt: true,
      },
    });
    if (
      !verificationToken ||
      verificationToken.purpose !== UserActionTokenPurpose.email_verification ||
      verificationToken.userId !== user.id ||
      verificationToken.consumedAt ||
      normalizeEmail(verificationToken.deliveryEmail) !== requestedEmail
    ) {
      return undefined;
    }

    return {
      status: 'verify_email',
      verification:
        this.actionTokens.verificationMetadataFromPersistedToken(
          verificationToken,
        ),
    };
  }

  private async lockAndLoadInvite(
    tx: Prisma.TransactionClient,
    inviteId: string,
    familyId: string,
  ): Promise<{ invite: UsableInvite; now: Date }> {
    const familyLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Family" WHERE "id" = ${familyId} FOR UPDATE
    `;
    if (familyLock.length !== 1) throw invalidInviteError();

    const inviteLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "MemberInvite"
       WHERE "id" = ${inviteId} AND "familyId" = ${familyId}
       FOR UPDATE
    `;
    if (inviteLock.length !== 1) throw invalidInviteError();

    const invite = await tx.memberInvite.findFirst({
      where: { id: inviteId, familyId },
      select: {
        id: true,
        familyId: true,
        email: true,
        status: true,
        expiresAt: true,
        family: {
          select: {
            name: true,
            currentSubscription: { select: SUBSCRIPTION_ACCESS_SELECT },
          },
        },
      },
    });
    const now = new Date();
    if (!this.usableInvite(invite, now)) throw invalidInviteError();
    return { invite, now };
  }

  private usableInvite(
    invite:
      | (UsableInvite & { status: 'active' | 'used' | 'expired' | 'revoked' })
      | null,
    now: Date,
  ): invite is UsableInvite & { status: 'active' } {
    return Boolean(
      invite &&
        invite.status === 'active' &&
        invite.expiresAt > now &&
        evaluateSubscriptionProjection(invite.family.currentSubscription, () => now).accessAllowed,
    );
  }

  private assertInviteAcceptable(invite: UsableInvite, email: string, now: Date): void {
    if (
      invite.expiresAt <= now ||
      (invite.email !== null && normalizeEmail(invite.email) !== email)
    ) {
      throw invalidInviteError();
    }
  }

  private async assertIdentityAvailable(
    tx: Prisma.TransactionClient,
    email: string,
    googleSubject?: string,
  ): Promise<void> {
    const [existingUser, existingIdentity] = await Promise.all([
      tx.user.findUnique({ where: { email }, select: { id: true } }),
      googleSubject
        ? tx.userIdentity.findUnique({
            where: {
              provider_providerSubject: {
                provider: IdentityProvider.google,
                providerSubject: googleSubject,
              },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (existingUser || existingIdentity) throw inviteConflictError();
  }

  private async assertNoPendingApprovalForEmail(
    tx: Prisma.TransactionClient,
    familyId: string,
    email: string,
  ): Promise<void> {
    const pending = await tx.memberApproval.findFirst({
      where: {
        familyId,
        status: 'pending',
        requestedEmail: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (pending) throw inviteConflictError();
  }

  private async consumeInvite(
    tx: Prisma.TransactionClient,
    inviteId: string,
    familyId: string,
    now: Date,
  ): Promise<void> {
    const consumed = await tx.memberInvite.updateMany({
      where: {
        id: inviteId,
        familyId,
        status: 'active',
        expiresAt: { gt: now },
      },
      data: { status: 'used' },
    });
    if (consumed.count !== 1) throw invalidInviteError();
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (isSerializableConflict(error) && attempt < SERIALIZABLE_RETRIES) continue;
        throw error;
      }
    }
    throw new Error('Serializable retry budget exhausted.');
  }
}

function normalizedDisplayName(value: string): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length >= 2 && normalized.length <= 80 ? normalized : undefined;
}

function validCanonicalEmail(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = normalizeEmail(value);
  return email.length <= 254 && EMAIL_PATTERN.test(email) && !isInternalPendingEmail(email)
    ? email
    : undefined;
}

function invalidInviteError() {
  return new BadRequestException('Não foi possível aceitar o convite.');
}

function inviteConflictError() {
  return new ConflictException('Não foi possível aceitar o convite.');
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function isSerializableConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  return error.code === 'P2010' && error.meta?.code === '40001';
}
