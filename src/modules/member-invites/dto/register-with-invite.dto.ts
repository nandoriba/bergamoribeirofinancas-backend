import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const INVITE_TOKEN_PATTERN = /^(?:[A-Fa-f0-9]{48}|[A-Za-z0-9_-]{43})$/;
const DISPLAY_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

function normalizeDisplayText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

export class RegisterWithInviteDto {
  @IsString()
  @Matches(INVITE_TOKEN_PATTERN)
  token!: string;

  @Transform(({ value }) => normalizeDisplayText(value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(DISPLAY_TEXT_PATTERN)
  name!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}
