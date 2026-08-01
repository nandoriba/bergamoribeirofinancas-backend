import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { GenerateRecurringQueryDto } from './dto/generate-recurring-query.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';
import { RecurringService } from './recurring.service';

@Controller('recurring')
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext) {
    return this.recurringService.list(context);
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateRecurringDto) {
    return this.recurringService.create(context, dto);
  }

  @Post('generate')
  generate(@CurrentTenant() context: TenantContext, @Query() query: GenerateRecurringQueryDto) {
    return this.recurringService.generateForMonth(context, query.month);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateRecurringDto) {
    return this.recurringService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.recurringService.remove(context, id);
  }
}
