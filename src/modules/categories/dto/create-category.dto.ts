import { CategoryType } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
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

