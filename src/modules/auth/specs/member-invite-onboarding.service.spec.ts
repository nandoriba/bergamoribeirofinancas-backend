import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PlatformRole, ProfileStatus, UserActionTokenPurpose } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import {
  MemberInviteOnboardingService,
} from '../member-invite-onboarding.service';
import type { UserActionTokenService } from '../user-action-token.service';

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('bcrypt-hash') },
}));

const token = 'A'.repeat(43);
const activeSubscription = {
  providerStatus: 'ACTIVE',
  lastProviderEvent: 'subscription.renewed',
  providerUpdatedAt: new Date(),
  lastSuccessfulPaymentAt: new Date(),
  accessPaidThrough: new Date(Date.now() + 86_400_000),
  paymentFailedAt: null,
  graceUntil: null,
  cancelledAt: null,
  cancelRequestedAt: null,
  cancelledDueTo: null,
  lastInstallmentNumber: 1,
  entitlementContractVersion: 'v1',
  billingCycle: 'MONTHLY',
  paymentMethod: 'CARD',
};

function invite(email: string | null = 'member@example.com') {
  return {
    id: 'invite-1',
    familyId: 'family-1',
    email,
    status: 'active',
    expiresAt: new Date(Date.now() + 86_400_000),
    family: { name: 'Família Ribeiro', currentSubscription: activeSubscription },
  };
}

function setup() {
  const lockedInvite = invite();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
    memberInvite: {
      findUnique: vi.fn().mockResolvedValue(lockedInvite),
      findFirst: vi.fn().mockResolvedValue(lockedInvite),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    memberProfile: { create: vi.fn() },
    memberApproval: {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    userActionToken: { findFirst: vi.fn().mockResolvedValue(null) },
    userIdentity: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  };
  const prisma = {
    memberInvite: { findUnique: vi.fn().mockResolvedValue(lockedInvite) },
    $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaService;
  const values: Record<string, unknown> = {
    EMAIL_PROVIDER: 'resend',
    GOOGLE_OAUTH_ENABLED: true,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const prepared = {
    token: { id: 'challenge-1' },
    outbox: { id: 'outbox-1' },
  };
  const actionTokens = {
    assertEmailVerificationRecipientQuota: vi.fn(),
    prepareEmailVerification: vi.fn().mockReturnValue(prepared),
    createPrepared: vi.fn(),
    dispatchPrepared: vi.fn(),
    verificationMetadata: vi.fn().mockReturnValue({
      challengeId: 'challenge-1',
      destinationMasked: 'm***@example.com',
      expiresAt: new Date(),
      resendAvailableAt: new Date(),
    }),
    verificationMetadataFromPersistedToken: vi.fn().mockReturnValue({
      challengeId: 'challenge-1',
      destinationMasked: 'm***@example.com',
      expiresAt: new Date(),
      resendAvailableAt: new Date(),
    }),
    resendPendingInviteEmailVerification: vi.fn(),
    pendingInviteEmailVerificationStatus: vi.fn(),
  } as unknown as UserActionTokenService;
  return {
    service: new MemberInviteOnboardingService(prisma, config, actionTokens),
    prisma,
    tx,
    actionTokens,
  };
}

describe('MemberInviteOnboardingService', () => {
  it('resolve mascara e-mail restrito e só expõe capacidades', async () => {
    const { service } = setup();

    const result = await service.resolve(token);
    expect(result).toMatchObject({
      familyName: 'Família Ribeiro',
      emailHint: 'me****@e***.com',
      emailRestricted: true,
      methods: { local: true, google: true },
    });
    expect(result).not.toHaveProperty('continuation');
  });

  it('retoma a verificação local quando a resposta do cadastro foi perdida', async () => {
    const { actionTokens, service, tx } = setup();
    tx.memberInvite.findUnique.mockResolvedValue({ ...invite(), status: 'used' });
    tx.memberApproval.findUnique.mockResolvedValue({
      id: 'approval-1',
      inviteId: 'invite-1',
      familyId: 'family-1',
      userId: 'user-1',
      status: 'pending',
      requestedEmail: 'member@example.com',
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      familyId: 'family-1',
      email: 'pending-user-1@invite.invalid',
      passwordHash: 'bcrypt-hash',
      platformRole: PlatformRole.user,
      isActive: false,
      emailVerifiedAt: null,
      profile: { familyId: 'family-1', status: ProfileStatus.pending },
      identities: [],
    });
    const persistedToken = {
      id: 'challenge-1',
      purpose: UserActionTokenPurpose.email_verification,
      userId: 'user-1',
      deliveryEmail: 'MEMBER@example.com',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      consumedAt: null,
    };
    tx.userActionToken.findFirst.mockResolvedValue(persistedToken);

    await expect(service.resolve(token)).resolves.toMatchObject({
      familyName: 'Família Ribeiro',
      continuation: {
        status: 'verify_email',
        verification: { challengeId: 'challenge-1' },
      },
    });
    expect(tx.userActionToken.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        purpose: UserActionTokenPurpose.email_verification,
        consumedAt: null,
        deliveryEmail: { equals: 'member@example.com', mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      select: expect.objectContaining({
        purpose: true,
        userId: true,
        deliveryEmail: true,
      }),
    });
    expect(actionTokens.verificationMetadataFromPersistedToken).toHaveBeenCalledWith(
      persistedToken,
    );
  });

  it('retoma somente o estado de espera do owner quando o e-mail já foi verificado', async () => {
    const { service, tx } = setup();
    tx.memberInvite.findUnique.mockResolvedValue({ ...invite(), status: 'used' });
    tx.memberApproval.findUnique.mockResolvedValue({
      id: 'approval-1',
      inviteId: 'invite-1',
      familyId: 'family-1',
      userId: 'user-1',
      status: 'pending',
      requestedEmail: 'member@example.com',
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      familyId: 'family-1',
      email: 'member@example.com',
      passwordHash: 'bcrypt-hash',
      platformRole: PlatformRole.user,
      isActive: false,
      emailVerifiedAt: new Date(),
      profile: { familyId: 'family-1', status: ProfileStatus.pending },
      identities: [],
    });

    await expect(service.resolve(token)).resolves.toMatchObject({
      continuation: { status: 'pending_approval' },
    });
    expect(tx.userActionToken.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['approval rejeitado', { approvalStatus: 'rejected' }],
    ['approval aprovado', { approvalStatus: 'approved' }],
    ['perfil não pendente', { profileStatus: ProfileStatus.active }],
    ['usuário ativo', { userActive: true }],
    ['entitlement bloqueado', { currentSubscription: null }],
    ['token de outro e-mail', { tokenEmail: 'other@example.com' }],
  ])('não expõe continuation para estado inválido: %s', async (_name, state) => {
    const { service, tx } = setup();
    tx.memberInvite.findUnique.mockResolvedValue({
      ...invite(),
      status: 'used',
      family: {
        name: 'Família Ribeiro',
        currentSubscription:
          'currentSubscription' in state ? state.currentSubscription : activeSubscription,
      },
    });
    tx.memberApproval.findUnique.mockResolvedValue({
      id: 'approval-1',
      inviteId: 'invite-1',
      familyId: 'family-1',
      userId: 'user-1',
      status: 'approvalStatus' in state ? state.approvalStatus : 'pending',
      requestedEmail: 'member@example.com',
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      familyId: 'family-1',
      email: 'pending-user-1@invite.invalid',
      passwordHash: 'bcrypt-hash',
      platformRole: PlatformRole.user,
      isActive: 'userActive' in state ? state.userActive : false,
      emailVerifiedAt: null,
      profile: {
        familyId: 'family-1',
        status:
          'profileStatus' in state ? state.profileStatus : ProfileStatus.pending,
      },
      identities: [],
    });
    tx.userActionToken.findFirst.mockResolvedValue({
      id: 'challenge-1',
      purpose: UserActionTokenPurpose.email_verification,
      userId: 'user-1',
      deliveryEmail:
        'tokenEmail' in state ? state.tokenEmail : 'member@example.com',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      consumedAt: null,
    });

    await expect(service.resolve(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('registra membro local inativo/pending e exige aprovação após OTP', async () => {
    const { service, tx, actionTokens } = setup();

    await expect(
      service.registerLocal({
        token,
        name: '  Maria   Ribeiro ',
        email: ' MEMBER@example.com ',
        password: 'correct horse battery staple',
      }),
    ).resolves.toMatchObject({
      status: 'verify_email',
      verification: { challengeId: 'challenge-1' },
    });

    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Maria Ribeiro',
        email: expect.stringMatching(
          /^pending-[0-9a-f-]{36}@invite\.invalid$/,
        ),
        isActive: false,
        emailVerifiedAt: null,
      }),
    });
    expect(tx.memberProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: ProfileStatus.pending }),
    });
    expect(tx.memberApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inviteId: 'invite-1',
        userId: expect.any(String),
        requestedEmail: 'member@example.com',
      }),
    });
    expect(actionTokens.prepareEmailVerification).toHaveBeenCalledWith(
      expect.any(String),
      'member@example.com',
      expect.any(Date),
      '/convite/verificacao',
    );
    expect(tx.memberInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'active', expiresAt: { gt: expect.any(Date) } }),
        data: { status: 'used' },
      }),
    );
    const firstLock = tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    const secondLock = tx.$queryRaw.mock.calls[1]?.[0] as TemplateStringsArray;
    expect(firstLock.join('')).toContain('FROM "Family"');
    expect(secondLock.join('')).toContain('FROM "MemberInvite"');
    expect(actionTokens.dispatchPrepared).toHaveBeenCalledOnce();
  });

  it('revalida a restrição de e-mail dentro da transação', async () => {
    const { service, tx } = setup();

    await expect(
      service.registerLocal({
        token,
        name: 'Maria Ribeiro',
        email: 'other@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.memberInvite.updateMany).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('bloqueia outro aceite local pendente do mesmo e-mail no tenant', async () => {
    const { service, tx } = setup();
    tx.memberApproval.findFirst.mockResolvedValue({ id: 'approval-existing' });

    await expect(
      service.registerLocal({
        token,
        name: 'Maria Ribeiro',
        email: 'MEMBER@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.memberApproval.findFirst).toHaveBeenCalledWith({
      where: {
        familyId: 'family-1',
        status: 'pending',
        requestedEmail: { equals: 'member@example.com', mode: 'insensitive' },
      },
      select: { id: true },
    });
    expect(tx.memberInvite.updateMany).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('bloqueia aceite Google quando o e-mail já aguarda aprovação no tenant', async () => {
    const { service, tx } = setup();
    tx.memberApproval.findFirst.mockResolvedValue({ id: 'approval-existing' });

    await expect(
      service.completeGoogleAttempt({
        memberInviteId: 'invite-1',
        inviteDisplayName: 'Maria Ribeiro',
        identity: { subject: 'google-subject', email: 'member@example.com' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.memberInvite.updateMany).not.toHaveBeenCalled();
    expect(tx.userIdentity.create).not.toHaveBeenCalled();
  });

  it('informa se o reenvio realmente criou um novo desafio', async () => {
    const { service, actionTokens } = setup();
    const resend = vi.mocked(actionTokens.resendPendingInviteEmailVerification);
    const metadata = {
      challengeId: 'challenge-1',
      destinationMasked: 'm***@example.com',
      expiresAt: new Date(),
      resendAvailableAt: new Date(),
    };
    resend.mockResolvedValueOnce({ verification: metadata, sent: false });

    await expect(service.resendLocalEmail('challenge-1')).resolves.toMatchObject({
      status: 'verify_email',
      sent: false,
      verification: metadata,
    });

    resend.mockResolvedValueOnce({
      verification: { ...metadata, challengeId: 'challenge-1' },
      sent: true,
    });
    await expect(service.resendLocalEmail('challenge-1')).resolves.toMatchObject({
      status: 'verify_email',
      sent: true,
      verification: { challengeId: 'challenge-1' },
    });
  });

  it('Google cria identidade verificada sem ativar usuário ou perfil', async () => {
    const { service, tx } = setup();

    await expect(
      service.completeGoogleAttempt({
        memberInviteId: 'invite-1',
        inviteDisplayName: 'Maria Ribeiro',
        identity: { subject: 'google-subject', email: 'member@example.com' },
      }),
    ).resolves.toEqual({ status: 'pending_approval' });
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        passwordHash: null,
        isActive: false,
        emailVerifiedAt: expect.any(Date),
      }),
    });
    expect(tx.userIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerSubject: 'google-subject' }),
    });
    expect(tx.memberProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: ProfileStatus.pending }),
    });
  });
});
