import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListImportBatchesQueryDto } from './list-import-batches-query.dto';

describe('ListImportBatchesQueryDto', () => {
  it('aplica o limite padrão e aceita cursor UUID v4', async () => {
    const dto = plainToInstance(ListImportBatchesQueryDto, {
      cursor: '8e6db1e4-d9eb-4e2c-a284-5c28993f3b85',
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto.limit).toBe(20);
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 51 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ cursor: 'cursor-invalido' }, 'cursor'],
  ])('rejeita query inválida %#', async (input, property) => {
    const dto = plainToInstance(ListImportBatchesQueryDto, input);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === property)).toBe(true);
  });
});
