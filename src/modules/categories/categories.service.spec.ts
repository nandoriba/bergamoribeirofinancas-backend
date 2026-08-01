import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../auth/auth.types';
import { TenantContext } from '../../shared/tenant-context';
import { CategoriesService } from './categories.service';

describe('CategoriesService', () => {
  const context = TenantContext.fromAuthenticatedUser({
    id: 'user-1',
    email: 'member@example.com',
    platformRole: 'user',
    tenantRole: 'member',
    familyId: 'family-1',
    profileId: 'profile-1',
  } satisfies AuthenticatedUser);

  it('lists and creates categories only in the authenticated family', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const create = vi.fn(async (args) => args.data);
    const service = new CategoriesService({ category: { findMany, create } } as never);

    await service.list(context);
    await service.create(context, {
      name: ' Alimentação ',
      type: 'expense',
      color: '#123456',
      aliases: [' mercado ', ''],
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1' },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        name: 'Alimentação',
        type: 'expense',
        color: '#123456',
        aliases: ['mercado'],
        familyId: 'family-1',
      },
    });
  });

  it('blocks category ids from another tenant', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const service = new CategoriesService({ category: { findFirst, update } } as never);

    await expect(service.update(context, 'foreign-category', { name: 'Alterada' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Categoria não encontrada' }),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-category', familyId: 'family-1' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps familyId in the final update and delete predicates', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'category-1', familyId: 'family-1' });
    const update = vi.fn().mockResolvedValue({ id: 'category-1' });
    const remove = vi.fn().mockResolvedValue({ id: 'category-1' });
    const service = new CategoriesService({ category: { findFirst, update, delete: remove } } as never);

    await service.update(context, 'category-1', { name: 'Moradia' });
    await service.remove(context, 'category-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'category-1', familyId: 'family-1' } }),
    );
    expect(remove).toHaveBeenCalledWith({ where: { id: 'category-1', familyId: 'family-1' } });
  });
});
