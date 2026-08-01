import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { DashboardQueryDto } from './dashboard-query.dto';

describe('DashboardQueryDto', () => {
  it('transforms only explicit boolean values', async () => {
    const query = plainToInstance(DashboardQueryDto, {
      referenceMonth: '2026-06',
      profileId: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
      family: 'false',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query.family).toBe(false);
  });

  it('rejects ambiguous filters before they reach the tenant scope', async () => {
    const query = plainToInstance(DashboardQueryDto, {
      month: '06/2026',
      profileId: 'foreign-profile',
      family: 'yes',
    });

    const errors = await validate(query);
    expect(errors.map((error) => error.property).sort()).toEqual(['family', 'month', 'profileId']);
  });
});
