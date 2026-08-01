import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../shared/configuration';
import {
  AiProviderError,
  type AiParseInput,
  type AiParseResult,
  type AiProvider,
  type AiProviderErrorMetadata,
} from './ai-provider';
import { telegramAiResponseSchema } from './telegram-ai.schema';

@Injectable()
export class OpenAiAdapter implements AiProvider {
  constructor(private readonly config: ConfigService<AppConfig>) {}

  async parseFinancialMessage(input: AiParseInput): Promise<AiParseResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
    if (!apiKey) {
      throw new AiProviderError('PROVIDER_FAILED', { model });
    }

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    } catch {
      throw new AiProviderError('PROVIDER_FAILED', { model });
    }

    const requestId = readRequestId(response);

    if (!response.ok) {
      throw new AiProviderError('PROVIDER_FAILED', {
        model,
        requestId,
        httpStatus: response.status,
      });
    }

    let raw: OpenAiChatCompletionResponse;
    try {
      raw = readChatCompletionResponse(await response.json());
    } catch {
      throw new AiProviderError('RESPONSE_INVALID', { model, requestId });
    }

    const metadata = readResponseMetadata(raw, model, requestId);
    const content = raw.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiProviderError('RESPONSE_INVALID', metadata);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content) as unknown;
    } catch {
      throw new AiProviderError('RESPONSE_INVALID', metadata);
    }

    const validation = telegramAiResponseSchema.safeParse(parsedJson);
    if (!validation.success) {
      throw new AiProviderError('RESPONSE_INVALID', metadata);
    }

    return {
      parsed: validation.data,
      raw: parsedJson,
      model: metadata.model ?? model,
      requestId: metadata.requestId,
      tokensIn: metadata.tokensIn,
      tokensOut: metadata.tokensOut,
    };
  }
}

interface OpenAiChatCompletionResponse {
  id?: string;
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

function readRequestId(response: Response): string | undefined {
  const requestId = response.headers.get('x-request-id')?.trim();
  return requestId || undefined;
}

function readChatCompletionResponse(value: unknown): OpenAiChatCompletionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid chat completion response');
  }
  return value as OpenAiChatCompletionResponse;
}

function readResponseMetadata(
  response: OpenAiChatCompletionResponse,
  requestedModel: string,
  requestId?: string,
): AiProviderErrorMetadata {
  return {
    model: typeof response.model === 'string' && response.model.trim() ? response.model : requestedModel,
    requestId,
    tokensIn: readTokenCount(response.usage?.prompt_tokens),
    tokensOut: readTokenCount(response.usage?.completion_tokens),
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
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
