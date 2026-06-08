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

    expect(preview.rows[0]).toMatchObject({ status: 'new', falseDuplicate: false });
    expect(preview.rows[1]).toMatchObject({ status: 'duplicate', falseDuplicate: true });
  });

  it('flags same amount, application date and description as blocking duplicate', async () => {
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

    expect(preview.rows[0]).toMatchObject({ status: 'new', falseDuplicate: false });
    expect(preview.rows[1]).toMatchObject({ status: 'duplicate', falseDuplicate: false });
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
