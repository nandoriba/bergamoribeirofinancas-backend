import { CategoryType } from '@prisma/client';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsEnum(CategoryType)
  type!: CategoryType;

  @IsString()
  @Matches(/^#([0-9a-fA-F]{6})$/)
  color!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}
