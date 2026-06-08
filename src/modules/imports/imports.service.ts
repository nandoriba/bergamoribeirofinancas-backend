import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ImportRowStatus, Prisma, TransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { normalizeAmountCents } from '../../shared/finance-calculator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { ImportParserService, type ParsedImportRow } from './import-parser.service';

export interface UploadedCsvFile {
  originalname: string;
  buffer: Buffer;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: ImportParserService,
  ) {}

  listBatches(user: AuthenticatedUser) {
    return this.prisma.importBatch.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: { _count: { select: { rows: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async preview(user: AuthenticatedUser, file?: UploadedCsvFile) {
    if (!file) throw new BadRequestException('Arquivo CSV obrigatório');
    const parsed = this.parser.parse(file.originalname, file.buffer.toString('utf8'));
    if (parsed.rows.length === 0) throw new BadRequestException('Arquivo sem linhas para importar');

    const categories = await this.prisma.category.findMany({ where: { familyId: user.familyId } });
    const existingExternalIds = await this.findExistingExternalIds(
      user.profileId,
      parsed.rows.map((row) => row.externalId).filter((id): id is string => Boolean(id)),
    );
    const seen = new Set<string>();

    const batch = await this.prisma.importBatch.create({
      data: {
        fileName: file.originalname,
        type: parsed.type,
        status: 'preview',
        memberProfileId: user.profileId,
        rows: {
          create: parsed.rows.map((row) => {
            const status = this.resolveRowStatus(row, existingExternalIds, seen);
            return {
              rowIndex: row.rowIndex,
              raw: row.raw as Prisma.InputJsonValue,
              date: row.date,
              description: row.description,
              amountCents: row.amountCents,
              externalId: row.externalId,
              suggestedCategory: this.resolveSuggestedCategory(row, categories),
              status,
            };
          }),
        },
      },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });

    return {
      batchId: batch.id,
      fileName: batch.fileName,
      type: batch.type,
      rows: batch.rows.map((row) => this.mapPreviewRow(row, batch.type)),
    };
  }

  async confirm(user: AuthenticatedUser, dto: ConfirmImportDto) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: dto.batchId, memberProfile: { familyId: user.familyId }, status: 'preview' },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Prévia de importação não encontrada');

    const selectedRows = dto.rowIds?.length
      ? batch.rows.filter((row) => dto.rowIds?.includes(row.id))
      : batch.rows;
    const importableRows = selectedRows.filter(
      (row) => row.status === 'new' && row.date && row.description && row.amountCents !== null,
    );

    const categories = await this.prisma.category.findMany({ where: { familyId: user.familyId } });
    const categoryByName = new Map(categories.map((category) => [`${category.type}:${category.name}`, category.id]));

    const created = [];
    for (const row of importableRows) {
      const signedAmount = row.amountCents ?? 0;
      const type: TransactionType = signedAmount >= 0 ? 'income' : 'expense';
      const categoryId = row.suggestedCategory ? categoryByName.get(`${type}:${row.suggestedCategory}`) : undefined;

      const transaction = await this.prisma.transaction.upsert({
        where: {
          memberProfileId_externalId: {
            memberProfileId: user.profileId,
            externalId: row.externalId ?? row.id,
          },
        },
        update: {},
        create: {
          date: row.date as Date,
          description: row.description ?? 'Importado',
          amountCents: normalizeAmountCents(signedAmount),
          type,
          status: 'confirmed',
          recurrenceType: 'none',
          source: batch.type,
          externalId: row.externalId ?? row.id,
          categoryId,
          memberProfileId: user.profileId,
          importRowId: row.id,
        },
      });

      await this.prisma.importRow.update({
        where: { id: row.id },
        data: { status: ImportRowStatus.imported },
      });
      created.push(transaction);
    }

    await this.prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'confirmed' },
    });

    return {
      batchId: batch.id,
      imported: created.length,
      ignored: batch.rows.length - created.length,
    };
  }

  private async findExistingExternalIds(memberProfileId: string, externalIds: string[]) {
    if (externalIds.length === 0) return new Set<string>();
    const transactions = await this.prisma.transaction.findMany({
      where: { memberProfileId, externalId: { in: externalIds } },
      select: { externalId: true },
    });
    return new Set(transactions.map((transaction) => transaction.externalId).filter((id): id is string => Boolean(id)));
  }

  private resolveRowStatus(row: ParsedImportRow, existingExternalIds: Set<string>, seen: Set<string>): ImportRowStatus {
    if (row.status === 'review' || !row.externalId) return ImportRowStatus.review;
    if (existingExternalIds.has(row.externalId) || seen.has(row.externalId)) return ImportRowStatus.duplicate;
    seen.add(row.externalId);
    return ImportRowStatus.new;
  }

  private resolveSuggestedCategory(
    row: ParsedImportRow,
    categories: Awaited<ReturnType<PrismaService['category']['findMany']>>,
  ): string {
    const type = (row.amountCents ?? 0) >= 0 ? 'income' : 'expense';
    const requested = row.suggestedCategory;
    if (requested && categories.some((category) => category.type === type && category.name === requested)) {
      return requested;
    }
    return categories.find((category) => category.type === type && category.name === 'Outros')?.name ?? 'Outros';
  }

  private mapPreviewRow(
    row: {
      id: string;
      date: Date | null;
      description: string | null;
      amountCents: number | null;
      suggestedCategory: string | null;
      status: ImportRowStatus;
    },
    source: string,
  ) {
    return {
      id: row.id,
      date: row.date
        ? `${String(row.date.getUTCDate()).padStart(2, '0')}/${String(row.date.getUTCMonth() + 1).padStart(2, '0')}`
        : '-',
      description: row.description ?? 'Linha em revisão',
      source,
      suggestedCategory: row.suggestedCategory ?? 'Revisar',
      value: row.amountCents ?? 0,
      status: row.status,
    };
  }
}
