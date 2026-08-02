import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListRecurringQueryDto } from '../list-recurring-query.dto';

describe('ListRecurringQueryDto', () => {
  it('accepts an optional UUID v4 profileId', async () => {
    const dto = plainToInstance(ListRecurringQueryDto, {
      profileId: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
    });

    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
  });

  it('rejects malformed or unsupported filters', async () => {
    const dto = plainToInstance(ListRecurringQueryDto, { profileId: 'invalid', familyId: 'forged' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.map((error) => error.property).sort()).toEqual(['familyId', 'profileId']);
  });
});
