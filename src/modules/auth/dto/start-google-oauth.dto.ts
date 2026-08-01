import { OAuthIntent } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class StartGoogleOAuthDto {
  @IsEnum(OAuthIntent)
  intent!: OAuthIntent;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  returnPath?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword?: string;
}
