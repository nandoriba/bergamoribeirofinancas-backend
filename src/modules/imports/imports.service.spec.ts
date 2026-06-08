import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { ImportParserService } from './import-parser.service';
import { ImportsService } from './imports.service';

describe('ImportsService', () => {
  const user: AuthenticatedUser = {
    id: 'user-1',
    email: 'fernando@example.com',
    role: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  };

  it('flags same amount and application date with different descriptions as false duplicate', async () => {
    const service = new ImportsService(buildPreviewPrismaMock() as never, new ImportParserService(), {} as never);

    const preview = await service.preview(user, {
      originalname: 'NU_123.csv',
      buffer: Buffer.from(
        [
          'Data,Valor,Identificador,Descrição',
          '08/06/2026,-100.00,id-1,Mercado',
          '08/06/2026,-100.00,id-2,Farmácia',
        ].join('\n'),
      ),
    });

    expect(preview.rows[0]).toMatchObject({ status: 'new' });
    expect(preview.rows[1]).toMatchObject({
      status: 'possible_duplicate',
      duplicateCandidates: [
        expect.objectContaining({
          description: 'Mercado',
          applicationDate: '2026-06-08',
          amountCents: -10000,
          source: 'Prévia atual',
        }),
      ],
    });
    expect(preview.rows[1]).not.toHaveProperty('falseDuplicate');
  });

  it('flags same amount, application date and description as duplicate with comparison evidence', async () => {
    const service = new ImportsService(buildPreviewPrismaMock() as never, new ImportParserService(), {} as never);

    const preview = await service.preview(user, {
      originalname: 'NU_123.csv',
      buffer: Buffer.from(
        [
          'Data,Valor,Identificador,Descrição',
          '08/06/2026,-100.00,id-1,Mercado',
          '08/06/2026,-100.00,id-2, mercado ',
        ].join('\n'),
      ),
    });

    expect(preview.rows[0]).toMatchObject({ status: 'new' });
    expect(preview.rows[1]).toMatchObject({
      status: 'duplicate',
      duplicateCandidates: [
        expect.objectContaining({
          description: 'Mercado',
          applicationDate: '2026-06-08',
          amountCents: -10000,
          source: 'Prévia atual',
        }),
      ],
    });
    expect(preview.rows[1]).not.toHaveProperty('falseDuplicate');
  });

  it('does not flag opposite signed amounts as duplicates', async () => {
    const service = new ImportsService(buildPreviewPrismaMock() as never, new ImportParserService(), {} as never);

    const preview = await service.preview(user, {
      originalname: 'NU_123.csv',
      buffer: Buffer.from(
        [
          'Data,Valor,Identificador,Descrição',
          '03/04/2026,"-106,97",id-1,Compra no débito via NuPay - iFood',
          '03/04/2026,"106,97",id-2,Estorno - Compra no débito via NuPay - iFood',
        ].join('\n'),
      ),
    });

    expect(preview.rows[0]).toMatchObject({ status: 'new' });
    expect(preview.rows[1]).toMatchObject({ status: 'new', duplicateCandidates: [] });
  });

  it('blocks confirming possible duplicates without an explicit decision', async () => {
    const service = new ImportsService(
      {
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'duplicate',
                falseDuplicate: true,
                date: new Date('2026-06-08T00:00:00.000Z'),
                description: 'Farmácia',
                amountCents: -10000,
              },
            ],
          }),
        },
      } as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(service.confirm(user, { batchId: 'batch-1' })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'POSSIBLE_DUPLICATES_REQUIRE_DECISION',
        rowIds: ['row-1'],
      }),
    });
  });

  it('allows confirming a possible duplicate as duplicate without importing it', async () => {
    const importRowUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const importBatchUpdate = vi.fn().mockResolvedValue({});
    const transactionUpsert = vi.fn();
    const service = new ImportsService(
      {
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'duplicate',
                falseDuplicate: true,
                date: new Date('2026-06-08T00:00:00.000Z'),
                description: 'Farmácia',
                amountCents: -10000,
              },
            ],
          }),
          update: importBatchUpdate,
        },
        importRow: { updateMany: importRowUpdateMany },
        transaction: { upsert: transactionUpsert },
      } as never,
      new ImportParserService(),
      {} as never,
    );

    const result = await service.confirm(user, {
      batchId: 'batch-1',
      confirmedDuplicateRowIds: ['row-1'],
    });

    expect(transactionUpsert).not.toHaveBeenCalled();
    expect(importRowUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1'] } },
      data: { status: 'duplicate', falseDuplicate: false },
    });
    expect(importBatchUpdate).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 0, ignored: 1 });
  });

  it('allows forcing a strong duplicate import and stores the user decision flag', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchUpdate = vi.fn().mockResolvedValue({});
    const transactionUpsert = vi.fn().mockResolvedValue({ id: 'transaction-1' });
    const service = new ImportsService(
      {
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'duplicate',
                falseDuplicate: false,
                date: new Date('2026-06-08T00:00:00.000Z'),
                description: 'Mercado',
                amountCents: -10000,
                externalId: 'nubank-account:2026-06-08:mercado:-10000',
                raw: {},
              },
            ],
          }),
          update: importBatchUpdate,
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        transaction: { upsert: transactionUpsert },
      } as never,
      new ImportParserService(),
      {} as never,
    );

    const result = await service.confirm(user, {
      batchId: 'batch-1',
      acceptedPossibleDuplicateRowIds: ['row-1'],
    });

    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberProfileId_externalId: {
            memberProfileId: 'profile-1',
            externalId: 'row-1',
          },
        },
        create: expect.objectContaining({
          externalId: 'row-1',
          amountCents: 10000,
          type: 'expense',
        }),
      }),
    );
    expect(importRowUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { status: 'imported', falseDuplicate: true },
    });
    expect(importBatchUpdate).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 1, ignored: 0 });
  });

  it('marks account invoice payments during import', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchUpdate = vi.fn().mockResolvedValue({});
    const transactionUpsert = vi.fn().mockResolvedValue({ id: 'transaction-1' });
    const service = new ImportsService(
      {
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'new',
                falseDuplicate: false,
                date: new Date('2026-06-07T00:00:00.000Z'),
                description: 'Pagamento de fatura',
                amountCents: -434162,
                externalId: 'payment-row',
                raw: {},
              },
            ],
          }),
          update: importBatchUpdate,
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        transaction: { upsert: transactionUpsert },
      } as never,
      new ImportParserService(),
      {} as never,
    );

    await service.confirm(user, { batchId: 'batch-1' });

    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          description: 'Pagamento de fatura',
          amountCents: 434162,
          type: 'expense',
          isInvoicePayment: true,
        }),
      }),
    );
    expect(importRowUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { status: 'imported', falseDuplicate: undefined },
    });
    expect(importBatchUpdate).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: 'confirmed' },
    });
  });
});

function buildPreviewPrismaMock() {
  return {
    category: { findMany: vi.fn().mockResolvedValue([]) },
    transaction: { findMany: vi.fn().mockResolvedValue([]) },
    importBatch: {
      create: vi.fn(
        async (args: { data: { fileName: string; type: string; rows: { create: Record<string, unknown>[] } } }) => ({
          id: 'batch-1',
          fileName: args.data.fileName,
          type: args.data.type,
          rows: args.data.rows.create.map((row: Record<string, unknown>, index: number) => ({
            id: `row-${index + 1}`,
            ...row,
          })),
        }),
      ),
    },
  };
}
