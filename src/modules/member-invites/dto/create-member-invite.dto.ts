import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator';

export class CreateMemberInviteDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number = 7;
}
