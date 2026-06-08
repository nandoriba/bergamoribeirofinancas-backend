import { IsDateString, IsInt, IsString, Min } from 'class-validator';

export class CreateInstallmentDto {
  @IsString()
  description!: string;

  @IsInt()
  @Min(1)
  totalInstallments!: number;

  @IsInt()
  @Min(0)
  paidInstallments?: number = 0;

  @IsInt()
  monthlyAmountCents!: number;

  @IsInt()
  totalAmountCents!: number;

  @IsDateString()
  startsAt!: string;
}

