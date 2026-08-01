import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListAccountsQueryDto } from './list-accounts-query.dto';

describe('ListAccountsQueryDto', () => {
  it('accepts an optional UUID v4 profileId', async () => {
    const dto = plainToInstance(ListAccountsQueryDto, {
      profileId: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
    });

    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
  });

  it('rejects malformed or unsupported filters', async () => {
    const dto = plainToInstance(ListAccountsQueryDto, { profileId: 'invalid', familyId: 'forged' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.map((error) => error.property).sort()).toEqual(['familyId', 'profileId']);
  });
});
