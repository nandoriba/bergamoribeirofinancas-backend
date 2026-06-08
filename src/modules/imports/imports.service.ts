import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ImportRowStatus, Prisma } from '@prisma/client';
import type { Account, ImportType, TransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { clampDayForMonth, startOfMonth } from '../../shared/date-range';
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

interface DuplicateClassification {
  status: ImportRowStatus;
  falseDuplicate: boolean;
  candidates: DuplicateCandidate[];
}

export interface DuplicateCandidate {
  id?: string;
  description: string;
  applicationDate: string;
  amountCents: number;
  source: string;
  accountName?: string | null;
}

export type ImportPreviewStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'review';

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
    const existingDuplicateCandidates = await this.findExistingDuplicateCandidates(user.profileId, parsed.rows);
    const seenExternalIds = new Set<string>();
    const seenValueDateDescriptions = new Map(existingDuplicateCandidates);

    const batch = await this.prisma.importBatch.create({
      data: {
        fileName: file.originalname,
        type: parsed.type,
        status: 'preview',
        memberProfileId: user.profileId,
        rows: {
          create: parsed.rows.map((row) => {
            const duplicate = this.resolveRowDuplicate(
              row,
              existingExternalIds,
              seenExternalIds,
              seenValueDateDescriptions,
            );
            return {
              rowIndex: row.rowIndex,
              raw: row.raw as Prisma.InputJsonValue,
              date: row.date,
              description: row.description,
              amountCents: row.amountCents,
              externalId: row.externalId,
              suggestedCategory: this.resolveSuggestedCategory(row, categories, parsed.type),
              status: duplicate.status,
              falseDuplicate: duplicate.falseDuplicate,
              duplicateCandidates: duplicate.candidates.length
                ? (duplicate.candidates as unknown as Prisma.InputJsonValue)
                : undefined,
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
      where: { id: dto.batchId, memberProfileId: user.profileId, status: 'preview' },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Prévia de importação não encontrada');

    const selectedRows = dto.rowIds?.length
      ? batch.rows.filter((row) => dto.rowIds?.includes(row.id))
      : batch.rows;
    const acceptedPossibleDuplicateRowIds = new Set(dto.acceptedPossibleDuplicateRowIds ?? []);
    const confirmedDuplicateRowIds = new Set(dto.confirmedDuplicateRowIds ?? []);
    const conflictingPossibleDuplicateDecisions = selectedRows.filter(
      (row) =>
        row.status === 'duplicate' &&
        row.falseDuplicate &&
        acceptedPossibleDuplicateRowIds.has(row.id) &&
        confirmedDuplicateRowIds.has(row.id),
    );
    if (conflictingPossibleDuplicateDecisions.length > 0) {
      throw new BadRequestException({
        code: 'POSSIBLE_DUPLICATES_CONFLICTING_DECISION',
        message: 'Escolha apenas uma decisão por possível duplicidade',
        rowIds: conflictingPossibleDuplicateDecisions.map((row) => row.id),
      });
    }

    const missingPossibleDuplicateDecisions = selectedRows.filter(
      (row) =>
        row.status === 'duplicate' &&
        row.falseDuplicate &&
        !acceptedPossibleDuplicateRowIds.has(row.id) &&
        !confirmedDuplicateRowIds.has(row.id),
    );
    if (missingPossibleDuplicateDecisions.length > 0) {
      throw new BadRequestException({
        code: 'POSSIBLE_DUPLICATES_REQUIRE_DECISION',
        message: 'Escolha se cada possível duplicidade deve ser importada ou ignorada',
        rowIds: missingPossibleDuplicateDecisions.map((row) => row.id),
      });
    }

    const importableRows = selectedRows.filter(
      (row) =>
        (row.status === 'new' ||
          (row.status === 'duplicate' && row.falseDuplicate && acceptedPossibleDuplicateRowIds.has(row.id))) &&
        row.date &&
        row.description &&
        row.amountCents !== null,
    );
    const duplicateRowsToConfirm = selectedRows.filter(
      (row) => row.status === 'duplicate' && row.falseDuplicate && confirmedDuplicateRowIds.has(row.id),
    );

    const categories = await this.prisma.category.findMany({ where: { familyId: user.familyId } });
    const categoryByName = new Map(categories.map((category) => [`${category.type}:${category.name}`, category.id]));
    const account = dto.accountId
      ? await this.prisma.account.findFirst({ where: { id: dto.accountId, memberProfileId: user.profileId } })
      : null;
    if (dto.accountId && !account) throw new BadRequestException('Conta inválida');
    if (batch.type === 'nubank_credit_card' && (!account || account.type !== 'credit_card')) {
      throw new BadRequestException('Selecione o cartão desta fatura para confirmar a importação');
    }

    const created = [];
    const bookkeepingDate = new Date();
    for (const row of importableRows) {
      const signedAmount = row.amountCents ?? 0;
      if (batch.type === 'nubank_credit_card' && isCreditCardAdjustment(row.description)) {
        await this.prisma.importRow.update({ where: { id: row.id }, data: { status: ImportRowStatus.review } });
        continue;
      }

      const type = this.resolveTransactionType(batch.type, signedAmount);
      const categoryId = this.resolveCategoryId(categories, categoryByName, type, row.suggestedCategory);
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
          await this.prisma.importRow.update({
            where: { id: row.id },
            data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
          });
          continue;
        }

        const plan = await this.installmentsService.create(user, {
          description: baseDescription,
          totalInstallments: installment.total,
          firstInstallmentNumber: installment.current,
          monthlyAmountCents: normalizeAmountCents(signedAmount),
          totalAmountCents: normalizeAmountCents(signedAmount) * installment.total,
          startsAt: bookkeepingDate.toISOString(),
          firstApplicationDate: row.date.toISOString(),
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
          ? await this.findOrCreateInvoice(account, user.profileId, startOfMonth(row.date))
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
          applicationDate: row.date as Date,
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

    if (duplicateRowsToConfirm.length > 0) {
      await this.prisma.importRow.updateMany({
        where: { id: { in: duplicateRowsToConfirm.map((row) => row.id) } },
        data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
      });
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
      where: { id: dto.batchId, memberProfileId: user.profileId, status: 'preview' },
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

  private async findOrCreateInvoice(account: Account, memberProfileId: string, referenceMonth: Date) {
    const invoice = await this.prisma.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId: account.id,
          referenceMonth,
        },
      },
      update: {},
      create: {
        accountId: account.id,
        memberProfileId,
        referenceMonth,
        status: 'open',
        closingDate: account.closingDay ? clampDayForMonth(referenceMonth, account.closingDay) : undefined,
        dueDate: account.dueDay ? clampDayForMonth(referenceMonth, account.dueDay) : undefined,
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

  private async findExistingDuplicateCandidates(memberProfileId: string, rows: ParsedImportRow[]) {
    const filters = rows
      .filter((row) => row.date && row.amountCents !== undefined)
      .map((row) => ({
        applicationDate: row.date as Date,
        amountCents: normalizeAmountCents(row.amountCents ?? 0),
      }));

    if (filters.length === 0) return new Map<string, DuplicateCandidate[]>();

    const uniqueFilters = [...new Map(filters.map((filter) => [duplicateKey(filter.applicationDate, filter.amountCents), filter])).values()];
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId,
        OR: uniqueFilters,
      },
      select: {
        id: true,
        applicationDate: true,
        amountCents: true,
        description: true,
        account: { select: { name: true } },
      },
    });

    const candidates = new Map<string, DuplicateCandidate[]>();
    for (const transaction of transactions) {
      addDuplicateCandidate(candidates, {
        id: transaction.id,
        applicationDate: toDateKey(transaction.applicationDate),
        amountCents: normalizeAmountCents(transaction.amountCents),
        description: transaction.description,
        source: 'Sistema',
        accountName: transaction.account?.name,
      });
    }
    return candidates;
  }

  private resolveRowDuplicate(
    row: ParsedImportRow,
    existingExternalIds: Set<string>,
    seenExternalIds: Set<string>,
    seenValueDateDescriptions: Map<string, DuplicateCandidate[]>,
  ): DuplicateClassification {
    if (row.status === 'review') return { status: ImportRowStatus.review, falseDuplicate: false, candidates: [] };

    if (row.externalId && (existingExternalIds.has(row.externalId) || seenExternalIds.has(row.externalId))) {
      return { status: ImportRowStatus.duplicate, falseDuplicate: false, candidates: [] };
    }

    if (row.externalId) seenExternalIds.add(row.externalId);

    if (!row.date || row.amountCents === undefined || !row.description) {
      return { status: ImportRowStatus.review, falseDuplicate: false, candidates: [] };
    }

    const amountCents = normalizeAmountCents(row.amountCents);
    const key = duplicateKey(row.date, amountCents);
    const candidates = seenValueDateDescriptions.get(key);
    const description = normalizeText(row.description);
    const currentCandidate = {
      applicationDate: toDateKey(row.date),
      amountCents,
      description: row.description,
      source: 'Prévia atual',
    };

    if (candidates?.some((candidate) => normalizeText(candidate.description) === description)) {
      return { status: ImportRowStatus.duplicate, falseDuplicate: false, candidates };
    }

    if (candidates && candidates.length > 0) {
      const possibleDuplicateCandidates = [...candidates];
      candidates.push(currentCandidate);
      return {
        status: ImportRowStatus.duplicate,
        falseDuplicate: true,
        candidates: possibleDuplicateCandidates,
      };
    }

    seenValueDateDescriptions.set(key, [currentCandidate]);
    return { status: ImportRowStatus.new, falseDuplicate: false, candidates: [] };
  }

  private resolveSuggestedCategory(
    row: ParsedImportRow,
    categories: Awaited<ReturnType<PrismaService['category']['findMany']>>,
    importType: ImportType,
  ): string {
    if (row.suggestedCategory === 'Revisar') return 'Revisar';
    const type = importType === 'nubank_credit_card' ? 'expense' : (row.amountCents ?? 0) >= 0 ? 'income' : 'expense';
    const requested = row.suggestedCategory;
    if (requested && categories.some((category) => category.type === type && category.name === requested)) {
      return requested;
    }
    return categories.find((category) => category.type === type && category.name === 'Outros')?.name ?? 'Outros';
  }

  private resolveTransactionType(importType: ImportType, amountCents: number): TransactionType {
    if (importType === 'nubank_credit_card') return 'expense';
    return amountCents >= 0 ? 'income' : 'expense';
  }

  private resolveCategoryId(
    categories: Awaited<ReturnType<PrismaService['category']['findMany']>>,
    categoryByName: Map<string, string>,
    type: TransactionType,
    suggestedCategory?: string | null,
  ) {
    if (suggestedCategory) {
      const requested = categoryByName.get(`${type}:${suggestedCategory}`);
      if (requested) return requested;
    }
    return categories.find((category) => category.type === type && category.name === 'Outros')?.id;
  }

  private mapPreviewRow(
    row: {
      id: string;
      date: Date | null;
      description: string | null;
      amountCents: number | null;
      suggestedCategory: string | null;
      status: ImportRowStatus;
      falseDuplicate: boolean;
      duplicateCandidates: Prisma.JsonValue | null;
    },
    source: string,
  ) {
    return {
      id: row.id,
      applicationDate: row.date ? toDateKey(row.date) : null,
      date: row.date
        ? `${String(row.date.getUTCDate()).padStart(2, '0')}/${String(row.date.getUTCMonth() + 1).padStart(2, '0')}`
        : '-',
      description: row.description ?? 'Linha em revisão',
      source,
      suggestedCategory: row.suggestedCategory ?? 'Revisar',
      value: row.amountCents ?? 0,
      status: mapPreviewStatus(row.status, row.falseDuplicate),
      duplicateCandidates: readDuplicateCandidates(row.duplicateCandidates),
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

function isCreditCardAdjustment(description?: string | null): boolean {
  const text = normalizeText(description ?? '');
  return ['pagamento', 'estorno', 'credito', 'reembolso'].some((token) => text.includes(token));
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function duplicateKey(applicationDate: Date, amountCents: number) {
  return `${applicationDate.toISOString().slice(0, 10)}:${normalizeAmountCents(amountCents)}`;
}

function addDuplicateCandidate(candidates: Map<string, DuplicateCandidate[]>, candidate: DuplicateCandidate) {
  const key = `${candidate.applicationDate}:${normalizeAmountCents(candidate.amountCents)}`;
  const items = candidates.get(key) ?? [];
  items.push(candidate);
  candidates.set(key, items);
}

function mapPreviewStatus(status: ImportRowStatus, falseDuplicate: boolean): ImportPreviewStatus {
  if (status === ImportRowStatus.duplicate && falseDuplicate) return 'possible_duplicate';
  if (status === ImportRowStatus.duplicate) return 'duplicate';
  if (status === ImportRowStatus.review) return 'review';
  return 'new';
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function readDuplicateCandidates(value: Prisma.JsonValue | null): DuplicateCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const parsed = parseDuplicateCandidate(candidate);
    return parsed ? [parsed] : [];
  });
}

function parseDuplicateCandidate(value: Prisma.JsonValue): DuplicateCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.description !== 'string' ||
    typeof candidate.applicationDate !== 'string' ||
    typeof candidate.amountCents !== 'number' ||
    typeof candidate.source !== 'string'
  ) {
    return null;
  }

  return {
    id: typeof candidate.id === 'string' ? candidate.id : undefined,
    description: candidate.description,
    applicationDate: candidate.applicationDate,
    amountCents: candidate.amountCents,
    source: candidate.source,
    accountName: typeof candidate.accountName === 'string' ? candidate.accountName : undefined,
  };
}
