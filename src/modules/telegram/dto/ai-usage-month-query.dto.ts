import { IsOptional, Matches } from 'class-validator';

export class AiUsageMonthQueryDto {
  @IsOptional()
  @Matches(/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/)
  month?: string;
}
