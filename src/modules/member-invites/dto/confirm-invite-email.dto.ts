import { IsString, IsUUID, Matches } from 'class-validator';

export class ConfirmInviteEmailDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
