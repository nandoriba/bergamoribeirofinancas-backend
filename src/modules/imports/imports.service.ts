import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ImportRowStatus, Prisma, TransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { startOfMonth } from '../../shared/date-range';
import { normalizeAmountCents } from '../../shared/finance-calculator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { InstallmentsService } from '../installments/installments.service';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { DiscardImportDto } from './dto/discard-import.dto';
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
    private readonly installmentsService: InstallmentsService,
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
    const account = dto.accountId
      ? await this.prisma.account.findFirst({ where: { id: dto.accountId, memberProfileId: user.profileId } })
      : null;
    if (dto.accountId && !account) throw new BadRequestException('Conta inválida');

    const created = [];
    const bookkeepingDate = new Date();
    for (const row of importableRows) {
      const signedAmount = row.amountCents ?? 0;
      const type: TransactionType = signedAmount >= 0 ? 'income' : 'expense';
      const categoryId = row.suggestedCategory ? categoryByName.get(`${type}:${row.suggestedCategory}`) : undefined;
      const installment = readInstallment(row.raw);

      if (installment && account?.type === 'credit_card' && type === 'expense' && row.date) {
        const baseDescription = stripInstallment(row.description ?? 'Importado');
        const referenceMonth = startOfMonth(row.date);
        const existingProjected = await this.prisma.transaction.findFirst({
          where: {
            memberProfileId: user.profileId,
            accountId: account.id,
            referenceMonth,
            amountCents: normalizeAmountCents(signedAmount),
            installmentNumber: installment.current,
            description: { contains: baseDescription, mode: 'insensitive' },
          },
        });

        if (existingProjected) {
          await this.prisma.importRow.update({ where: { id: row.id }, data: { status: ImportRowStatus.duplicate } });
          continue;
        }

        const plan = await this.installmentsService.create(user, {
          description: baseDescription,
          totalInstallments: installment.total,
          firstInstallmentNumber: installment.current,
          monthlyAmountCents: normalizeAmountCents(signedAmount),
          totalAmountCents: normalizeAmountCents(signedAmount) * installment.total,
          startsAt: bookkeepingDate.toISOString(),
          firstReferenceMonth: referenceMonth.toISOString(),
          accountId: account.id,
          categoryId,
          confirmExistingLinks: true,
        });

        await this.prisma.importRow.update({ where: { id: row.id }, data: { status: ImportRowStatus.imported } });
        created.push(plan);
        continue;
      }

      const invoiceId =
        account?.type === 'credit_card' && row.date
          ? await this.findOrCreateInvoice(account.id, user.profileId, startOfMonth(row.date))
          : undefined;

      const transaction = await this.prisma.transaction.upsert({
        where: {
          memberProfileId_externalId: {
            memberProfileId: user.profileId,
            externalId: row.externalId ?? row.id,
          },
        },
        update: {},
        create: {
          date: bookkeepingDate,
          referenceMonth: startOfMonth(row.date as Date),
          description: row.description ?? 'Importado',
          amountCents: normalizeAmountCents(signedAmount),
          type,
          status: 'confirmed',
          recurrenceType: 'none',
          source: batch.type,
          externalId: row.externalId ?? row.id,
          accountId: account?.id,
          invoiceId,
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

  async discard(user: AuthenticatedUser, dto: DiscardImportDto) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: dto.batchId, memberProfile: { familyId: user.familyId }, status: 'preview' },
      include: { rows: { select: { id: true } } },
    });
    if (!batch) throw new NotFoundException('Prévia de importação não encontrada');

    await this.prisma.$transaction([
      this.prisma.importRow.updateMany({
        where: { importBatchId: batch.id },
        data: { status: ImportRowStatus.ignored },
      }),
      this.prisma.importBatch.update({
        where: { id: batch.id },
        data: { status: 'discarded' },
      }),
    ]);

    return {
      batchId: batch.id,
      discarded: batch.rows.length,
    };
  }

  private async findOrCreateInvoice(accountId: string, memberProfileId: string, referenceMonth: Date) {
    const invoice = await this.prisma.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId,
          referenceMonth,
        },
      },
      update: {},
      create: {
        accountId,
        memberProfileId,
        referenceMonth,
        status: 'open',
      },
    });
    return invoice.id;
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

function readInstallment(raw: Prisma.JsonValue): { current: number; total: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('installment' in raw)) return null;
  const value = String((raw as { installment?: unknown }).installment ?? '');
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return current > 0 && total >= current ? { current, total } : null;
}

function stripInstallment(description: string) {
  return description
    .replace(/(?:parcela\s*)?\d{1,2}\s*\/\s*\d{1,2}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
