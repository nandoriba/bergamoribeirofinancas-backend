import { ThemePreference } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateThemeDto {
  @IsEnum(ThemePreference)
  themePreference!: ThemePreference;
}

