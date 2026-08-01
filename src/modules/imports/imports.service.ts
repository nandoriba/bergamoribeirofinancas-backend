import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ImportRowStatus, Prisma } from '@prisma/client';
import type { Account, ImportType, TransactionType } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import { clampDayForMonth, startOfMonth } from '../../shared/date-range';
import { normalizeAmountCents } from '../../shared/finance-calculator';
import type { TenantContext } from '../../shared/tenant-context';
import { InstallmentsService } from '../installments/installments.service';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { DiscardImportDto } from './dto/discard-import.dto';
import { ListImportBatchesQueryDto } from './dto/list-import-batches-query.dto';
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

type PrismaExecutor = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: ImportParserService,
    private readonly installmentsService: InstallmentsService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  async listBatches(context: TenantContext, query: ListImportBatchesQueryDto = new ListImportBatchesQueryDto()) {
    const where = this.tenantScope.byAuthor(context);
    if (query.cursor) {
      const cursor = await this.prisma.importBatch.findFirst({
        where: { id: query.cursor, ...where },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Cursor inválido');
    }

    const rows = await this.prisma.importBatch.findMany({
      where,
      include: { _count: { select: { rows: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasNextPage = rows.length > query.limit;
    const items = hasNextPage ? rows.slice(0, query.limit) : rows;
    return {
      items,
      pageInfo: {
        hasNextPage,
        nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
      },
    };
  }

  async preview(context: TenantContext, file?: UploadedCsvFile) {
    if (!file) throw new BadRequestException('Arquivo CSV obrigatório');
    const parsed = this.parser.parse(file.originalname, file.buffer.toString('utf8'));
    if (parsed.rows.length === 0) throw new BadRequestException('Arquivo sem linhas para importar');

    const categories = await this.prisma.category.findMany({ where: this.tenantScope.byFamily(context) });
    const existingExternalIds = await this.findExistingExternalIds(
      context.authorProfileId,
      parsed.rows.map((row) => row.externalId).filter((id): id is string => Boolean(id)),
    );
    const existingDuplicateCandidates = await this.findExistingDuplicateCandidates(
      context,
      parsed.rows,
      parsed.type,
    );
    const seenExternalIds = new Set<string>();
    const seenValueDateDescriptions = new Map(existingDuplicateCandidates);

    const batch = await this.prisma.importBatch.create({
      data: {
        fileName: file.originalname,
        type: parsed.type,
        status: 'preview',
        memberProfileId: context.authorProfileId,
        rows: {
          create: parsed.rows.map((row) => {
            const duplicate = this.resolveRowDuplicate(
              row,
              existingExternalIds,
              seenExternalIds,
              seenValueDateDescriptions,
              parsed.type,
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

  async confirm(context: TenantContext, dto: ConfirmImportDto) {
    return this.retryImportConflict(() => this.prisma.$transaction(async (tx) => {
      const claim = await tx.importBatch.updateMany({
        where: {
          id: dto.batchId,
          memberProfileId: context.authorProfileId,
          status: 'preview',
        },
        data: { status: 'confirmed' },
      });
      if (claim.count !== 1) throw new NotFoundException('Prévia de importação não encontrada');

      const batch = await tx.importBatch.findFirst({
        where: { id: dto.batchId, memberProfileId: context.authorProfileId, status: 'confirmed' },
        include: { rows: { orderBy: { rowIndex: 'asc' } } },
      });
      if (!batch) throw new NotFoundException('Prévia de importação não encontrada');

      const selectedRows = this.validateRequestedRows(batch, dto);
      const acceptedDuplicateRowIds = new Set(dto.acceptedPossibleDuplicateRowIds ?? []);
      const confirmedDuplicateRowIds = new Set(dto.confirmedDuplicateRowIds ?? []);
      const invoiceAdjustmentRowIds = new Set(dto.invoiceAdjustmentRowIds ?? []);
      const conflictingDuplicateDecisions = selectedRows.filter(
        (row) => acceptedDuplicateRowIds.has(row.id) && confirmedDuplicateRowIds.has(row.id),
      );
      if (conflictingDuplicateDecisions.length > 0) {
        throw new BadRequestException({
          code: 'POSSIBLE_DUPLICATES_CONFLICTING_DECISION',
          message: 'Escolha apenas uma decisão por duplicidade',
          rowIds: conflictingDuplicateDecisions.map((row) => row.id),
        });
      }

      const missingPossibleDuplicateDecisions = selectedRows.filter(
        (row) =>
          row.status === 'duplicate' &&
          row.falseDuplicate &&
          !acceptedDuplicateRowIds.has(row.id) &&
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
            (row.status === 'duplicate' && acceptedDuplicateRowIds.has(row.id)) ||
            isLegacyCreditCardAdjustmentReview(batch.type, row)) &&
          row.date &&
          row.description &&
          row.amountCents !== null,
      );
      const duplicateRowsToConfirm = selectedRows.filter(
        (row) => row.status === 'duplicate' && row.falseDuplicate && confirmedDuplicateRowIds.has(row.id),
      );

      const categories = await tx.category.findMany({ where: { familyId: context.familyId } });
      const categoryByName = new Map(categories.map((category) => [`${category.type}:${category.name}`, category.id]));
      const account = dto.accountId
        ? await tx.account.findFirst({ where: { id: dto.accountId, memberProfileId: context.authorProfileId } })
        : null;
      if (dto.accountId && !account) throw new BadRequestException('Conta inválida');
      if (batch.type === 'nubank_credit_card' && (!account || account.type !== 'credit_card')) {
        throw new BadRequestException('Selecione o cartão desta fatura para confirmar a importação');
      }

      const created = [];
      const bookkeepingDate = new Date();
      for (const row of importableRows) {
        const forcedDuplicateImport = row.status === 'duplicate' && acceptedDuplicateRowIds.has(row.id);
        const signedAmount = row.amountCents ?? 0;
        const externalId = forcedDuplicateImport
          ? row.id
          : row.externalId ?? stableImportExternalId(batch.type, row, account?.id);
        const importAsInvoiceAdjustment =
          batch.type === 'nubank_credit_card' &&
          invoiceAdjustmentRowIds.has(row.id) &&
          isCreditCardInvoiceAdjustmentCandidate(row.description);

        if (importAsInvoiceAdjustment && account?.type === 'credit_card' && row.date) {
          const invoiceId = await this.findOrCreateInvoice(tx, context, account, startOfMonth(row.date));
          const transaction = await tx.transaction.upsert({
            where: {
              memberProfileId_externalId: {
                memberProfileId: context.authorProfileId,
                externalId,
              },
            },
            update: {},
            create: {
              date: bookkeepingDate,
              applicationDate: row.date,
              referenceMonth: startOfMonth(row.date),
              description: row.description ?? 'Ajuste de fatura',
              amountCents: normalizeAmountCents(signedAmount),
              type: 'expense',
              status: 'confirmed',
              recurrenceType: 'none',
              source: batch.type,
              externalId,
              isInvoiceAdjustment: true,
              invoiceAmountCents: Math.round(signedAmount),
              accountId: account.id,
              invoiceId,
              memberProfileId: context.authorProfileId,
              importRowId: row.id,
            },
          });

          if (transaction.importRowId !== row.id) {
            await tx.importRow.update({
              where: { id: row.id, importBatchId: batch.id },
              data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
            });
            continue;
          }

          await tx.importRow.update({
            where: { id: row.id, importBatchId: batch.id },
            data: { status: ImportRowStatus.imported, falseDuplicate: forcedDuplicateImport ? true : undefined },
          });
          created.push(transaction);
          continue;
        }

        const type = this.resolveTransactionType(batch.type, signedAmount);
        const categoryId = this.resolveCategoryId(categories, categoryByName, type, row.suggestedCategory);
        const installment = readInstallment(row.raw);

        if (installment && account?.type === 'credit_card' && type === 'expense' && row.date) {
          const baseDescription = stripInstallment(row.description ?? 'Importado');
          const referenceMonth = startOfMonth(row.date);
          const existingProjected = forcedDuplicateImport
            ? null
            : await tx.transaction.findFirst({
                where: {
                  memberProfileId: context.authorProfileId,
                  accountId: account.id,
                  referenceMonth,
                  amountCents: normalizeAmountCents(signedAmount),
                  installmentNumber: installment.current,
                  description: { contains: baseDescription, mode: 'insensitive' },
                },
              });

          if (existingProjected) {
            await tx.importRow.update({
              where: { id: row.id, importBatchId: batch.id },
              data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
            });
            continue;
          }

          const existingImportedInstallment = await tx.transaction.findUnique({
            where: {
              memberProfileId_externalId: {
                memberProfileId: context.authorProfileId,
                externalId,
              },
            },
            select: { id: true },
          });
          if (existingImportedInstallment) {
            await tx.importRow.update({
              where: { id: row.id, importBatchId: batch.id },
              data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
            });
            continue;
          }

          const plan = await this.installmentsService.createInTransaction(tx, context, {
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

          const marker = await tx.transaction.updateMany({
            where: {
              installmentPlanId: plan.id,
              installmentNumber: installment.current,
              memberProfileId: context.authorProfileId,
              importRowId: null,
            },
            data: { externalId, importRowId: row.id },
          });
          if (marker.count !== 1) {
            throw new ConflictException('Não foi possível reservar a parcela importada');
          }

          await tx.importRow.update({
            where: { id: row.id, importBatchId: batch.id },
            data: { status: ImportRowStatus.imported, falseDuplicate: forcedDuplicateImport ? true : undefined },
          });
          created.push(plan);
          continue;
        }

        const invoiceId =
          account?.type === 'credit_card' && row.date
            ? await this.findOrCreateInvoice(tx, context, account, startOfMonth(row.date))
            : undefined;
        const transaction = await tx.transaction.upsert({
          where: {
            memberProfileId_externalId: {
              memberProfileId: context.authorProfileId,
              externalId,
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
            externalId,
            isInvoicePayment: isInvoicePaymentFromImport(batch.type, row.description),
            accountId: account?.id,
            invoiceId,
            categoryId,
            memberProfileId: context.authorProfileId,
            importRowId: row.id,
          },
        });

        if (transaction.importRowId !== row.id) {
          await tx.importRow.update({
            where: { id: row.id, importBatchId: batch.id },
            data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
          });
          continue;
        }

        await tx.importRow.update({
          where: { id: row.id, importBatchId: batch.id },
          data: { status: ImportRowStatus.imported, falseDuplicate: forcedDuplicateImport ? true : undefined },
        });
        created.push(transaction);
      }

      if (duplicateRowsToConfirm.length > 0) {
        await tx.importRow.updateMany({
          where: {
            importBatchId: batch.id,
            id: { in: duplicateRowsToConfirm.map((row) => row.id) },
          },
          data: { status: ImportRowStatus.duplicate, falseDuplicate: false },
        });
      }

      if (dto.rowIds?.length) {
        await tx.importRow.updateMany({
          where: {
            importBatchId: batch.id,
            id: { notIn: selectedRows.map((row) => row.id) },
          },
          data: { status: ImportRowStatus.ignored },
        });
      }

      return {
        batchId: batch.id,
        imported: created.length,
        ignored: batch.rows.length - created.length,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    }));
  }

  async discard(context: TenantContext, dto: DiscardImportDto) {
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.importBatch.updateMany({
        where: {
          id: dto.batchId,
          memberProfileId: context.authorProfileId,
          status: 'preview',
        },
        data: { status: 'discarded' },
      });
      if (claim.count !== 1) throw new NotFoundException('Prévia de importação não encontrada');

      const rows = await tx.importRow.updateMany({
        where: { importBatchId: dto.batchId },
        data: { status: ImportRowStatus.ignored },
      });

      return {
        batchId: dto.batchId,
        discarded: rows.count,
      };
    });
  }

  private async retryImportConflict<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isRetryableImportConflict(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
    throw lastError;
  }

  private async findOrCreateInvoice(
    client: PrismaExecutor,
    context: TenantContext,
    account: Account,
    referenceMonth: Date,
  ) {
    const invoice = await client.invoice.upsert({
      where: {
        accountId_referenceMonth: {
          accountId: account.id,
          referenceMonth,
        },
        memberProfileId: context.authorProfileId,
      },
      update: {},
      create: {
        accountId: account.id,
        memberProfileId: context.authorProfileId,
        referenceMonth,
        status: 'open',
        closingDate: account.closingDay ? clampDayForMonth(referenceMonth, account.closingDay) : undefined,
        dueDate: account.dueDay ? clampDayForMonth(referenceMonth, account.dueDay) : undefined,
      },
    });
    return invoice.id;
  }

  private validateRequestedRows<
    TBatch extends {
      type: ImportType;
      rows: Array<{
        id: string;
        status: ImportRowStatus;
        description: string | null;
      }>;
    },
  >(batch: TBatch, dto: ConfirmImportDto): TBatch['rows'] {
    const requestedIdGroups = [
      dto.rowIds,
      dto.acceptedPossibleDuplicateRowIds,
      dto.confirmedDuplicateRowIds,
      dto.invoiceAdjustmentRowIds,
    ].filter((ids): ids is string[] => Boolean(ids));
    if (requestedIdGroups.some((ids) => new Set(ids).size !== ids.length)) {
      throw new BadRequestException({
        code: 'IMPORT_DUPLICATE_ROW_IDS',
        message: 'Uma linha não pode ser informada mais de uma vez na mesma seleção',
      });
    }

    const rowsById = new Map(batch.rows.map((row) => [row.id, row]));
    const selectedRows = dto.rowIds?.length ? dto.rowIds.map((id) => rowsById.get(id)) : batch.rows;
    if (selectedRows.some((row) => !row)) {
      throw new BadRequestException({
        code: 'IMPORT_ROWS_OUTSIDE_BATCH',
        message: 'Uma ou mais linhas não pertencem à prévia informada',
      });
    }

    const selectedRowIds = new Set(selectedRows.map((row) => row?.id));
    const duplicateDecisionIds = [
      ...(dto.acceptedPossibleDuplicateRowIds ?? []),
      ...(dto.confirmedDuplicateRowIds ?? []),
    ];
    const allDecisionIds = [...duplicateDecisionIds, ...(dto.invoiceAdjustmentRowIds ?? [])];
    if (allDecisionIds.some((id) => !rowsById.has(id) || !selectedRowIds.has(id))) {
      throw new BadRequestException({
        code: 'IMPORT_DECISIONS_OUTSIDE_SELECTION',
        message: 'Uma ou mais decisões não pertencem às linhas selecionadas',
      });
    }

    if (duplicateDecisionIds.some((id) => rowsById.get(id)?.status !== ImportRowStatus.duplicate)) {
      throw new BadRequestException({
        code: 'IMPORT_INVALID_DUPLICATE_DECISION',
        message: 'Decisão de duplicidade inválida para a linha informada',
      });
    }

    if (
      (dto.invoiceAdjustmentRowIds ?? []).some((id) => {
        const row = rowsById.get(id);
        return !row || batch.type !== 'nubank_credit_card' || !isCreditCardInvoiceAdjustmentCandidate(row.description);
      })
    ) {
      throw new BadRequestException({
        code: 'IMPORT_INVALID_INVOICE_ADJUSTMENT',
        message: 'Ajuste de fatura inválido para a linha informada',
      });
    }

    return selectedRows as TBatch['rows'];
  }

  private async findExistingExternalIds(memberProfileId: string, externalIds: string[]) {
    if (externalIds.length === 0) return new Set<string>();
    const transactions = await this.prisma.transaction.findMany({
      where: { memberProfileId, externalId: { in: externalIds } },
      select: { externalId: true },
    });
    return new Set(transactions.map((transaction) => transaction.externalId).filter((id): id is string => Boolean(id)));
  }

  private async findExistingDuplicateCandidates(context: TenantContext, rows: ParsedImportRow[], importType: ImportType) {
    const filters = rows
      .filter((row) => row.date && row.amountCents !== undefined)
      .map((row) => ({
        applicationDate: row.date as Date,
        signedAmountCents: duplicateAmountForImportRow(importType, row),
      }));

    if (filters.length === 0) return new Map<string, DuplicateCandidate[]>();

    const uniqueFilters = [...new Map(filters.map((filter) => [duplicateKey(filter.applicationDate, filter.signedAmountCents), filter])).values()];
    const transactions = await this.prisma.transaction.findMany({
      where: {
        memberProfileId: context.authorProfileId,
        ...this.tenantScope.consistentTransactionRelations(context),
        OR: uniqueFilters.map((filter) => ({
          applicationDate: filter.applicationDate,
          amountCents: normalizeAmountCents(filter.signedAmountCents),
          type: filter.signedAmountCents >= 0 ? 'income' : 'expense',
        })),
      },
      select: {
        id: true,
        applicationDate: true,
        amountCents: true,
        description: true,
        type: true,
        account: { select: { name: true } },
      },
    });

    const candidates = new Map<string, DuplicateCandidate[]>();
    for (const transaction of transactions) {
      addDuplicateCandidate(candidates, {
        id: transaction.id,
        applicationDate: toDateKey(transaction.applicationDate),
        amountCents: signedTransactionAmountCents(transaction),
        description: cleanRepeatedSeparators(transaction.description),
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
    importType: ImportType,
  ): DuplicateClassification {
    if (row.status === 'review') return { status: ImportRowStatus.review, falseDuplicate: false, candidates: [] };

    if (row.externalId && (existingExternalIds.has(row.externalId) || seenExternalIds.has(row.externalId))) {
      return { status: ImportRowStatus.duplicate, falseDuplicate: false, candidates: [] };
    }

    if (row.externalId) seenExternalIds.add(row.externalId);

    if (!row.date || row.amountCents === undefined || !row.description) {
      return { status: ImportRowStatus.review, falseDuplicate: false, candidates: [] };
    }

    const amountCents = duplicateAmountForImportRow(importType, row);
    const key = duplicateKey(row.date, amountCents);
    const candidates = seenValueDateDescriptions.get(key);
    const description = normalizeText(row.description);
    const currentCandidate = {
      applicationDate: toDateKey(row.date),
      amountCents,
      description: cleanRepeatedSeparators(row.description),
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
    if (row.suggestedCategory === 'Revisar' || row.suggestedCategory === 'Ajuste de fatura') {
      return row.suggestedCategory;
    }
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
      raw: Prisma.JsonValue;
    },
    source: string,
  ) {
    const invoiceAdjustmentCandidate = isInvoiceAdjustmentPreviewCandidate(source, row);
    const invoiceAdjustmentDefault = invoiceAdjustmentCandidate && isInvoiceAdjustmentDefault(row);
    const legacyReviewAdjustment =
      row.status === ImportRowStatus.review &&
      invoiceAdjustmentCandidate &&
      Boolean(row.date) &&
      row.amountCents !== null;

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
      status: legacyReviewAdjustment ? 'new' : mapPreviewStatus(row.status, row.falseDuplicate),
      reviewReason: legacyReviewAdjustment ? null : resolveReviewReason(row.status),
      duplicateCandidates: readDuplicateCandidates(row.duplicateCandidates),
      invoiceAdjustmentCandidate,
      invoiceAdjustmentDefault,
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
  return cleanDescriptionSeparators(
    description
      .replace(/(?:parcela\s*)?\d{1,2}\s*\/\s*\d{1,2}/gi, ''),
  );
}

function cleanDescriptionSeparators(description: string) {
  return description
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—]+\s*$/g, '')
    .trim();
}

function isCreditCardPaymentReceived(description?: string | null): boolean {
  const text = normalizeText(description ?? '');
  return text.includes('pagamento recebido');
}

function isCreditCardInvoiceAdjustmentCandidate(description?: string | null): boolean {
  const text = normalizeText(description ?? '');
  return (
    isCreditCardPaymentReceived(description) ||
    ['estorno', 'credito', 'reembolso'].some((token) => text.includes(token))
  );
}

function isLegacyCreditCardAdjustmentReview(
  importType: ImportType,
  row: { status: ImportRowStatus; description: string | null },
): boolean {
  return (
    importType === 'nubank_credit_card' &&
    row.status === ImportRowStatus.review &&
    isCreditCardInvoiceAdjustmentCandidate(row.description)
  );
}

function isInvoicePaymentFromImport(importType: ImportType, description?: string | null): boolean {
  if (importType !== 'nubank_account') return false;
  const text = normalizeText(description ?? '');
  return text.includes('pagamento') && text.includes('fatura');
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function stableImportExternalId(
  importType: ImportType,
  row: { date: Date | null; amountCents: number | null; description: string | null; raw: Prisma.JsonValue },
  accountId?: string,
) {
  const fingerprint = JSON.stringify({
    importType,
    accountId: accountId ?? null,
    date: row.date?.toISOString() ?? null,
    amountCents: row.amountCents,
    description: normalizeText(row.description ?? ''),
    installment: readInstallment(row.raw),
  });
  return `import:${createHash('sha256').update(fingerprint).digest('hex')}`;
}

function isRetryableImportConflict(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

function duplicateKey(applicationDate: Date, amountCents: number) {
  return `${applicationDate.toISOString().slice(0, 10)}:${Math.round(amountCents)}`;
}

function addDuplicateCandidate(candidates: Map<string, DuplicateCandidate[]>, candidate: DuplicateCandidate) {
  const key = `${candidate.applicationDate}:${Math.round(candidate.amountCents)}`;
  const items = candidates.get(key) ?? [];
  items.push(candidate);
  candidates.set(key, items);
}

function duplicateAmountForImportRow(importType: ImportType, row: ParsedImportRow): number {
  const amountCents = Math.round(row.amountCents ?? 0);
  if (importType === 'nubank_credit_card') return -normalizeAmountCents(amountCents);
  return amountCents;
}

function signedTransactionAmountCents(transaction: { amountCents: number; type: TransactionType }): number {
  const amountCents = normalizeAmountCents(transaction.amountCents);
  return transaction.type === 'income' ? amountCents : -amountCents;
}

function mapPreviewStatus(status: ImportRowStatus, falseDuplicate: boolean): ImportPreviewStatus {
  if (status === ImportRowStatus.duplicate && falseDuplicate) return 'possible_duplicate';
  if (status === ImportRowStatus.duplicate) return 'duplicate';
  if (status === ImportRowStatus.review) return 'review';
  return 'new';
}

function resolveReviewReason(status: ImportRowStatus): string | null {
  if (status !== ImportRowStatus.review) return null;
  return 'Linha sem dados suficientes para importação automática.';
}

function isInvoiceAdjustmentPreviewCandidate(
  source: string,
  row: { raw: Prisma.JsonValue; description: string | null },
): boolean {
  if (source !== 'nubank_credit_card') return false;
  return readRawBoolean(row.raw, 'invoiceAdjustmentCandidate') ?? isCreditCardInvoiceAdjustmentCandidate(row.description);
}

function isInvoiceAdjustmentDefault(row: { raw: Prisma.JsonValue; description: string | null }): boolean {
  return readRawBoolean(row.raw, 'invoiceAdjustmentDefault') ?? isCreditCardPaymentReceived(row.description);
}

function readRawBoolean(raw: Prisma.JsonValue, key: string): boolean | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !(key in raw)) return null;
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return null;
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
    description: cleanRepeatedSeparators(candidate.description),
    applicationDate: candidate.applicationDate,
    amountCents: candidate.amountCents,
    source: candidate.source,
    accountName: typeof candidate.accountName === 'string' ? candidate.accountName : undefined,
  };
}

function cleanRepeatedSeparators(description: string) {
  return description.replace(/\s*[-–—]+\s*[-–—]+\s*Parcela/gi, ' - Parcela').trim();
}
