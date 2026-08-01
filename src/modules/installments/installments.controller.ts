import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { ListInstallmentsQueryDto } from './dto/list-installments-query.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import { InstallmentsService } from './installments.service';

@Controller('installments')
export class InstallmentsController {
  constructor(private readonly installmentsService: InstallmentsService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext, @Query() query: ListInstallmentsQueryDto) {
    return this.installmentsService.list(context, query);
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateInstallmentDto) {
    return this.installmentsService.create(context, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateInstallmentDto) {
    return this.installmentsService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.installmentsService.remove(context, id);
  }
}
