import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext) {
    return this.categoriesService.list(context);
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(context, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.categoriesService.remove(context, id);
  }
}
