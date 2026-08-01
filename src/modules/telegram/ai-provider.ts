import type { TelegramAiResponse } from './telegram-ai.schema';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiContextItem {
  id: string;
  name: string;
  aliases?: string[];
  type?: string;
  institution?: string | null;
  lastFourDigits?: string | null;
}

export interface AiParseInput {
  text: string;
  today: string;
  timezone: string;
  accounts: AiContextItem[];
  categories: AiContextItem[];
}

export interface AiParseResult {
  parsed: TelegramAiResponse;
  raw: unknown;
  model: string;
  requestId?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export type AiProviderErrorKind = 'PROVIDER_FAILED' | 'RESPONSE_INVALID';

export interface AiProviderErrorMetadata {
  model?: string;
  requestId?: string;
  tokensIn?: number;
  tokensOut?: number;
  httpStatus?: number;
}

export class AiProviderError extends Error {
  readonly model?: string;
  readonly requestId?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly httpStatus?: number;

  constructor(
    readonly kind: AiProviderErrorKind,
    metadata: AiProviderErrorMetadata = {},
  ) {
    super(
      kind === 'PROVIDER_FAILED'
        ? 'Falha ao consultar o provedor de IA'
        : 'Resposta inválida do provedor de IA',
    );
    this.name = 'AiProviderError';
    this.model = metadata.model;
    this.requestId = metadata.requestId;
    this.tokensIn = metadata.tokensIn;
    this.tokensOut = metadata.tokensOut;
    this.httpStatus = metadata.httpStatus;
  }
}

export interface AiProvider {
  parseFinancialMessage(input: AiParseInput): Promise<AiParseResult>;
}
