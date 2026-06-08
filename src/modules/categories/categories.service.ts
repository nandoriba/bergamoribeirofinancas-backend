import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.category.findMany({
      where: { familyId: user.familyId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  create(user: AuthenticatedUser, dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: {
        ...dto,
        aliases: dto.aliases ?? [],
        familyId: user.familyId,
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateCategoryDto) {
    await this.ensureCategory(user, id);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureCategory(user, id);
    return this.prisma.category.delete({ where: { id } });
  }

  private async ensureCategory(user: AuthenticatedUser, id: string) {
    const category = await this.prisma.category.findFirst({ where: { id, familyId: user.familyId } });
    if (!category) {
      throw new NotFoundException('Categoria não encontrada');
    }
    return category;
  }
}

