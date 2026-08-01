import { OAuthIntent } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DISPLAY_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

function normalizeDisplayText(value: unknown) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return value;
  return value.trim().replace(/\s+/g, ' ');
}

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

  @IsOptional()
  @Transform(({ value }) => normalizeDisplayText(value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(DISPLAY_TEXT_PATTERN)
  ownerName?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeDisplayText(value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(DISPLAY_TEXT_PATTERN)
  familyName?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalAcceptanceVersion?: string;
}
