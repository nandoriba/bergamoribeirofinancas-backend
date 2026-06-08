import { Module } from '@nestjs/common';

import { ImportParserService } from './import-parser.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService, ImportParserService],
  exports: [ImportsService],
})
export class ImportsModule {}
