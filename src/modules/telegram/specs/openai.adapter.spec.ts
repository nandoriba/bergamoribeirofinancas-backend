import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiProviderError } from '../ai-provider';
import { OpenAiAdapter } from '../openai.adapter';

const input = {
  text: 'gastei 25 reais no mercado',
  today: '2026-08-01',
  timezone: 'America/Sao_Paulo',
  accounts: [],
  categories: [],
};

const parsedExpense = {
  intent: 'EXPENSE',
  confidence: 1,
  amount: { value: 25, currency: 'BRL' },
  date: '2026-08-01',
  description: 'Mercado',
  accountHint: null,
  categoryHint: null,
  installments: null,
  missingFields: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiAdapter', () => {
  it('retorna request id, modelo e tokens da resposta válida', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseWith(
        {
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini-2024-07-18',
          choices: [{ message: { content: JSON.stringify(parsedExpense) } }],
          usage: { prompt_tokens: 120, completion_tokens: 35 },
        },
        { requestId: 'req-success' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAdapter().parseFinancialMessage(input)).resolves.toEqual({
      parsed: parsedExpense,
      raw: parsedExpense,
      model: 'gpt-4o-mini-2024-07-18',
      requestId: 'req-success',
      tokensIn: 120,
      tokensOut: 35,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifica HTTP não sucedido como PROVIDER_FAILED sem expor o corpo remoto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('provider-secret-detail', {
        status: 429,
        headers: { 'x-request-id': 'req-rate-limit' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await captureError(createAdapter().parseFinancialMessage(input));

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({
      kind: 'PROVIDER_FAILED',
      model: 'gpt-4o-mini',
      requestId: 'req-rate-limit',
      httpStatus: 429,
    });
    expect(error.message).toBe('Falha ao consultar o provedor de IA');
    expect(error.message).not.toContain('provider-secret-detail');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sanitiza falha de rede e não faz retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('Authorization: Bearer sk-sensitive-value'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await captureError(createAdapter().parseFinancialMessage(input));

    expect(error).toMatchObject({
      kind: 'PROVIDER_FAILED',
      model: 'gpt-4o-mini',
    });
    expect(error.message).not.toContain('sk-sensitive-value');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifica JSON HTTP inválido como RESPONSE_INVALID e preserva o request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{invalid-json', {
          status: 200,
          headers: { 'x-request-id': 'req-invalid-http-json' },
        }),
      ),
    );

    const error = await captureError(createAdapter().parseFinancialMessage(input));

    expect(error).toMatchObject({
      kind: 'RESPONSE_INVALID',
      model: 'gpt-4o-mini',
      requestId: 'req-invalid-http-json',
    });
  });

  it.each([
    ['conteúdo ausente', null],
    ['conteúdo sem JSON', 'not-json'],
    ['conteúdo fora do schema', JSON.stringify({ intent: 'EXPENSE' })],
  ])('preserva metadados quando há %s', async (_label, content) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        responseWith(
          {
            model: 'gpt-4o-mini-snapshot',
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 88, completion_tokens: 13 },
          },
          { requestId: 'req-invalid-content' },
        ),
      ),
    );

    const error = await captureError(createAdapter().parseFinancialMessage(input));

    expect(error).toMatchObject({
      kind: 'RESPONSE_INVALID',
      model: 'gpt-4o-mini-snapshot',
      requestId: 'req-invalid-content',
      tokensIn: 88,
      tokensOut: 13,
    });
    expect(error.message).toBe('Resposta inválida do provedor de IA');
  });

  it('falha de configuração também usa erro tipado e não inicia request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await captureError(
      createAdapter({ OPENAI_API_KEY: undefined }).parseFinancialMessage(input),
    );

    expect(error).toMatchObject({
      kind: 'PROVIDER_FAILED',
      model: 'gpt-4o-mini',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createAdapter(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    OPENAI_API_KEY: 'test-api-key',
    OPENAI_MODEL: 'gpt-4o-mini',
    ...overrides,
  };
  return new OpenAiAdapter({ get: vi.fn((key: string) => values[key]) } as never);
}

function responseWith(
  payload: unknown,
  options: { requestId?: string } = {},
) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: options.requestId ? { 'x-request-id': options.requestId } : undefined,
  });
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('Expected an Error instance');
  }
  throw new Error('Expected promise to reject');
}
