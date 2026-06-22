import { IsUUID } from 'class-validator';

export class DiscardImportDto {
  @IsUUID()
  batchId!: string;
}
