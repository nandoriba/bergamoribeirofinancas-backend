import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { PrismaModule } from "../../prisma/prisma.module";
import { configuration, validateConfig } from "../../shared/configuration";
import { RetentionModule } from "./retention.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateConfig,
    }),
    PrismaModule,
    RetentionModule,
  ],
})
export class RetentionCliModule {}
