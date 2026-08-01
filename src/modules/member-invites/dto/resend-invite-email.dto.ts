import { IsUUID } from 'class-validator';

export class ResendInviteEmailDto {
  @IsUUID()
  challengeId!: string;
}
