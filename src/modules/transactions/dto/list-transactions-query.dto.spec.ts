import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListTransactionsQueryDto } from './list-transactions-query.dto';

describe('ListTransactionsQueryDto', () => {
  it('defaults limit to 50 and transforms a valid explicit limit', async () => {
    const defaultQuery = plainToInstance(ListTransactionsQueryDto, { referenceMonth: '2026-08' });
    const explicitQuery = plainToInstance(ListTransactionsQueryDto, { limit: '100' });

    await expect(validate(defaultQuery)).resolves.toHaveLength(0);
    await expect(validate(explicitQuery)).resolves.toHaveLength(0);
    expect(defaultQuery.limit).toBe(50);
    expect(explicitQuery.limit).toBe(100);
  });

  it('rejects an invalid cursor, month or limit', async () => {
    const query = plainToInstance(ListTransactionsQueryDto, {
      cursor: 'foreign-cursor',
      referenceMonth: '2026-13',
      limit: '101',
    });

    const errors = await validate(query);
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['cursor', 'referenceMonth', 'limit']));
  });

  it('is strict under the global whitelist policy', async () => {
    const query = plainToInstance(ListTransactionsQueryDto, { unexpected: 'value' });
    const errors = await validate(query, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors).toEqual([expect.objectContaining({ property: 'unexpected' })]);
  });
});
