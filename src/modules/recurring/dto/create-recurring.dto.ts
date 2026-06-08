import { RecurringStatus, TransactionType } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateRecurringDto {
  @IsString()
  description!: string;

  @IsInt()
  amountCents!: number;

  @IsEnum(TransactionType)
  type!: TransactionType;

  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth!: number;

  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsEnum(RecurringStatus)
  status?: RecurringStatus;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

