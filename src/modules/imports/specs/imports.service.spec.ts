import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../shared/tenant-context';
import { ImportParserService } from '../import-parser.service';
import { ImportsService } from '../imports.service';

describe('ImportsService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'fernando@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  });

  it('flags same amount and application date with different descriptions as false duplicate', async () => {
    const service = new ImportsService(buildPreviewPrismaMock() as never, new ImportParserService(), {} as never);

    const preview = await service.preview(context, {
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

    const preview = await service.preview(context, {
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

    const preview = await service.preview(context, {
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
      transactionalPrisma({
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
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(service.confirm(context, { batchId: 'batch-1' })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'POSSIBLE_DUPLICATES_REQUIRE_DECISION',
        rowIds: ['row-1'],
      }),
    });
  });

  it('allows confirming a possible duplicate as duplicate without importing it', async () => {
    const importRowUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const importBatchClaim = vi.fn().mockResolvedValue({ count: 1 });
    const transactionUpsert = vi.fn();
    const service = new ImportsService(
      transactionalPrisma({
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          updateMany: importBatchClaim,
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
        importRow: { updateMany: importRowUpdateMany },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    const result = await service.confirm(context, {
      batchId: 'batch-1',
      confirmedDuplicateRowIds: ['row-1'],
    });

    expect(transactionUpsert).not.toHaveBeenCalled();
    expect(importRowUpdateMany).toHaveBeenCalledWith({
      where: { importBatchId: 'batch-1', id: { in: ['row-1'] } },
      data: { status: 'duplicate', falseDuplicate: false },
    });
    expect(importBatchClaim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 0, ignored: 1 });
  });

  it('allows forcing a strong duplicate import and stores the user decision flag', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchClaim = vi.fn().mockResolvedValue({ count: 1 });
    const transactionUpsert = vi.fn().mockResolvedValue({ id: 'transaction-1', importRowId: 'row-1' });
    const service = new ImportsService(
      transactionalPrisma({
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          updateMany: importBatchClaim,
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
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    const result = await service.confirm(context, {
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
      where: { id: 'row-1', importBatchId: 'batch-1' },
      data: { status: 'imported', falseDuplicate: true },
    });
    expect(importBatchClaim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 1, ignored: 0 });
  });

  it('marks account invoice payments during import', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchClaim = vi.fn().mockResolvedValue({ count: 1 });
    const transactionUpsert = vi.fn().mockResolvedValue({ id: 'transaction-1', importRowId: 'row-1' });
    const service = new ImportsService(
      transactionalPrisma({
        account: { findFirst: vi.fn() },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          updateMany: importBatchClaim,
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
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    await service.confirm(context, { batchId: 'batch-1' });

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
      where: { id: 'row-1', importBatchId: 'batch-1' },
      data: { status: 'imported', falseDuplicate: undefined },
    });
    expect(importBatchClaim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
  });

  it('cleans installment base descriptions imported from card statements before materializing installments', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchClaim = vi.fn().mockResolvedValue({ count: 1 });
    const installmentCreate = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const service = new ImportsService(
      transactionalPrisma({
        account: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'card-1',
            type: 'credit_card',
            closingDay: 5,
            dueDay: 10,
          }),
        },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          updateMany: importBatchClaim,
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_credit_card',
            rows: [
              {
                id: 'row-1',
                status: 'new',
                falseDuplicate: false,
                date: new Date('2026-04-05T00:00:00.000Z'),
                description: 'Dm *Hostingercombr - Parcela 7/12',
                amountCents: 5272,
                externalId: 'card-installment-row',
                raw: { installment: '7/12' },
              },
            ],
          }),
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        transaction: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          upsert: vi.fn(),
        },
      }) as never,
      new ImportParserService(),
      { createInTransaction: installmentCreate } as never,
    );

    const result = await service.confirm(context, {
      batchId: 'batch-1',
      accountId: 'card-1',
    });

    expect(installmentCreate).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        description: 'Dm *Hostingercombr',
      }),
    );
    expect(importRowUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1', importBatchId: 'batch-1' },
      data: { status: 'imported', falseDuplicate: undefined },
    });
    expect(importBatchClaim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 1, ignored: 0 });
  });

  it('imports selected credit card adjustment candidates as invoice-only transactions', async () => {
    const importRowUpdate = vi.fn().mockResolvedValue({});
    const importBatchClaim = vi.fn().mockResolvedValue({ count: 1 });
    const transactionUpsert = vi.fn().mockResolvedValue({ id: 'transaction-1', importRowId: 'row-1' });
    const invoiceUpsert = vi.fn().mockResolvedValue({ id: 'invoice-1' });
    const service = new ImportsService(
      transactionalPrisma({
        account: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'card-1',
            type: 'credit_card',
            closingDay: 5,
            dueDay: 10,
          }),
        },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        importBatch: {
          updateMany: importBatchClaim,
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_credit_card',
            rows: [
              {
                id: 'row-1',
                status: 'new',
                falseDuplicate: false,
                date: new Date('2026-06-03T00:00:00.000Z'),
                description: 'Crédito de Bunnycdn',
                amountCents: -5259,
                externalId: 'card-credit-row',
                raw: {
                  invoiceAdjustmentCandidate: 'true',
                  invoiceAdjustmentDefault: 'false',
                },
              },
            ],
          }),
        },
        importRow: { update: importRowUpdate, updateMany: vi.fn() },
        invoice: { upsert: invoiceUpsert },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    const result = await service.confirm(context, {
      batchId: 'batch-1',
      accountId: 'card-1',
      invoiceAdjustmentRowIds: ['row-1'],
    });

    expect(invoiceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_referenceMonth: {
            accountId: 'card-1',
            referenceMonth: new Date('2026-06-01T00:00:00.000Z'),
          },
          memberProfileId: 'profile-1',
        },
      }),
    );
    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          description: 'Crédito de Bunnycdn',
          amountCents: 5259,
          type: 'expense',
          isInvoiceAdjustment: true,
          invoiceAmountCents: -5259,
          accountId: 'card-1',
          invoiceId: 'invoice-1',
        }),
      }),
    );
    expect(importRowUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1', importBatchId: 'batch-1' },
      data: { status: 'imported', falseDuplicate: undefined },
    });
    expect(importBatchClaim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(result).toMatchObject({ imported: 1, ignored: 0 });
  });

  it('lists only batches authored by the authenticated profile', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ImportsService(
      { importBatch: { findMany } } as never,
      new ImportParserService(),
      {} as never,
    );

    await service.listBatches(context);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberProfileId: 'profile-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });

  it('returns one extra author batch only as pagination evidence', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ id: `batch-${index + 1}` }));
    const findMany = vi.fn().mockResolvedValue(rows);
    const service = new ImportsService(
      { importBatch: { findMany } } as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(service.listBatches(context, { limit: 20 })).resolves.toEqual({
      items: rows.slice(0, 20),
      pageInfo: { hasNextPage: true, nextCursor: 'batch-20' },
    });
  });

  it('rejects a batch cursor outside the author profile', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const service = new ImportsService(
      { importBatch: { findFirst, findMany } } as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(
      service.listBatches(context, {
        limit: 20,
        cursor: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow('Cursor inválido');

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: '00000000-0000-4000-8000-000000000002', memberProfileId: 'profile-1' },
      select: { id: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('fails closed when another request or tenant already claimed the batch', async () => {
    const findFirst = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new ImportsService(
      transactionalPrisma({ importBatch: { updateMany, findFirst } }) as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(service.confirm(context, { batchId: 'foreign-batch' })).rejects.toThrow(
      'Prévia de importação não encontrada',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'foreign-batch', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects every selected row id that is not part of the claimed author batch', async () => {
    const transactionUpsert = vi.fn();
    const service = new ImportsService(
      transactionalPrisma({
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'new',
                falseDuplicate: false,
                date: new Date('2026-06-08T00:00:00.000Z'),
                description: 'Mercado',
                amountCents: -10000,
                raw: {},
              },
            ],
          }),
        },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(
      service.confirm(context, { batchId: 'batch-1', rowIds: ['row-from-another-batch'] }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IMPORT_ROWS_OUTSIDE_BATCH' }),
    });
    expect(transactionUpsert).not.toHaveBeenCalled();
  });

  it('rejects an account outside the author profile before materializing rows', async () => {
    const accountFindFirst = vi.fn().mockResolvedValue(null);
    const transactionUpsert = vi.fn();
    const service = new ImportsService(
      transactionalPrisma({
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [
              {
                id: 'row-1',
                status: 'new',
                falseDuplicate: false,
                date: new Date('2026-06-08T00:00:00.000Z'),
                description: 'Mercado',
                amountCents: -10000,
                raw: {},
              },
            ],
          }),
        },
        category: { findMany: vi.fn().mockResolvedValue([]) },
        account: { findFirst: accountFindFirst },
        transaction: { upsert: transactionUpsert },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(
      service.confirm(context, { batchId: 'batch-1', accountId: 'foreign-account' }),
    ).rejects.toThrow('Conta inválida');
    expect(accountFindFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-account', memberProfileId: 'profile-1' },
    });
    expect(transactionUpsert).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids inside the same selection', async () => {
    const service = new ImportsService(
      transactionalPrisma({
        importBatch: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'batch-1',
            type: 'nubank_account',
            rows: [{ id: 'row-1', status: 'new', description: 'Mercado' }],
          }),
        },
      }) as never,
      new ImportParserService(),
      {} as never,
    );

    await expect(
      service.confirm(context, { batchId: 'batch-1', rowIds: ['row-1', 'row-1'] }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IMPORT_DUPLICATE_ROW_IDS' }),
    });
  });

  it('claims and discards author rows through the same transaction client', async () => {
    const claim = vi.fn().mockResolvedValue({ count: 1 });
    const discardRows = vi.fn().mockResolvedValue({ count: 3 });
    const tx = {
      importBatch: { updateMany: claim },
      importRow: { updateMany: discardRows },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const service = new ImportsService(prisma as never, new ImportParserService(), {} as never);

    await expect(service.discard(context, { batchId: 'batch-1' })).resolves.toEqual({
      batchId: 'batch-1',
      discarded: 3,
    });
    expect(claim).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'discarded' },
    });
    expect(discardRows).toHaveBeenCalledWith({
      where: { importBatchId: 'batch-1' },
      data: { status: 'ignored' },
    });
  });

  it('does not commit the claimed batch when a later row write fails', async () => {
    let committed = false;
    const tx = {
      importBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'batch-1',
          type: 'nubank_account',
          rows: [
            {
              id: 'row-1',
              status: 'new',
              falseDuplicate: false,
              date: new Date('2026-06-08T00:00:00.000Z'),
              description: 'Mercado',
              amountCents: -10000,
              externalId: 'row-external-id',
              raw: {},
            },
          ],
        }),
      },
      category: { findMany: vi.fn().mockResolvedValue([]) },
      account: { findFirst: vi.fn() },
      transaction: { upsert: vi.fn().mockResolvedValue({ id: 'transaction-1', importRowId: 'row-1' }) },
      importRow: { update: vi.fn().mockRejectedValue(new Error('row_write_failed')), updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (txClient: typeof tx) => Promise<unknown>) => {
        const result = await callback(tx);
        committed = true;
        return result;
      }),
    };
    const service = new ImportsService(prisma as never, new ImportParserService(), {} as never);

    await expect(service.confirm(context, { batchId: 'batch-1' })).rejects.toThrow('row_write_failed');
    expect(committed).toBe(false);
    expect(tx.importBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', memberProfileId: 'profile-1', status: 'preview' },
      data: { status: 'confirmed' },
    });
    expect(tx.transaction.upsert).toHaveBeenCalledOnce();
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

function transactionalPrisma(client: { importBatch: Record<string, unknown>; [key: string]: unknown }) {
  const transactionClient = {
    ...client,
    importBatch: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      ...client.importBatch,
    },
  };

  return {
    ...transactionClient,
    $transaction: vi.fn((callback: (tx: typeof transactionClient) => unknown) => callback(transactionClient)),
  };
}
