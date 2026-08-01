import { IsOptional, IsUUID } from 'class-validator';

export class ListRecurringQueryDto {
  @IsOptional()
  @IsUUID('4')
  profileId?: string;
}
