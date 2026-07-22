import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { DiscardImportDto } from './dto/discard-import.dto';
import { ImportsService, type UploadedCsvFile } from './imports.service';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Get('batches')
  listBatches(@CurrentUser() user: AuthenticatedUser) {
    return this.importsService.listBatches(user);
  }

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: UploadedCsvFile) {
    return this.importsService.preview(user, file);
  }

  @Post('confirm')
  confirm(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConfirmImportDto) {
    return this.importsService.confirm(user, dto);
  }

  @Post('discard')
  discard(@CurrentUser() user: AuthenticatedUser, @Body() dto: DiscardImportDto) {
    return this.importsService.discard(user, dto);
  }
}
