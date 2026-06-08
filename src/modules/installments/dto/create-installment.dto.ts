import { IsBoolean, IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateInstallmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
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
  @Min(1)
  monthlyAmountCents!: number;

  @IsInt()
  @Min(1)
  totalAmountCents!: number;

  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsDateString()
  firstApplicationDate?: string;

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
