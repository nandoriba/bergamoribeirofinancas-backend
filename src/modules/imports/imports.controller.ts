import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { DiscardImportDto } from './dto/discard-import.dto';
import { ListImportBatchesQueryDto } from './dto/list-import-batches-query.dto';
import { ImportsService, type UploadedCsvFile } from './imports.service';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Get('batches')
  listBatches(@CurrentTenant() context: TenantContext, @Query() query: ListImportBatchesQueryDto) {
    return this.importsService.listBatches(context, query);
  }

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(@CurrentTenant() context: TenantContext, @UploadedFile() file?: UploadedCsvFile) {
    return this.importsService.preview(context, file);
  }

  @Post('confirm')
  confirm(@CurrentTenant() context: TenantContext, @Body() dto: ConfirmImportDto) {
    return this.importsService.confirm(context, dto);
  }

  @Post('discard')
  discard(@CurrentTenant() context: TenantContext, @Body() dto: DiscardImportDto) {
    return this.importsService.discard(context, dto);
  }
}
