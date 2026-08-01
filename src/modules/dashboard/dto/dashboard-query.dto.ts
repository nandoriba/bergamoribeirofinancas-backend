import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID, Matches } from 'class-validator';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseStrictBoolean({ value }: { value: unknown }) {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}

export class DashboardQueryDto {
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
  @Transform(parseStrictBoolean)
  @IsBoolean()
  family?: boolean;
}
