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
  tokensIn?: number;
  tokensOut?: number;
}

export interface AiProvider {
  parseFinancialMessage(input: AiParseInput): Promise<AiParseResult>;
}
