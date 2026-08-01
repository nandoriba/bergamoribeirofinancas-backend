import { IsUUID } from 'class-validator';

export class ResendEmailVerificationDto {
  @IsUUID()
  challengeId!: string;
}
