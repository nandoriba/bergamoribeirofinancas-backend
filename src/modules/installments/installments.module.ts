import { Module } from '@nestjs/common';

import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';

@Module({
  controllers: [InstallmentsController],
  providers: [InstallmentsService],
  exports: [InstallmentsService],
})
export class InstallmentsModule {}
