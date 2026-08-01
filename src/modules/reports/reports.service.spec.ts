import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { ReportsService } from './reports.service';

const context = TenantContext.fromAuthenticatedUser({
  id: 'user-1',
  email: 'membro@example.com',
  platformRole: 'user',
  tenantRole: 'member',
  familyId: 'family-1',
  profileId: 'author-profile',
});

describe('ReportsService', () => {
  it('uses the tenant scope to validate an optional profile filter', async () => {
    const transactionFindMany = vi.fn().mockResolvedValue([]);
    const tenantScope = {
      resolveProfileIds: vi.fn().mockResolvedValue(['selected-profile']),
      consistentTransactionRelations: vi.fn().mockReturnValue({}),
    };
    const service = new ReportsService(
      { transaction: { findMany: transactionFindMany } } as never,
      tenantScope as never,
    );

    await service.monthly(context, {
      month: '2026-06',
      profileId: 'selected-profile',
      family: true,
    });

    expect(tenantScope.resolveProfileIds).toHaveBeenCalledWith(context, {
      family: true,
      profileId: 'selected-profile',
    });
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memberProfileId: { in: ['selected-profile'] } }),
      }),
    );
  });

  it('does not query financial data when the selected profile belongs to another tenant', async () => {
    const transactionFindMany = vi.fn();
    const tenantScope = {
      resolveProfileIds: vi.fn().mockRejectedValue(new BadRequestException('Perfil inválido')),
    };
    const service = new ReportsService(
      { transaction: { findMany: transactionFindMany } } as never,
      tenantScope as never,
    );

    await expect(
      service.monthly(context, { month: '2026-06', profileId: 'foreign-profile', family: true }),
    ).rejects.toThrow('Perfil inválido');
    expect(transactionFindMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ month: '2026/06', family: true }, 'Mês inválido'],
    [{ month: '2026-06', from: '2026-01', family: true }, 'Use month ou o intervalo'],
    [{ from: '2026-07', to: '2026-06', family: true }, 'início do intervalo'],
    [{ from: '2024-01', to: '2026-01', family: true }, 'intervalo máximo'],
  ])('rejects an invalid or excessive report range', async (query, expectedMessage) => {
    const service = new ReportsService(
      { transaction: { findMany: vi.fn() } } as never,
      {
        resolveProfileIds: vi.fn().mockResolvedValue(['author-profile']),
        consistentTransactionRelations: vi.fn().mockReturnValue({}),
      } as never,
    );

    await expect(service.monthly(context, query)).rejects.toThrow(expectedMessage);
  });

  it('accepts an inclusive range of up to 24 months', async () => {
    const transactionFindMany = vi.fn().mockResolvedValue([]);
    const service = new ReportsService(
      { transaction: { findMany: transactionFindMany } } as never,
      {
        resolveProfileIds: vi.fn().mockResolvedValue(['author-profile']),
        consistentTransactionRelations: vi.fn().mockReturnValue({}),
      } as never,
    );

    const result = await service.monthly(context, { from: '2024-01', to: '2025-12', family: true });

    expect(result).toMatchObject({ from: '2024-01', to: '2025-12' });
    expect('months' in result && result.months).toHaveLength(24);
    expect(transactionFindMany).toHaveBeenCalledTimes(24);
  });
});
