import { RecurrenceType, TransactionStatus, TransactionType } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateTransactionDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsDateString()
  applicationDate!: string;

  @IsOptional()
  @IsDateString()
  referenceMonth?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsEnum(TransactionType)
  type!: TransactionType;

  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  installmentNumber?: number;

  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}
