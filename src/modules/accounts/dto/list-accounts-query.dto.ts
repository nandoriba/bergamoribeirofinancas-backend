import { IsOptional, IsUUID } from 'class-validator';

export class ListAccountsQueryDto {
  @IsOptional()
  @IsUUID('4')
  profileId?: string;
}
