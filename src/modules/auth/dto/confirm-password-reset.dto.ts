import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConfirmPasswordResetDto {
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  passwordConfirmation!: string;
}
