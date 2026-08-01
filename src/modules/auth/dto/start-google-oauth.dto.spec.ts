import { ValidationPipe } from '@nestjs/common';
import { OAuthIntent } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { StartGoogleOAuthDto } from './start-google-oauth.dto';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

async function validate(body: Record<string, unknown>) {
  return pipe.transform(body, { type: 'body', metatype: StartGoogleOAuthDto });
}

describe('StartGoogleOAuthDto', () => {
  it.each(Object.values(OAuthIntent))('accepts only the closed intent vocabulary: %s', async (intent) => {
    await expect(validate({ intent })).resolves.toMatchObject({ intent });
  });

  it('rejects unknown intents and forged tenant or authorization fields', async () => {
    await expect(validate({ intent: 'admin_bypass' })).rejects.toMatchObject({ status: 400 });
    await expect(
      validate({
        intent: OAuthIntent.login,
        userId: 'another-user',
        familyId: 'another-family',
        platformRole: 'admin',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
