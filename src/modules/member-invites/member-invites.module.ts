import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MemberInvitesController } from './member-invites.controller';
import { MemberInvitesService } from './member-invites.service';

@Module({
  imports: [AuthModule],
  controllers: [MemberInvitesController],
  providers: [MemberInvitesService],
})
export class MemberInvitesModule {}
