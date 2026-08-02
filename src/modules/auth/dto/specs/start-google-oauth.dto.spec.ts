import { ValidationPipe } from '@nestjs/common';
import { OAuthIntent } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { StartGoogleOAuthDto } from '../start-google-oauth.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function validate(body: Record<string, unknown>) {
  return pipe.transform(body, { type: 'body', metatype: StartGoogleOAuthDto });
}

describe('StartGoogleOAuthDto', () => {
  it.each(Object.values(OAuthIntent))('accepts only the closed intent vocabulary: %s', async (intent) => {
    await expect(validate({ intent })).resolves.toMatchObject({ intent });
  });

  it('rejects unknown intents and forged tenant or authorization fields', async () => {
    await expect(validate({ intent: 'admin_bypass' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      validate({
        intent: OAuthIntent.login,
        userId: 'another-user',
        familyId: 'another-family',
        platformRole: 'admin',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('normalizes the optional owner-signup display fields and legal version', async () => {
    await expect(
      validate({
        intent: OAuthIntent.signup_owner,
        ownerName: '  Ana   Silva  ',
        familyName: ' Família   Silva ',
        legalAcceptanceVersion: ' 2026-08-01 ',
      }),
    ).resolves.toMatchObject({
      intent: OAuthIntent.signup_owner,
      ownerName: 'Ana Silva',
      familyName: 'Família Silva',
      legalAcceptanceVersion: '2026-08-01',
    });
  });

  it('normalizes only the bounded invite token and member name for accept_invite', async () => {
    await expect(
      validate({
        intent: OAuthIntent.accept_invite,
        inviteToken: `  ${'a'.repeat(43)}  `,
        memberName: '  Maria   Ribeiro  ',
      }),
    ).resolves.toMatchObject({
      intent: OAuthIntent.accept_invite,
      inviteToken: 'a'.repeat(43),
      memberName: 'Maria Ribeiro',
    });
  });

  it('rejects malformed invite credentials and client-owned tenant facts', async () => {
    await expect(
      validate({
        intent: OAuthIntent.accept_invite,
        inviteToken: 'short',
        memberName: 'Maria Ribeiro',
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      validate({
        intent: OAuthIntent.accept_invite,
        inviteToken: 'a'.repeat(43),
        memberName: 'Maria\nRibeiro',
        familyId: 'forged-family',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('enforces owner-signup field limits without accepting client-owned facts', async () => {
    await expect(
      validate({
        intent: OAuthIntent.signup_owner,
        ownerName: 'A'.repeat(81),
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      validate({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana\nSilva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      validate({
        intent: OAuthIntent.signup_owner,
        ownerName: 'Ana Silva',
        familyName: 'Família Silva',
        legalAcceptanceVersion: '2026-08-01',
        legalAcceptedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
