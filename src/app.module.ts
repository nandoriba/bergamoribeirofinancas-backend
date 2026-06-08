import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';

import { AccountsModule } from './modules/accounts/accounts.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { InstallmentsModule } from './modules/installments/installments.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MemberApprovalsModule } from './modules/member-approvals/member-approvals.module';
import { MemberInvitesModule } from './modules/member-invites/member-invites.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { RecurringModule } from './modules/recurring/recurring.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { configuration, validateConfig } from './shared/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateConfig,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    MemberInvitesModule,
    MemberApprovalsModule,
    AccountsModule,
    CategoriesModule,
    TransactionsModule,
    InvoicesModule,
    ImportsModule,
    RecurringModule,
    InstallmentsModule,
    DashboardModule,
    ReportsModule,
    JobsModule,
  ],
})
export class AppModule {}

