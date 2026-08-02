import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { MonthlyReportQueryDto } from '../monthly-report-query.dto';

describe('MonthlyReportQueryDto', () => {
  it('accepts a selected profile and a strict boolean family flag', async () => {
    const query = plainToInstance(MonthlyReportQueryDto, {
      from: '2026-01',
      to: '2026-06',
      profileId: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
      family: 'true',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query.family).toBe(true);
  });

  it('rejects malformed months, profile IDs and boolean aliases', async () => {
    const query = plainToInstance(MonthlyReportQueryDto, {
      from: '2026-00',
      profileId: 'foreign-profile',
      family: '1',
    });

    const errors = await validate(query);
    expect(errors.map((error) => error.property).sort()).toEqual(['family', 'from', 'profileId']);
  });
});
