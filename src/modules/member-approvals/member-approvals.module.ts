import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MemberApprovalsController } from './member-approvals.controller';
import { MemberApprovalsService } from './member-approvals.service';

@Module({
  imports: [AuthModule],
  controllers: [MemberApprovalsController],
  providers: [MemberApprovalsService],
})
export class MemberApprovalsModule {}
