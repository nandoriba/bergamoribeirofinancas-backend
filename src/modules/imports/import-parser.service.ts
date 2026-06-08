import { Injectable } from '@nestjs/common';
import { ImportType } from '@prisma/client';

export interface ParsedImportRow {
  rowIndex: number;
  raw: Record<string, string>;
  date?: Date;
  description?: string;
  amountCents?: number;
  externalId?: string;
  suggestedCategory?: string;
  status: 'new' | 'review';
}

export interface ParsedImport {
  type: ImportType;
  rows: ParsedImportRow[];
}

@Injectable()
export class ImportParserService {
  parse(fileName: string, content: string): ParsedImport {
    const rows = parseCsv(content);
    const type = detectType(fileName, rows[0] ?? {});

    return {
      type,
      rows: rows.map((row, index) => this.parseRow(type, row, index + 1)),
    };
  }

  private parseRow(type: ImportType, row: Record<string, string>, rowIndex: number): ParsedImportRow {
    const normalized = normalizeRow(row);
    if (type === 'nubank_account') {
      return this.parseAccountRow(row, normalized, rowIndex);
    }
    if (type === 'nubank_credit_card') {
      return this.parseCreditCardRow(row, normalized, rowIndex);
    }
    return this.parseUnknownRow(row, normalized, rowIndex);
  }

  private parseAccountRow(
    raw: Record<string, string>,
    row: Record<string, string>,
    rowIndex: number,
  ): ParsedImportRow {
    const date = parseDate(row.data);
    const amountCents = parseMoneyCents(row.valor);
    const description = row.descricao || row.description;
    const externalId = row.identificador || buildSyntheticExternalId('nubank-account', date, description, amountCents);

    return this.withReviewStatus({
      rowIndex,
      raw,
      date,
      description,
      amountCents,
      externalId,
      suggestedCategory: suggestCategory(description, amountCents),
      status: 'new',
    });
  }

  private parseCreditCardRow(
    raw: Record<string, string>,
    row: Record<string, string>,
    rowIndex: number,
  ): ParsedImportRow {
    const date = parseDate(row.date || row.data);
    const amountCents = parseMoneyCents(row.amount || row.valor);
    const description = row.title || row.descricao || row.description;
    const installment = extractInstallment(description);
    const externalId = buildSyntheticExternalId('nubank-card', date, description, amountCents);
    const adjustment = isCreditCardAdjustment(description);
    const categoryAmount = amountCents === undefined ? undefined : -Math.abs(amountCents);

    return this.withReviewStatus({
      rowIndex,
      raw: installment ? { ...raw, installment } : raw,
      date,
      description,
      amountCents,
      externalId,
      suggestedCategory: adjustment ? 'Ajuste de fatura' : suggestCategory(description, categoryAmount),
      status: adjustment ? 'review' : 'new',
    });
  }

  private parseUnknownRow(
    raw: Record<string, string>,
    row: Record<string, string>,
    rowIndex: number,
  ): ParsedImportRow {
    const date = parseDate(row.data || row.date);
    const amountCents = parseMoneyCents(row.valor || row.amount);
    const description = row.descricao || row.description || row.title;
    return this.withReviewStatus({
      rowIndex,
      raw,
      date,
      description,
      amountCents,
      externalId: buildSyntheticExternalId('unknown', date, description, amountCents),
      suggestedCategory: suggestCategory(description, amountCents),
      status: 'new',
    });
  }

  private withReviewStatus(row: ParsedImportRow): ParsedImportRow {
    if (!row.date || !row.description || row.amountCents === undefined || !row.externalId) {
      return { ...row, status: 'review', suggestedCategory: row.suggestedCategory ?? 'Revisar' };
    }
    return row;
  }
}

function parseCsv(content: string): Record<string, string>[] {
  const cleanContent = content.replace(/^\uFEFF/, '').trim();
  if (!cleanContent) return [];

  const lines = cleanContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    return headers.reduce<Record<string, string>>((row, header, index) => {
      row[header.trim()] = (values[index] ?? '').trim();
      return row;
    }, {});
  });
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      values.push(value);
      value = '';
      continue;
    }

    value += char;
  }

  values.push(value);
  return values;
}

function detectDelimiter(headerLine: string): string {
  return headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
}

function detectType(fileName: string, firstRow: Record<string, string>): ImportType {
  const headers = Object.keys(normalizeRow(firstRow));
  const lowerFileName = fileName.toLowerCase();
  if (headers.includes('identificador') || lowerFileName.startsWith('nu_')) return 'nubank_account';
  if (headers.includes('title') || headers.includes('amount')) return 'nubank_credit_card';
  return 'unknown';
}

function normalizeRow(row: Record<string, string>): Record<string, string> {
  return Object.entries(row).reduce<Record<string, string>>((normalized, [key, value]) => {
    normalized[normalizeKey(key)] = value.trim();
    return normalized;
  }, {});
}

function normalizeKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brMatch) {
    return new Date(Date.UTC(Number(brMatch[3]), Number(brMatch[2]) - 1, Number(brMatch[1])));
  }
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (isoMatch) {
    return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function parseMoneyCents(value?: string): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return undefined;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const decimalSeparator = lastComma > lastDot ? ',' : '.';
  const normalized =
    decimalSeparator === ','
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

function buildSyntheticExternalId(
  prefix: string,
  date?: Date,
  description?: string,
  amountCents?: number,
): string | undefined {
  if (!date || !description || amountCents === undefined) return undefined;
  return `${prefix}:${date.toISOString().slice(0, 10)}:${normalizeKey(description)}:${amountCents}`;
}

function suggestCategory(description?: string, amountCents?: number): string {
  const text = normalizeKey(description ?? '');
  if ((amountCents ?? 0) > 0) return 'Receitas';
  if (text.includes('ifood') || text.includes('mercado') || text.includes('padaria')) return 'Alimentação';
  if (text.includes('uber') || text.includes('99') || text.includes('posto')) return 'Transporte';
  if (text.includes('netflix') || text.includes('spotify') || text.includes('amazon')) return 'Assinaturas';
  if (text.includes('farmacia') || text.includes('drogaria')) return 'Saúde';
  if (text.includes('nubank') || text.includes('pagamento')) return 'Cartão';
  return 'Outros';
}

function extractInstallment(description?: string): string | undefined {
  if (!description) return undefined;
  const match = /(?:parcela\s*)?(\d{1,2})\s*\/\s*(\d{1,2})/i.exec(description);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function isCreditCardAdjustment(description?: string): boolean {
  const text = normalizeKey(description ?? '');
  return ['pagamento', 'estorno', 'credito', 'reembolso'].some((token) => text.includes(token));
}
