import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { UpdateInstallmentDto } from './update-installment.dto';

describe('UpdateInstallmentDto', () => {
  it('aceita somente os campos que não desalinham as parcelas materializadas', async () => {
    const dto = plainToInstance(UpdateInstallmentDto, { description: 'Novo nome', paidInstallments: 2 });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it.each(['monthlyAmountCents', 'totalInstallments', 'accountId', 'firstReferenceMonth']) (
    'rejeita alteração estrutural em %s',
    async (field) => {
      const dto = plainToInstance(UpdateInstallmentDto, { [field]: 'valor' });
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.some((error) => error.property === field)).toBe(true);
    },
  );
});
