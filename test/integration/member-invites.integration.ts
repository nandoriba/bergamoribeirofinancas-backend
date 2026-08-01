import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OAuthIntent,
  PlatformRole,
  PrismaClient,
  SubscriptionCycle,
  SubscriptionPaymentMethod,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ActionTokenCryptoService } from '../../src/modules/auth/action-token-crypto.service';
import { pendingInviteEmail } from '../../src/modules/auth/auth-security.util';
import { AuthService } from '../../src/modules/auth/auth.service';
import { EmailOutboxService } from '../../src/modules/auth/email-outbox.service';
import { GoogleOAuthService } from '../../src/modules/auth/google-oauth.service';
import {
  GoogleOidcClient,
  type GoogleAuthorizationInput,
} from '../../src/modules/auth/google-oidc.client';
import { MemberInviteOnboardingService } from '../../src/modules/auth/member-invite-onboarding.service';
import { OAuthAttemptCryptoService } from '../../src/modules/auth/oauth-attempt-crypto.service';
import { OwnerOnboardingService } from '../../src/modules/auth/owner-onboarding.service';
import { UserActionTokenService } from '../../src/modules/auth/user-action-token.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

const WEB_ORIGIN = 'http://127.0.0.1:8181';
const PASSWORD = 'integration-password';
const INVITED_PASSWORD = 'integration-invite-password';

interface TenantFixture {
  familyId: string;
  subscriptionId: string;
  ownerId: string;
  ownerProfileId: string;
  ownerEmail: string;
  memberId: string;
  memberProfileId: string;
  memberEmail: string;
}

interface InviteResponse {
  id: string;
  token: string;
  link: string;
  email: string | null;
  status: string;
}

describe('convites e gestão de membros com PostgreSQL real', () => {
  let prisma: PrismaClient;
  let baseUrl: string;
  let config: ConfigService;
  let actionTokenCrypto: ActionTokenCryptoService;
  let actionTokens: UserActionTokenService;
  let inviteOnboarding: MemberInviteOnboardingService;
  let authService: AuthService;
  let apiJwt: JwtService;

  beforeAll(() => {
    if (process.env.RUN_TENANT_INTEGRATION !== 'true') {
      throw new Error('Execute este arquivo somente por npm run test:integration');
    }

    prisma = new PrismaClient();
    baseUrl = process.env.TEST_API_URL ?? '';
    if (!baseUrl) throw new Error('TEST_API_URL ausente');

    config = integrationConfig();
    actionTokenCrypto = new ActionTokenCryptoService(config);
    const outbox = { kick: vi.fn() } as unknown as EmailOutboxService;
    actionTokens = new UserActionTokenService(
      prisma as unknown as PrismaService,
      actionTokenCrypto,
      outbox,
      config,
    );
    inviteOnboarding = new MemberInviteOnboardingService(
      prisma as unknown as PrismaService,
      config,
      actionTokens,
    );
    authService = new AuthService(
      prisma as unknown as PrismaService,
      new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') }),
      config,
    );
    apiJwt = new JwtService({ secret: readRuntimeEnv('JWT_SECRET') });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('mantém criação e revogação no owner correto e não promove admin de plataforma', async () => {
    const tenantA = await createTenant(prisma, 'Guards A', PlatformRole.admin);
    const tenantB = await createTenant(prisma, 'Guards B');
    const [ownerA, ownerB, adminMemberA] = await Promise.all([
      sessionCookie(prisma, apiJwt, tenantA.ownerId),
      sessionCookie(prisma, apiJwt, tenantB.ownerId),
      sessionCookie(prisma, apiJwt, tenantA.memberId),
    ]);

    const deniedCreate = await postJson(
      baseUrl,
      adminMemberA,
      '/member-invites',
      { email: `denied-${randomUUID()}@example.test` },
    );
    expect(deniedCreate.status).toBe(403);

    const invite = await createInvite(
      baseUrl,
      ownerA,
      `guarded-${randomUUID()}@example.test`,
    );
    const crossTenantRevoke = await postJson(
      baseUrl,
      ownerB,
      `/member-invites/${invite.id}/revoke`,
      {},
    );
    expect(crossTenantRevoke.status).toBe(404);

    const persistedBeforeOwnerRevoke = await prisma.memberInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(persistedBeforeOwnerRevoke.status).toBe('active');

    const ownerRevoke = await postJson(
      baseUrl,
      ownerA,
      `/member-invites/${invite.id}/revoke`,
      {},
    );
    expect(ownerRevoke.status).toBe(200);
    await expect(ownerRevoke.json()).resolves.toMatchObject({
      id: invite.id,
      status: 'revoked',
    });
  });

  it('vincula o email, exige verificação antes da aprovação e não cruza tenants', async () => {
    const tenantA = await createTenant(prisma, 'Local A');
    const tenantB = await createTenant(prisma, 'Local B');
    const [ownerA, ownerB] = await Promise.all([
      sessionCookie(prisma, apiJwt, tenantA.ownerId),
      sessionCookie(prisma, apiJwt, tenantB.ownerId),
    ]);
    const invitedEmail = `member-${randomUUID()}@example.test`;
    const invite = await createInvite(baseUrl, ownerA, invitedEmail.toUpperCase());

    await expect(
      inviteOnboarding.registerLocal({
        token: invite.token,
        name: 'Email Incorreto',
        email: `wrong-${randomUUID()}@example.test`,
        password: INVITED_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await prisma.memberInvite.findUniqueOrThrow({ where: { id: invite.id } })).status,
    ).toBe('active');

    const registration = await inviteOnboarding.registerLocal({
      token: invite.token,
      name: '  Membro   Verificado  ',
      email: invitedEmail.toUpperCase(),
      password: INVITED_PASSWORD,
    });
    expect(registration.status).toBe('verify_email');

    const reopenedResolve = await postJson(
      baseUrl,
      undefined,
      '/member-invites/resolve',
      { token: invite.token },
    );
    expect(reopenedResolve.status, await reopenedResolve.clone().text()).toBe(200);
    const reopenedBody = asRecord(await reopenedResolve.json());
    const reopenedContinuation = asRecord(reopenedBody.continuation);
    const reopenedVerification = asRecord(reopenedContinuation.verification);
    expect(reopenedContinuation.status).toBe('verify_email');
    expect(reopenedVerification).toMatchObject({
      challengeId: registration.verification.challengeId,
      destinationMasked: expect.any(String),
    });
    const recoveredChallengeId = readString(reopenedVerification, 'challengeId');

    const statusBeforeOtp = await postJson(
      baseUrl,
      undefined,
      '/member-invites/email-verification/status',
      { challengeId: recoveredChallengeId },
    );
    expect(statusBeforeOtp.status, await statusBeforeOtp.clone().text()).toBe(200);
    await expect(statusBeforeOtp.json()).resolves.toMatchObject({
      status: 'verify_email',
      verification: { challengeId: recoveredChallengeId },
    });

    const storedChallenge = await prisma.userActionToken.findUniqueOrThrow({
      where: { id: recoveredChallengeId },
      include: { emailOutbox: true },
    });
    if (!storedChallenge.emailOutbox?.payloadCiphertext) {
      throw new Error('Outbox de convite ausente');
    }
    const invitePayload = actionTokenCrypto.decryptOutboxPayload(
      storedChallenge.emailOutbox.id,
      {
        payloadCiphertext: storedChallenge.emailOutbox.payloadCiphertext,
        payloadKeyVersion: storedChallenge.emailOutbox.payloadKeyVersion,
      },
    );
    expect(invitePayload).toMatchObject({
      kind: 'email_verification',
      continuationPath: '/convite/verificacao',
    });
    expect(JSON.stringify(invitePayload)).not.toContain(invite.token);

    const approval = await prisma.memberApproval.findUniqueOrThrow({
      where: { inviteId: invite.id },
      include: { approvedUser: { include: { profile: true } } },
    });
    expect(approval.approvedUser).toMatchObject({
      email: pendingInviteEmail(approval.userId!),
      isActive: false,
      emailVerifiedAt: null,
      profile: { status: 'pending' },
    });

    const pendingMembersResponse = await fetch(`${baseUrl}/members`, {
      headers: { cookie: ownerA },
    });
    expect(pendingMembersResponse.status).toBe(200);
    const pendingMembers = (await pendingMembersResponse.json()) as Array<{
      id: string;
      email: string | null;
    }>;
    expect(pendingMembers.find(({ id }) => id === approval.userId)).toMatchObject({
      email: invitedEmail,
    });
    expect(JSON.stringify(pendingMembers)).not.toContain('@invite.invalid');

    const crossTenantApprove = await postJson(
      baseUrl,
      ownerB,
      `/member-approvals/${approval.id}/approve`,
      {},
    );
    expect(crossTenantApprove.status).toBe(404);

    const prematureApprove = await postJson(
      baseUrl,
      ownerA,
      `/member-approvals/${approval.id}/approve`,
      {},
    );
    expect([400, 409]).toContain(prematureApprove.status);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: approval.userId! } })).isActive,
    ).toBe(false);

    const verificationCode = await readVerificationCode(
      prisma,
      actionTokenCrypto,
      recoveredChallengeId,
    );
    await expect(
      inviteOnboarding.confirmLocalEmail(
        recoveredChallengeId,
        verificationCode,
      ),
    ).resolves.toEqual({ status: 'pending_approval' });

    const statusAfterOtp = await postJson(
      baseUrl,
      undefined,
      '/member-invites/email-verification/status',
      { challengeId: recoveredChallengeId },
    );
    expect(statusAfterOtp.status, await statusAfterOtp.clone().text()).toBe(200);
    await expect(statusAfterOtp.json()).resolves.toEqual({
      status: 'pending_approval',
    });
    const reopenedAfterOtp = await postJson(
      baseUrl,
      undefined,
      '/member-invites/resolve',
      { token: invite.token },
    );
    expect(reopenedAfterOtp.status, await reopenedAfterOtp.clone().text()).toBe(200);
    await expect(reopenedAfterOtp.json()).resolves.toMatchObject({
      continuation: { status: 'pending_approval' },
    });

    const verifiedPendingUser = await prisma.user.findUniqueOrThrow({
      where: { id: approval.userId! },
      include: { profile: true },
    });
    expect(verifiedPendingUser.emailVerifiedAt).toBeInstanceOf(Date);
    expect(verifiedPendingUser.email).toBe(invitedEmail);
    expect(verifiedPendingUser.isActive).toBe(false);
    expect(verifiedPendingUser.profile?.status).toBe('pending');

    const approved = await postJson(
      baseUrl,
      ownerA,
      `/member-approvals/${approval.id}/approve`,
      {},
    );
    expect(approved.ok, await approved.clone().text()).toBe(true);

    const activeUser = await prisma.user.findUniqueOrThrow({
      where: { id: approval.userId! },
      include: { profile: true },
    });
    expect(activeUser.isActive).toBe(true);
    expect(activeUser.profile?.status).toBe('active');
    await expect(authService.login(invitedEmail, INVITED_PASSWORD)).resolves.toMatchObject({
      token: expect.any(String),
      user: {
        id: approval.userId,
        email: invitedEmail,
        tenantRole: 'member',
        familyId: tenantA.familyId,
      },
    });
  });

  it('não reserva email antes do OTP e libera novamente após rejeição ou expiração', async () => {
    const [tenantA, tenantB] = await Promise.all([
      createTenant(prisma, 'Anti squatting A'),
      createTenant(prisma, 'Anti squatting B'),
    ]);
    const [ownerA, ownerB] = await Promise.all([
      sessionCookie(prisma, apiJwt, tenantA.ownerId),
      sessionCookie(prisma, apiJwt, tenantB.ownerId),
    ]);

    const sharedEmail = `shared-${randomUUID()}@example.test`;
    const firstInvite = await createInvite(baseUrl, ownerA, sharedEmail);
    const secondInvite = await createInvite(baseUrl, ownerB, sharedEmail);
    const firstRegistration = await inviteOnboarding.registerLocal({
      token: firstInvite.token,
      name: 'Primeiro pendente',
      email: sharedEmail,
      password: INVITED_PASSWORD,
    });
    const secondRegistration = await inviteOnboarding.registerLocal({
      token: secondInvite.token,
      name: 'Segundo pendente',
      email: sharedEmail,
      password: INVITED_PASSWORD,
    });
    const [firstApproval, secondApproval] = await Promise.all([
      prisma.memberApproval.findUniqueOrThrow({
        where: { inviteId: firstInvite.id },
        include: { approvedUser: true },
      }),
      prisma.memberApproval.findUniqueOrThrow({
        where: { inviteId: secondInvite.id },
        include: { approvedUser: true },
      }),
    ]);
    expect(firstApproval.approvedUser?.email).toBe(
      pendingInviteEmail(firstApproval.userId!),
    );
    expect(secondApproval.approvedUser?.email).toBe(
      pendingInviteEmail(secondApproval.userId!),
    );
    expect(firstApproval.approvedUser?.email).not.toBe(secondApproval.approvedUser?.email);
    expect(await prisma.user.count({ where: { email: sharedEmail } })).toBe(0);

    const [firstCode, secondCode] = await Promise.all([
      readVerificationCode(
        prisma,
        actionTokenCrypto,
        firstRegistration.verification.challengeId,
      ),
      readVerificationCode(
        prisma,
        actionTokenCrypto,
        secondRegistration.verification.challengeId,
      ),
    ]);
    const promotionRace = await Promise.allSettled([
      inviteOnboarding.confirmLocalEmail(
        firstRegistration.verification.challengeId,
        firstCode,
      ),
      inviteOnboarding.confirmLocalEmail(
        secondRegistration.verification.challengeId,
        secondCode,
      ),
    ]);
    expect(promotionRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(promotionRace.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: sharedEmail } })).toBe(1);
    const losingIndex = promotionRace.findIndex(({ status }) => status === 'rejected');
    const losingChallengeId = [
      firstRegistration.verification.challengeId,
      secondRegistration.verification.challengeId,
    ][losingIndex];
    expect(
      (
        await prisma.userActionToken.findUniqueOrThrow({
          where: { id: losingChallengeId },
        })
      ).consumedAt,
    ).toBeNull();

    const sameTenantEmail = `same-tenant-${randomUUID()}@example.test`;
    const sameTenantInvites = await Promise.all([
      createInvite(baseUrl, ownerA, sameTenantEmail),
      createInvite(baseUrl, ownerA, sameTenantEmail),
    ]);
    const sameTenantRace = await Promise.allSettled(
      sameTenantInvites.map((invite, index) =>
        inviteOnboarding.registerLocal({
          token: invite.token,
          name: `Pendente concorrente ${index + 1}`,
          email: sameTenantEmail.toUpperCase(),
          password: INVITED_PASSWORD,
        }),
      ),
    );
    expect(sameTenantRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(sameTenantRace.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(
      await prisma.memberApproval.count({
        where: {
          familyId: tenantA.familyId,
          requestedEmail: sameTenantEmail,
          status: 'pending',
        },
      }),
    ).toBe(1);
    const sameTenantInviteStates = await prisma.memberInvite.findMany({
      where: { id: { in: sameTenantInvites.map(({ id }) => id) } },
      select: { status: true },
    });
    expect(sameTenantInviteStates.filter(({ status }) => status === 'used')).toHaveLength(1);
    expect(sameTenantInviteStates.filter(({ status }) => status === 'active')).toHaveLength(1);

    const googleCollisionEmail = `google-pending-${randomUUID()}@example.test`;
    const localPendingInvite = await createInvite(baseUrl, ownerA, googleCollisionEmail);
    await inviteOnboarding.registerLocal({
      token: localPendingInvite.token,
      name: 'Pendente local antes do Google',
      email: googleCollisionEmail,
      password: INVITED_PASSWORD,
    });
    const googleCollisionInvite = await createInvite(
      baseUrl,
      ownerA,
      googleCollisionEmail,
    );
    const googleCollisionAttempt = await inviteOnboarding.prepareGoogleAttempt({
      token: googleCollisionInvite.token,
      displayName: 'Tentativa Google duplicada',
    });
    const duplicateSubject = `duplicate-subject-${randomUUID()}`;
    await expect(
      inviteOnboarding.completeGoogleAttempt({
        ...googleCollisionAttempt,
        identity: { subject: duplicateSubject, email: googleCollisionEmail },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await prisma.memberInvite.findUniqueOrThrow({ where: { id: googleCollisionInvite.id } }))
        .status,
    ).toBe('active');
    expect(
      await prisma.userIdentity.count({
        where: { providerSubject: duplicateSubject },
      }),
    ).toBe(0);

    const rejectedEmail = `rejected-${randomUUID()}@example.test`;
    const rejectedInvite = await createInvite(baseUrl, ownerA, rejectedEmail);
    const rejectedRegistration = await inviteOnboarding.registerLocal({
      token: rejectedInvite.token,
      name: 'Será rejeitado',
      email: rejectedEmail,
      password: INVITED_PASSWORD,
    });
    const rejectedApproval = await prisma.memberApproval.findUniqueOrThrow({
      where: { inviteId: rejectedInvite.id },
    });
    const rejectedCode = await readVerificationCode(
      prisma,
      actionTokenCrypto,
      rejectedRegistration.verification.challengeId,
    );
    await inviteOnboarding.confirmLocalEmail(
      rejectedRegistration.verification.challengeId,
      rejectedCode,
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: rejectedApproval.userId! } }))
        .email,
    ).toBe(rejectedEmail);
    const rejection = await postJson(
      baseUrl,
      ownerA,
      `/member-approvals/${rejectedApproval.id}/reject`,
      {},
    );
    expect(rejection.status, await rejection.clone().text()).toBe(200);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: rejectedApproval.userId! } }),
    ).toMatchObject({
      email: pendingInviteEmail(rejectedApproval.userId!),
      emailVerifiedAt: null,
      isActive: false,
    });
    const retryAfterRejection = await createInvite(baseUrl, ownerA, rejectedEmail);
    await expect(
      inviteOnboarding.registerLocal({
        token: retryAfterRejection.token,
        name: 'Depois da rejeição',
        email: rejectedEmail,
        password: INVITED_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 'verify_email' });
    expect(await prisma.user.count({ where: { email: rejectedEmail } })).toBe(0);

    const googleRejectedEmail = `google-rejected-${randomUUID()}@example.test`;
    const googleSubject = `reusable-subject-${randomUUID()}`;
    const googleRejectedInvite = await createInvite(
      baseUrl,
      ownerA,
      googleRejectedEmail,
    );
    const googleRejectedAttempt = await inviteOnboarding.prepareGoogleAttempt({
      token: googleRejectedInvite.token,
      displayName: 'Google que será rejeitado',
    });
    await expect(
      inviteOnboarding.completeGoogleAttempt({
        ...googleRejectedAttempt,
        identity: { subject: googleSubject, email: googleRejectedEmail },
      }),
    ).resolves.toEqual({ status: 'pending_approval' });
    const googleRejectedApproval = await prisma.memberApproval.findUniqueOrThrow({
      where: { inviteId: googleRejectedInvite.id },
    });
    expect(
      await prisma.userIdentity.count({
        where: { providerSubject: googleSubject },
      }),
    ).toBe(1);

    const googleRejection = await postJson(
      baseUrl,
      ownerA,
      `/member-approvals/${googleRejectedApproval.id}/reject`,
      {},
    );
    expect(googleRejection.status, await googleRejection.clone().text()).toBe(200);
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: googleRejectedApproval.userId! },
      }),
    ).toMatchObject({
      email: pendingInviteEmail(googleRejectedApproval.userId!),
      emailVerifiedAt: null,
      isActive: false,
    });
    expect(
      await prisma.userIdentity.count({
        where: { providerSubject: googleSubject },
      }),
    ).toBe(0);

    const googleRetryInvite = await createInvite(baseUrl, ownerA, googleRejectedEmail);
    const googleRetryAttempt = await inviteOnboarding.prepareGoogleAttempt({
      token: googleRetryInvite.token,
      displayName: 'Google depois da rejeição',
    });
    await expect(
      inviteOnboarding.completeGoogleAttempt({
        ...googleRetryAttempt,
        identity: { subject: googleSubject, email: googleRejectedEmail },
      }),
    ).resolves.toEqual({ status: 'pending_approval' });
    const googleRetryApproval = await prisma.memberApproval.findUniqueOrThrow({
      where: { inviteId: googleRetryInvite.id },
    });
    expect(googleRetryApproval.userId).not.toBe(googleRejectedApproval.userId);
    expect(
      await prisma.userIdentity.count({
        where: {
          providerSubject: googleSubject,
          userId: googleRetryApproval.userId!,
        },
      }),
    ).toBe(1);

    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expiringInvite = await createInvite(baseUrl, ownerA, expiredEmail);
    await prisma.memberInvite.update({
      where: { id: expiringInvite.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      inviteOnboarding.registerLocal({
        token: expiringInvite.token,
        name: 'Convite expirado',
        email: expiredEmail,
        password: INVITED_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await prisma.memberApproval.count({ where: { requestedEmail: expiredEmail } }),
    ).toBe(0);
    const retryAfterExpiration = await createInvite(baseUrl, ownerA, expiredEmail);
    await expect(
      inviteOnboarding.registerLocal({
        token: retryAfterExpiration.token,
        name: 'Depois da expiração',
        email: expiredEmail,
        password: INVITED_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 'verify_email' });
    expect(await prisma.user.count({ where: { email: expiredEmail } })).toBe(0);
  });

  it('revalida entitlement e deixa apenas um vencedor na corrida local versus Google', async () => {
    const tenant = await createTenant(prisma, 'Corrida');
    const owner = await sessionCookie(prisma, apiJwt, tenant.ownerId);
    const raceInvite = await createInvite(baseUrl, owner);
    const blockedInvite = await createInvite(baseUrl, owner);
    const blockedAttempt = await inviteOnboarding.prepareGoogleAttempt({
      token: blockedInvite.token,
      displayName: 'Google Bloqueado',
    });

    const localEmail = `local-race-${randomUUID()}@example.test`;
    const googleEmail = `google-race-${randomUUID()}@example.test`;
    const race = await Promise.allSettled([
      inviteOnboarding.registerLocal({
        token: raceInvite.token,
        name: 'Membro Local',
        email: localEmail,
        password: INVITED_PASSWORD,
      }),
      inviteOnboarding.completeGoogleAttempt({
        memberInviteId: raceInvite.id,
        inviteDisplayName: 'Membro Google',
        identity: {
          subject: `subject-${randomUUID()}`,
          email: googleEmail,
        },
      }),
    ]);

    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await prisma.memberInvite.findUniqueOrThrow({ where: { id: raceInvite.id } })).status,
    ).toBe('used');
    expect(await prisma.memberApproval.count({ where: { inviteId: raceInvite.id } })).toBe(1);
    const googleWon = race[1]?.status === 'fulfilled';
    expect(
      await prisma.user.count({ where: { email: { in: [localEmail, googleEmail] } } }),
    ).toBe(googleWon ? 1 : 0);

    const entitlementEmail = `entitlement-${randomUUID()}@example.test`;
    const entitlementInvite = await createInvite(baseUrl, owner, entitlementEmail);
    const entitlementRegistration = await inviteOnboarding.registerLocal({
      token: entitlementInvite.token,
      name: 'Membro antes do cancelamento',
      email: entitlementEmail,
      password: INVITED_PASSWORD,
    });
    const entitlementApproval = await prisma.memberApproval.findUniqueOrThrow({
      where: { inviteId: entitlementInvite.id },
    });
    const entitlementCode = await readVerificationCode(
      prisma,
      actionTokenCrypto,
      entitlementRegistration.verification.challengeId,
    );

    await cancelSubscription(prisma, tenant.subscriptionId);
    await expect(
      inviteOnboarding.confirmLocalEmail(
        entitlementRegistration.verification.challengeId,
        entitlementCode,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      inviteOnboarding.resendLocalEmail(
        entitlementRegistration.verification.challengeId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const blockedStatus = await postJson(
      baseUrl,
      undefined,
      '/member-invites/email-verification/status',
      { challengeId: entitlementRegistration.verification.challengeId },
    );
    expect(blockedStatus.status).toBe(400);
    const blockedResolve = await postJson(
      baseUrl,
      undefined,
      '/member-invites/resolve',
      { token: entitlementInvite.token },
    );
    expect(blockedResolve.status).toBe(404);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: entitlementApproval.userId! } }),
    ).toMatchObject({
      email: pendingInviteEmail(entitlementApproval.userId!),
      emailVerifiedAt: null,
    });
    expect(
      (
        await prisma.userActionToken.findUniqueOrThrow({
          where: { id: entitlementRegistration.verification.challengeId },
        })
      ).consumedAt,
    ).toBeNull();
    expect(await prisma.user.count({ where: { email: entitlementEmail } })).toBe(0);

    const blockedEmail = `blocked-${randomUUID()}@example.test`;
    await expect(
      inviteOnboarding.completeGoogleAttempt({
        ...blockedAttempt,
        identity: {
          subject: `blocked-subject-${randomUUID()}`,
          email: blockedEmail,
        },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(
      (await prisma.memberInvite.findUniqueOrThrow({ where: { id: blockedInvite.id } })).status,
    ).toBe('active');
    expect(await prisma.user.count({ where: { email: blockedEmail } })).toBe(0);

    const blockedOwnerCreate = await postJson(
      baseUrl,
      owner,
      '/member-invites',
      { email: `after-cancel-${randomUUID()}@example.test` },
    );
    expect(blockedOwnerCreate.status).toBe(403);
  });

  it('inativa somente membro do próprio tenant e revoga sessão e Telegram sem apagar dados', async () => {
    const tenantA = await createTenant(prisma, 'Deactivate A');
    const tenantB = await createTenant(prisma, 'Deactivate B');
    const [ownerA, ownerB, memberA] = await Promise.all([
      sessionCookie(prisma, apiJwt, tenantA.ownerId),
      sessionCookie(prisma, apiJwt, tenantB.ownerId),
      sessionCookie(prisma, apiJwt, tenantA.memberId),
    ]);

    const chatId = `-${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const tgUserId = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const group = await prisma.telegramAuthorizedGroup.create({
      data: {
        chatId,
        familyId: tenantA.familyId,
        authorizedByUserId: tenantA.ownerId,
      },
    });
    const link = await prisma.telegramUserLink.create({
      data: {
        chatId,
        familyId: tenantA.familyId,
        tgUserId,
        memberProfileId: tenantA.memberProfileId,
      },
    });
    const authCode = await prisma.telegramAuthCode.create({
      data: {
        code: `member-${randomUUID()}`,
        kind: 'MEMBER',
        userId: tenantA.memberId,
        memberProfileId: tenantA.memberProfileId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const pending = await prisma.telegramPendingConfirmation.create({
      data: {
        id: randomUUID(),
        chatId,
        memberProfileId: tenantA.memberProfileId,
        tgUserId,
        payload: { kind: 'CREATE_TRANSACTION' },
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const account = await prisma.account.create({
      data: {
        name: 'Histórico preservado',
        type: 'checking',
        memberProfileId: tenantA.memberProfileId,
      },
    });
    const pendingActionToken = actionTokens.preparePasswordReset(
      tenantA.memberId,
      tenantA.memberEmail,
    );
    await prisma.$transaction((tx) => actionTokens.createPrepared(tx, pendingActionToken));

    const crossTenantDeactivate = await postJson(
      baseUrl,
      ownerB,
      `/members/${tenantA.memberId}/deactivate`,
      {},
    );
    expect(crossTenantDeactivate.status).toBe(404);

    const ownerSelfDeactivate = await postJson(
      baseUrl,
      ownerA,
      `/members/${tenantA.ownerId}/deactivate`,
      {},
    );
    expect([400, 409]).toContain(ownerSelfDeactivate.status);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: tenantA.ownerId } })).isActive,
    ).toBe(true);

    const deactivated = await postJson(
      baseUrl,
      ownerA,
      `/members/${tenantA.memberId}/deactivate`,
      {},
    );
    expect(deactivated.status, await deactivated.clone().text()).toBe(200);
    await expect(deactivated.json()).resolves.toMatchObject({
      id: tenantA.memberId,
      status: 'inactive',
    });

    const [user, telegramLink, telegramCode, telegramPending, actionToken] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: tenantA.memberId },
        include: { profile: true },
      }),
      prisma.telegramUserLink.findUniqueOrThrow({ where: { id: link.id } }),
      prisma.telegramAuthCode.findUniqueOrThrow({ where: { id: authCode.id } }),
      prisma.telegramPendingConfirmation.findUniqueOrThrow({ where: { id: pending.id } }),
      prisma.userActionToken.findUniqueOrThrow({
        where: { id: pendingActionToken.token.id },
        include: { emailOutbox: true },
      }),
    ]);
    expect(user).toMatchObject({
      isActive: false,
      authVersion: 1,
      profile: { status: 'inactive' },
    });
    expect(telegramLink.revokedAt).toBeInstanceOf(Date);
    expect(telegramCode.consumedAt).toBeInstanceOf(Date);
    expect(telegramPending.status).toBe('CANCELLED');
    expect(actionToken.revokedAt).toBeInstanceOf(Date);
    expect(actionToken.emailOutbox).toMatchObject({
      status: 'discarded',
      payloadCiphertext: null,
      nextAttemptAt: null,
      lockedAt: null,
      discardedAt: expect.any(Date),
      lastErrorCode: 'MEMBER_DEACTIVATED',
    });
    expect(await prisma.account.count({ where: { id: account.id } })).toBe(1);
    expect(await prisma.telegramAuthorizedGroup.count({ where: { id: group.id } })).toBe(1);

    const revokedSession = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: memberA },
    });
    expect(revokedSession.status).toBe(401);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: tenantA.memberId },
        data: { isActive: true },
      }),
      prisma.memberProfile.update({
        where: { id: tenantA.memberProfileId },
        data: { status: 'active' },
      }),
    ]);
    const staleAfterReactivation = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: memberA },
    });
    expect(staleAfterReactivation.status).toBe(401);
  });

  it('conclui signup_owner no PostgreSQL sem violar a CHECK de authenticatedUserId', async () => {
    let authorizationInput: GoogleAuthorizationInput | undefined;
    const ownerEmail = `google-owner-${randomUUID()}@example.test`;
    const oidc = {
      isEnabled: () => true,
      createAuthorizationUrl: vi.fn(async (input: GoogleAuthorizationInput) => {
        authorizationInput = input;
        return 'https://accounts.google.com/o/oauth2/v2/auth';
      }),
      exchangeCode: vi.fn(async () => {
        if (!authorizationInput) throw new Error('OAuth start ausente');
        return {
          subject: `owner-subject-${randomUUID()}`,
          email: ownerEmail,
          name: 'Owner Google PostgreSQL',
          nonce: authorizationInput.nonce,
        };
      }),
    } as unknown as GoogleOidcClient;
    const ownerOnboarding = new OwnerOnboardingService(
      prisma as unknown as PrismaService,
      config,
      actionTokens,
      authService,
    );
    const oauthCrypto = new OAuthAttemptCryptoService(config);
    const oauth = new GoogleOAuthService(
      prisma as unknown as PrismaService,
      authService,
      ownerOnboarding,
      inviteOnboarding,
      oidc,
      oauthCrypto,
      config,
    );

    const start = await oauth.start({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Owner Google PostgreSQL',
      familyName: 'Família Google PostgreSQL',
      legalAcceptanceVersion: config.getOrThrow<string>('LEGAL_BUNDLE_VERSION'),
    });
    if (!authorizationInput) throw new Error('OAuth state não foi capturado');

    const callback = await oauth.complete({
      state: authorizationInput.state,
      code: 'authorization-code',
      browserBinding: start.bindingCookie.value,
    });
    expect(callback.token).toEqual(expect.any(String));
    expect(callback.redirectUrl).toContain('/pagamento/pendente');

    const attempt = await prisma.oAuthAttempt.findUniqueOrThrow({
      where: { stateHash: oauthCrypto.hashState(authorizationInput.state) },
    });
    expect(attempt.intent).toBe(OAuthIntent.signup_owner);
    expect(attempt.consumedAt).toBeInstanceOf(Date);
    expect(attempt.authenticatedUserId).toBeNull();
    expect(await prisma.user.count({ where: { email: ownerEmail } })).toBe(1);
  });
});

function integrationConfig(): ConfigService {
  return new ConfigService({
    NODE_ENV: 'test',
    WEB_ORIGIN,
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:8180',
    COOKIE_SECURE: false,
    JWT_SECRET: 'member-invite-integration-jwt-secret'.padEnd(48, '!'),
    JWT_EXPIRES_IN: '7d',
    OWNER_SIGNUP_ENABLED: true,
    GOOGLE_OAUTH_ENABLED: true,
    GOOGLE_CLIENT_ID: 'integration-google-client',
    GOOGLE_CLIENT_SECRET: 'integration-google-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8180/auth/google/callback',
    OAUTH_ATTEMPT_SECRET: 'member-invite-oauth-secret'.padEnd(48, '!'),
    OAUTH_ATTEMPT_KEY_VERSION: 'integration-v1',
    OAUTH_ATTEMPT_TTL_SECONDS: 300,
    EMAIL_PROVIDER: 'resend',
    ACTION_TOKEN_SECRET: 'member-invite-action-secret'.padEnd(48, '!'),
    EMAIL_OUTBOX_SECRET: 'member-invite-outbox-secret'.padEnd(48, '!'),
    EMAIL_OUTBOX_KEY_VERSION: 'integration-v1',
    EMAIL_VERIFICATION_TTL_MINUTES: 15,
    PASSWORD_RESET_TTL_MINUTES: 30,
    ACTION_TOKEN_MAX_ATTEMPTS: 5,
    ACTION_TOKEN_HOURLY_LIMIT: 10,
    ACTION_TOKEN_DAILY_LIMIT: 20,
    ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT: 3,
    ACTION_TOKEN_RECIPIENT_DAILY_LIMIT: 10,
    EMAIL_RESEND_COOLDOWN_SECONDS: 0,
    PENDING_PAYMENT_TTL_DAYS: 7,
    LEGAL_BUNDLE_VERSION: '2026-08-01',
  });
}

async function createTenant(
  prisma: PrismaClient,
  label: string,
  memberPlatformRole: PlatformRole = PlatformRole.user,
): Promise<TenantFixture> {
  const suffix = randomUUID();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: { id: randomUUID(), name: `${label} ${suffix}` },
    });
    const owner = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `owner-${suffix}@example.test`,
        passwordHash,
        name: `${label} Owner`,
        platformRole: PlatformRole.user,
        familyId: family.id,
        emailVerifiedAt: now,
      },
    });
    const ownerProfile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: `${label} Owner`,
        userId: owner.id,
        familyId: family.id,
      },
    });
    const member = await tx.user.create({
      data: {
        id: randomUUID(),
        email: `member-${suffix}@example.test`,
        passwordHash,
        name: `${label} Member`,
        platformRole: memberPlatformRole,
        familyId: family.id,
        emailVerifiedAt: now,
      },
    });
    const memberProfile = await tx.memberProfile.create({
      data: {
        id: randomUUID(),
        displayName: `${label} Member`,
        userId: member.id,
        familyId: family.id,
      },
    });
    const paidAt = new Date(now.getTime() - 60_000);
    const subscription = await tx.subscription.create({
      data: {
        familyId: family.id,
        externalId: `member_invite_${randomUUID()}`,
        providerSubscriptionId: `subs_${randomUUID()}`,
        providerProductId: 'prod_integration_monthly',
        providerStatus: 'ACTIVE',
        lastProviderEvent: 'subscription.renewed',
        providerUpdatedAt: now,
        lastSuccessfulPaymentAt: paidAt,
        accessPaidThrough: new Date(now.getTime() + 31 * 24 * 60 * 60_000),
        lastInstallmentNumber: 2,
        entitlementContractVersion: 'integration-contract-v1',
        amountCents: 2_990,
        paymentMethod: SubscriptionPaymentMethod.CARD,
        billingCycle: SubscriptionCycle.MONTHLY,
        devMode: true,
      },
    });
    await tx.family.update({
      where: { id: family.id },
      data: {
        ownerUserId: owner.id,
        currentSubscriptionId: subscription.id,
      },
    });

    return {
      familyId: family.id,
      subscriptionId: subscription.id,
      ownerId: owner.id,
      ownerProfileId: ownerProfile.id,
      ownerEmail: owner.email,
      memberId: member.id,
      memberProfileId: memberProfile.id,
      memberEmail: member.email,
    };
  });
}

async function cancelSubscription(prisma: PrismaClient, subscriptionId: string) {
  const now = new Date();
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      providerStatus: 'CANCELLED',
      lastProviderEvent: 'subscription.cancelled',
      providerUpdatedAt: now,
      cancelledAt: now,
      cancelledDueTo: 'provider_cancelled',
    },
  });
}

async function readVerificationCode(
  prisma: PrismaClient,
  crypto: ActionTokenCryptoService,
  challengeId: string,
): Promise<string> {
  const token = await prisma.userActionToken.findUniqueOrThrow({
    where: { id: challengeId },
    include: { emailOutbox: true },
  });
  if (!token.emailOutbox?.payloadCiphertext) {
    throw new Error('Outbox de verificação ausente');
  }
  const payload = crypto.decryptOutboxPayload(token.emailOutbox.id, {
    payloadCiphertext: token.emailOutbox.payloadCiphertext,
    payloadKeyVersion: token.emailOutbox.payloadKeyVersion,
  });
  if (payload.kind !== 'email_verification') {
    throw new Error('Payload não é uma verificação de email');
  }
  return payload.code;
}

async function createInvite(
  baseUrl: string,
  cookie: string,
  email?: string,
): Promise<InviteResponse> {
  const response = await postJson(baseUrl, cookie, '/member-invites', {
    ...(email ? { email } : {}),
    expiresInDays: 7,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = asRecord(await response.json());
  expect(body.token).toBeUndefined();
  const link = readString(body, 'link');
  const inviteUrl = new URL(link);
  expect(inviteUrl.origin).toBe(new URL(WEB_ORIGIN).origin);
  expect(inviteUrl.search).toBe('');
  expect(inviteUrl.hash).toBe('');
  const pathParts = inviteUrl.pathname.split('/').filter(Boolean);
  expect(pathParts).toHaveLength(2);
  expect(pathParts[0]).toBe('convite');
  const token = pathParts[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(inviteUrl.pathname).toBe(`/convite/${token}`);
  return {
    id: readString(body, 'id'),
    token,
    link,
    email: typeof body.email === 'string' ? body.email : null,
    status: readString(body, 'status'),
  };
}

async function sessionCookie(prisma: PrismaClient, jwt: JwtService, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: true,
      family: { select: { ownerUserId: true } },
    },
  });
  if (!user.profile || !user.emailVerifiedAt || !user.isActive) {
    throw new Error(`Fixture ${userId} não pode receber sessão`);
  }
  const token = await jwt.signAsync({
    jti: randomUUID(),
    sub: user.id,
    email: user.email,
    platformRole: user.platformRole,
    tenantRole: user.family.ownerUserId === user.id ? 'owner' : 'member',
    familyId: user.familyId,
    profileId: user.profile.id,
    authVersion: user.authVersion,
  });
  return `financeiro_session=${token}`;
}

function readRuntimeEnv(name: string): string {
  const inherited = process.env[name]?.trim();
  if (inherited) return inherited;

  const prefix = `${name}=`;
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith(prefix));
  let value = line?.trimStart().slice(prefix.length).trim();
  if (
    value &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error(`${name} ausente no ambiente de integração`);
  return value;
}

function postJson(
  baseUrl: string,
  cookie: string | undefined,
  path: string,
  body: Record<string, unknown>,
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
      origin: WEB_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Resposta JSON inválida');
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Campo ${key} inválido`);
  return value;
}
