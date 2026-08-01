import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  list(context: TenantContext) {
    return this.prisma.category.findMany({
      where: this.tenantScope.byFamily(context),
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  create(context: TenantContext, dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: {
        ...dto,
        name: dto.name.trim(),
        aliases: normalizeAliases(dto.aliases),
        familyId: context.familyId,
      },
    });
  }

  async update(context: TenantContext, id: string, dto: UpdateCategoryDto) {
    await this.ensureCategory(context, id);
    return this.prisma.category.update({
      where: { id, ...this.tenantScope.byFamily(context) },
      data: {
        ...dto,
        name: dto.name?.trim(),
        aliases: dto.aliases ? normalizeAliases(dto.aliases) : undefined,
      },
    });
  }

  async remove(context: TenantContext, id: string) {
    await this.ensureCategory(context, id);
    return this.prisma.category.delete({ where: { id, ...this.tenantScope.byFamily(context) } });
  }

  private async ensureCategory(context: TenantContext, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, ...this.tenantScope.byFamily(context) },
    });
    if (!category) {
      throw new NotFoundException('Categoria não encontrada');
    }
    return category;
  }
}

function normalizeAliases(aliases?: string[]) {
  return aliases?.map((alias) => alias.trim()).filter(Boolean) ?? [];
}
