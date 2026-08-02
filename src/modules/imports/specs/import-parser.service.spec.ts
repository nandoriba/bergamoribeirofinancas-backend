import { describe, expect, it } from 'vitest';

import { ImportParserService } from '../import-parser.service';

describe('ImportParserService', () => {
  const parser = new ImportParserService();

  it('parses NU account CSV exports with signed values and identifiers', () => {
    const parsed = parser.parse(
      'NU_123.csv',
      'Data,Valor,Identificador,Descrição\n01/06/2026,"-45,90",abc123,Padaria Centro',
    );

    expect(parsed.type).toBe('nubank_account');
    expect(parsed.rows[0]).toMatchObject({
      amountCents: -4590,
      description: 'Padaria Centro',
      externalId: 'abc123',
      suggestedCategory: 'Alimentação',
      status: 'new',
    });
  });

  it('parses Nubank credit card CSV exports and flags incomplete rows for review', () => {
    const parsed = parser.parse('Nubank_2026-06-01.csv', 'date,title,amount\n2026-06-01,Amazon 01/03,-120.50\n,,');

    expect(parsed.type).toBe('nubank_credit_card');
    expect(parsed.rows[0].amountCents).toBe(-12050);
    expect(parsed.rows[0].raw.installment).toBe('01/03');
    expect(parsed.rows[1].status).toBe('review');
  });

  it('treats credit card purchases as expense candidates even when the CSV amount is positive', () => {
    const parsed = parser.parse('Nubank_2026-06-01.csv', 'date,title,amount\n2026-06-07,Mc Donalds,145.60');

    expect(parsed.type).toBe('nubank_credit_card');
    expect(parsed.rows[0]).toMatchObject({
      amountCents: 14560,
      suggestedCategory: 'Outros',
      status: 'new',
    });
  });

  it('marks received credit card payments as invoice adjustment candidates by default', () => {
    const parsed = parser.parse('Nubank_2026-06-01.csv', 'date,title,amount\n2026-06-07,Pagamento recebido,-4341.62');

    expect(parsed.rows[0]).toMatchObject({
      suggestedCategory: 'Ajuste de fatura',
      invoiceAdjustmentCandidate: true,
      invoiceAdjustmentDefault: true,
      status: 'new',
    });
    expect(parsed.rows[0].raw).toMatchObject({
      invoiceAdjustmentCandidate: 'true',
      invoiceAdjustmentDefault: 'true',
    });
  });

  it('marks card refunds and credits as optional invoice adjustment candidates', () => {
    const parsed = parser.parse('Nubank_2026-06-01.csv', 'date,title,amount\n2026-06-03,Crédito de Bunnycdn,-52.59');

    expect(parsed.rows[0]).toMatchObject({
      invoiceAdjustmentCandidate: true,
      invoiceAdjustmentDefault: false,
      status: 'new',
    });
    expect(parsed.rows[0].raw).toMatchObject({
      invoiceAdjustmentCandidate: 'true',
      invoiceAdjustmentDefault: 'false',
    });
  });
});
