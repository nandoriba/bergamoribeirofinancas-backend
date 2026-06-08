import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateInstallmentDto {
  @IsString()
  description!: string;

  @IsInt()
  @Min(1)
  totalInstallments!: number;

  @IsInt()
  @Min(1)
  firstInstallmentNumber: number = 1;

  @IsInt()
  @Min(0)
  paidInstallments?: number = 0;

  @IsInt()
  monthlyAmountCents!: number;

  @IsInt()
  totalAmountCents!: number;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  firstReferenceMonth!: string;

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
  @IsBoolean()
  confirmExistingLinks?: boolean;
}
