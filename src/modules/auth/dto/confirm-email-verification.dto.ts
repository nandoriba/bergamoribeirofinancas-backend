import { IsString, IsUUID, Matches } from 'class-validator';

export class ConfirmEmailVerificationDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
