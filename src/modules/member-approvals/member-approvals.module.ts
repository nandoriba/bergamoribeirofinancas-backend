import { Module } from '@nestjs/common';

import { MemberApprovalsController } from './member-approvals.controller';
import { MemberApprovalsService } from './member-approvals.service';

@Module({
  controllers: [MemberApprovalsController],
  providers: [MemberApprovalsService],
})
export class MemberApprovalsModule {}

