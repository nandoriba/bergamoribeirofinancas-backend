import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext, @Query() query: ListInvoicesQueryDto) {
    return this.invoicesService.list(context, query);
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateInvoiceDto) {
    return this.invoicesService.create(context, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoicesService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.invoicesService.remove(context, id);
  }
}
