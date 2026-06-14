import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../shared/configuration';
import type { AiParseInput, AiParseResult, AiProvider } from './ai-provider';
import { telegramAiResponseSchema } from './telegram-ai.schema';

@Injectable()
export class OpenAiAdapter implements AiProvider {
  constructor(private readonly config: ConfigService<AppConfig>) {}

  async parseFinancialMessage(input: AiParseInput): Promise<AiParseResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    const model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'telegram_financial_message',
            strict: true,
            schema: telegramFinancialJsonSchema,
          },
        },
        messages: [
          {
            role: 'system',
            content:
              'Você interpreta mensagens curtas de Telegram em pt-BR para um sistema financeiro familiar. Responda somente no JSON do schema. Datas relativas devem usar o campo today/timezone informado. Não invente conta ou categoria: use hints quando a mensagem permitir inferir.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              text: input.text,
              today: input.today,
              timezone: input.timezone,
              availableAccounts: input.accounts,
              availableCategories: input.categories,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`OpenAI falhou com HTTP ${response.status}`);
    }

    const raw = (await response.json()) as OpenAiChatCompletionResponse;
    const content = raw.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI não retornou conteúdo');
    }

    const parsedJson = JSON.parse(content) as unknown;
    const parsed = telegramAiResponseSchema.parse(parsedJson);

    return {
      parsed,
      raw: parsedJson,
      model: raw.model ?? model,
      tokensIn: raw.usage?.prompt_tokens,
      tokensOut: raw.usage?.completion_tokens,
    };
  }
}

interface OpenAiChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const nullableString = { type: ['string', 'null'] };

const telegramFinancialJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'confidence',
    'amount',
    'date',
    'description',
    'accountHint',
    'categoryHint',
    'installments',
    'missingFields',
  ],
  properties: {
    intent: {
      type: 'string',
      enum: ['EXPENSE', 'INCOME', 'INSTALLMENT', 'RECURRING_UNSUPPORTED', 'NON_FINANCIAL', 'UNCLEAR'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    amount: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'currency'],
          properties: {
            value: { type: 'number', exclusiveMinimum: 0 },
            currency: { type: 'string', enum: ['BRL'] },
          },
        },
        { type: 'null' },
      ],
    },
    date: nullableString,
    description: nullableString,
    accountHint: nullableString,
    categoryHint: nullableString,
    installments: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'totalIsKnown'],
          properties: {
            count: { type: 'integer', minimum: 1 },
            totalIsKnown: { type: 'boolean' },
          },
        },
        { type: 'null' },
      ],
    },
    missingFields: {
      type: 'array',
      items: { type: 'string', enum: ['amount', 'account', 'category', 'date'] },
    },
  },
} as const;
