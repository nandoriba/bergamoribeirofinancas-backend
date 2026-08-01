import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { TenantRetentionService } from "./tenant-retention.service";

@Module({
  imports: [PrismaModule, PaymentsModule],
  providers: [TenantRetentionService],
  exports: [TenantRetentionService],
})
export class RetentionModule {}
