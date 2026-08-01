import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext, @Query() query: ListTransactionsQueryDto) {
    return this.transactionsService.list(context, {
      referenceMonth: query.referenceMonth ?? query.month,
      profileId: query.profileId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateTransactionDto) {
    return this.transactionsService.create(context, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateTransactionDto) {
    return this.transactionsService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.transactionsService.remove(context, id);
  }
}
