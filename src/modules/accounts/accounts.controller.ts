import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext) {
    return this.accountsService.list(context);
  }

  @Post()
  create(@CurrentTenant() context: TenantContext, @Body() dto: CreateAccountDto) {
    return this.accountsService.create(context, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() context: TenantContext, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    return this.accountsService.update(context, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() context: TenantContext, @Param('id') id: string) {
    return this.accountsService.remove(context, id);
  }
}
