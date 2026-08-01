import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListInvoicesQueryDto } from './list-invoices-query.dto';

describe('ListInvoicesQueryDto', () => {
  it('aplica o limite padrão e aceita cursor UUID v4', async () => {
    const dto = plainToInstance(ListInvoicesQueryDto, {
      cursor: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
      referenceMonth: '2026-07',
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto.limit).toBe(12);
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 51 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ cursor: 'cursor-invalido' }, 'cursor'],
    [{ referenceMonth: '2026-13' }, 'referenceMonth'],
    [{ referenceMonth: '07-2026' }, 'referenceMonth'],
  ])('rejeita query inválida %#', async (input, property) => {
    const dto = plainToInstance(ListInvoicesQueryDto, input);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === property)).toBe(true);
  });
});
