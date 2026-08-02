import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { GenerateRecurringQueryDto } from '../generate-recurring-query.dto';

describe('GenerateRecurringQueryDto', () => {
  it.each([{}, { month: '2026-07' }])('aceita query válida %#', async (input) => {
    expect(await validate(plainToInstance(GenerateRecurringQueryDto, input))).toEqual([]);
  });

  it.each(['abc', '2026-00', '2026-13', '07-2026', '2026-7'])('rejeita mês inválido %s', async (month) => {
    const errors = await validate(plainToInstance(GenerateRecurringQueryDto, { month }));
    expect(errors.some((error) => error.property === 'month')).toBe(true);
  });
});
