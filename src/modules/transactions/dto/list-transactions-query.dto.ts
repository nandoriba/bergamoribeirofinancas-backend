import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class ListTransactionsQueryDto {
  @IsOptional()
  @Matches(MONTH_PATTERN)
  referenceMonth?: string;

  @IsOptional()
  @Matches(MONTH_PATTERN)
  month?: string;

  @IsOptional()
  @IsUUID('4')
  profileId?: string;

  @IsOptional()
  @IsUUID('4')
  cursor?: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
