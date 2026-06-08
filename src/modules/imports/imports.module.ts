import { Module } from '@nestjs/common';

import { InstallmentsModule } from '../installments/installments.module';
import { ImportParserService } from './import-parser.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [InstallmentsModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportParserService],
  exports: [ImportsService],
})
export class ImportsModule {}
