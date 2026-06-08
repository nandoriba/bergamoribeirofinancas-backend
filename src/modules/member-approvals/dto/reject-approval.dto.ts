import { IsOptional, IsString } from 'class-validator';

export class RejectApprovalDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

