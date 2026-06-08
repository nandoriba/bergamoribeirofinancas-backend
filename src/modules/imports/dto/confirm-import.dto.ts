import { IsArray, IsOptional, IsUUID } from 'class-validator';

export class ConfirmImportDto {
  @IsUUID()
  batchId!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  rowIds?: string[];
}
