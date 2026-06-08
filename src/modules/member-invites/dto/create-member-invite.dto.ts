import { IsEmail, IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateMemberInviteDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number = 7;
}

