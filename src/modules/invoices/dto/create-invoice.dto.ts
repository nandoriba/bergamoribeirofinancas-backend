import { InvoiceStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID } from 'class-validator';

export class CreateInvoiceDto {
  @IsDateString()
  referenceMonth!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsDateString()
  closingDate?: string;

  @IsOptional()
  @IsInt()
  totalCents?: number;

  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsUUID()
  accountId!: string;
}

