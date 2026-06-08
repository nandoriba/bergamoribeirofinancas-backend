import { Module } from '@nestjs/common';

import { MemberInvitesController } from './member-invites.controller';
import { MemberInvitesService } from './member-invites.service';

@Module({
  controllers: [MemberInvitesController],
  providers: [MemberInvitesService],
})
export class MemberInvitesModule {}

