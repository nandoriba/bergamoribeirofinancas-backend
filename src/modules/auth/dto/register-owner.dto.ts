import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DISPLAY_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

function normalizeDisplayText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

export class RegisterOwnerDto {
  @Transform(({ value }) => normalizeDisplayText(value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(DISPLAY_TEXT_PATTERN)
  ownerName!: string;

  @Transform(({ value }) => normalizeDisplayText(value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(DISPLAY_TEXT_PATTERN)
  familyName!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalAcceptanceVersion!: string;
}
