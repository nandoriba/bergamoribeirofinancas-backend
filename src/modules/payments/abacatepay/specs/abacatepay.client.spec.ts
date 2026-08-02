import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { PaymentProviderError } from '../../payment-provider';
import {
  type AbacatePayHttpFetch,
  AbacatePayV2Client,
} from '../abacatepay.client';

const devApiKey = 'dev-api-key-that-must-not-leak';
const prodApiKey = 'prod-api-key-that-must-not-leak';
const baseUrl = 'https://api.abacatepay.com/v2';
const productId = 'prod_monthly_private';
const customerId = 'cust_private';
const checkoutId = 'bill_private';
const subscriptionId = 'subs_private';
const externalId = 'checkout-attempt-private';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function productEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: productId,
      name: 'Plano mensal',
      price: 2990,
      currency: 'BRL',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      trialDays: null,
      devMode: true,
      ignoredSecret: 'must-not-be-returned',
      ...overrides,
    },
  };
}

function customerEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: customerId,
      email: 'owner@example.com',
      name: 'Owner Example',
      devMode: true,
      taxId: 'must-not-be-returned',
      metadata: { private: true },
      ...overrides,
    },
  };
}

function checkoutData(overrides: Record<string, unknown> = {}) {
  return {
    id: checkoutId,
    externalId,
    url: `https://app.abacatepay.com/pay/${checkoutId}`,
    amount: 2990,
    paidAmount: null,
    status: 'PENDING',
    devMode: true,
    customerId,
    items: [{ id: productId, quantity: 1 }],
    receiptUrl: null,
    metadata: { private: true },
    ...overrides,
  };
}

function checkoutEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    error: null,
    data: checkoutData(overrides),
  };
}

function cancelledEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: subscriptionId,
      customerId,
      amount: 2990,
      currency: 'BRL',
      method: 'CARD',
      status: 'CANCELLED',
      devMode: true,
      coupons: [],
      ...overrides,
    },
  };
}

function queuedFetch(responses: Response[]): ReturnType<typeof vi.fn<AbacatePayHttpFetch>> {
  return vi.fn<AbacatePayHttpFetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected call');
    return response;
  });
}

function client(
  fetcher: AbacatePayHttpFetch,
  overrides: Record<string, unknown> = {},
): AbacatePayV2Client {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    ABACATEPAY_DEV_API_KEY: devApiKey,
    ABACATEPAY_PROD_API_KEY: prodApiKey,
    ABACATEPAY_DEV_API_URL: baseUrl,
    ABACATEPAY_PROD_API_URL: baseUrl,
    ABACATEPAY_TIMEOUT_MS: 50,
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as ConfigService;

  return new AbacatePayV2Client(
    config,
    fetcher,
  );
}

function abortingFetch(): ReturnType<typeof vi.fn<AbacatePayHttpFetch>> {
  return vi.fn<AbacatePayHttpFetch>(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error('raw transport details');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      }),
  );
}

describe('AbacatePayV2Client', () => {
  it('busca e normaliza um produto sem devolver campos não allowlisted', async () => {
    const fetcher = queuedFetch([jsonResponse(productEnvelope())]);

    const product = await client(fetcher).getProduct(productId);

    expect(product).toEqual({
      id: productId,
      name: 'Plano mensal',
      priceCents: 2990,
      currency: 'BRL',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      trialDays: null,
      devMode: true,
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`${baseUrl}/products/get?id=${productId}`);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${devApiKey}`,
        Accept: 'application/json',
      },
    });
  });

  it('seleciona chave de produção e exige devMode false', async () => {
    const fetcher = queuedFetch([
      jsonResponse(productEnvelope({ devMode: false })),
    ]);

    const product = await client(fetcher, { NODE_ENV: 'production' }).getProduct(
      productId,
    );

    expect(product.devMode).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${prodApiKey}`,
    });
  });

  it('aceita as duas formas de prefixo de produto presentes na documentação v2', async () => {
    const documentedProductId = 'prod-monthly-private';
    const fetcher = queuedFetch([
      jsonResponse(productEnvelope({ id: documentedProductId })),
    ]);

    await expect(client(fetcher).getProduct(documentedProductId)).resolves.toMatchObject({
      id: documentedProductId,
      cycle: 'MONTHLY',
    });
  });

  it.each([
    ['ambiente divergente', { devMode: false }, 'ENVIRONMENT_MISMATCH'],
    ['valor fracionário', { price: 2990.5 }, 'INVALID_PROVIDER_RESPONSE'],
    ['moeda diferente', { currency: 'USD' }, 'INVALID_PROVIDER_RESPONSE'],
    ['trial desconhecido', { trialDays: undefined }, 'INVALID_PROVIDER_RESPONSE'],
  ])('falha fechado para produto com %s', async (_case, override, code) => {
    const fetcher = queuedFetch([jsonResponse(productEnvelope(override))]);

    await expect(client(fetcher).getProduct(productId)).rejects.toMatchObject({
      name: 'PaymentProviderError',
      kind: 'contract',
      code,
      operation: 'get_product',
    });
  });

  it('cria customer com body plano e retorna somente identidade allowlisted', async () => {
    const fetcher = queuedFetch([jsonResponse(customerEnvelope())]);

    const customer = await client(fetcher).createCustomer({
      email: 'owner@example.com',
      name: 'Owner Example',
      metadata: { familyReference: 'opaque-family', onboarding: true },
    });

    expect(customer).toEqual({
      id: customerId,
      email: 'owner@example.com',
      name: 'Owner Example',
      devMode: true,
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      email: 'owner@example.com',
      name: 'Owner Example',
      metadata: { familyReference: 'opaque-family', onboarding: true },
    });
    expect(body).not.toHaveProperty('data');
  });

  it('envia checkout mensal somente por CARD e mapeia retryPolicy', async () => {
    const fetcher = queuedFetch([jsonResponse(checkoutEnvelope())]);

    const checkout = await client(fetcher).createMonthlyCheckout({
      productId,
      externalId,
      customerId,
      metadata: { familyReference: 'opaque-family' },
      returnUrl: 'https://finance.example.com/pagamento/pendente',
      completionUrl: 'https://finance.example.com/pagamento/concluido',
      retryPolicy: { maxRetries: 3, intervalDays: 2 },
    });

    expect(checkout).toEqual({
      id: checkoutId,
      externalId,
      url: `https://app.abacatepay.com/pay/${checkoutId}`,
      amountCents: 2990,
      currency: 'BRL',
      status: 'PENDING',
      customerId,
      productId,
      quantity: 1,
      devMode: true,
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      items: [{ id: productId, quantity: 1 }],
      methods: ['CARD'],
      externalId,
      returnUrl: 'https://finance.example.com/pagamento/pendente',
      completionUrl: 'https://finance.example.com/pagamento/concluido',
      customerId,
      metadata: { familyReference: 'opaque-family' },
      retryPolicy: { maxRetry: 3, retryEvery: 2 },
    });
    expect(body).not.toHaveProperty('cycle');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, 'DUPLICATE_EXTERNAL_ID'],
    [425, 'PROVIDER_HTTP_OUTCOME_UNKNOWN'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ])(
    'trata HTTP %i após POST como resultado ambíguo e não permite retentativa cega',
    async (status, code) => {
      const fetcher = queuedFetch([jsonResponse({ error: 'sanitized' }, status)]);

      await expect(
        client(fetcher).createMonthlyCheckout({
          productId,
          externalId,
          returnUrl: 'https://finance.example.com/pagamento/pendente',
          completionUrl: 'https://finance.example.com/pagamento/concluido',
        }),
      ).rejects.toMatchObject({
        kind: 'ambiguous',
        code,
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('omite customer, metadata e retryPolicy quando não informados', async () => {
    const fetcher = queuedFetch([
      jsonResponse(checkoutEnvelope({ customerId: null })),
    ]);

    await client(fetcher).createMonthlyCheckout({
      productId,
      externalId,
      returnUrl: 'http://localhost:5173/pagamento/pendente',
      completionUrl: 'http://localhost:5173/pagamento/concluido',
    });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('retryPolicy');
  });

  it.each([
    'http://app.abacatepay.com/pay/bill_private',
    'https://evil.example/pay/bill_private',
    'https://user:password@app.abacatepay.com/pay/bill_private',
    'https://app.abacatepay.com:8443/pay/bill_private',
    'https://app.abacatepay.com/pay/bill_other',
    'https://app.abacatepay.com/pay/bill_private?token=secret',
  ])('rejeita URL de checkout não canônica: %s', async (url) => {
    const fetcher = queuedFetch([
      jsonResponse(checkoutEnvelope({ url })),
    ]);

    await expect(
      client(fetcher).createMonthlyCheckout({
        productId,
        externalId,
        customerId,
        returnUrl: 'https://finance.example.com/pagamento/pendente',
        completionUrl: 'https://finance.example.com/pagamento/concluido',
      }),
    ).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_CHECKOUT_URL',
    });
  });

  it.each([
    ['externalId', { externalId: 'other-attempt' }],
    ['produto', { items: [{ id: 'prod_other', quantity: 1 }] }],
    ['customer', { customerId: 'cust_other' }],
    ['status inicial', { status: 'PAID' }],
    ['ambiente', { devMode: false }],
  ])('rejeita checkout sem correlação de %s', async (_case, override) => {
    const fetcher = queuedFetch([jsonResponse(checkoutEnvelope(override))]);

    await expect(
      client(fetcher).createMonthlyCheckout({
        productId,
        externalId,
        customerId,
        returnUrl: 'https://finance.example.com/pagamento/pendente',
        completionUrl: 'https://finance.example.com/pagamento/concluido',
      }),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('reconcilia checkout por externalId usando filtro codificado e limit 2', async () => {
    const encodedExternalId = 'family/owner?attempt=1';
    const fetcher = queuedFetch([
      jsonResponse({
        success: true,
        error: null,
        data: [checkoutData({ externalId: encodedExternalId })],
        pagination: { hasMore: false, next: null, before: null },
      }),
    ]);

    const checkout = await client(fetcher).findCheckoutByExternalId(
      encodedExternalId,
    );

    expect(checkout?.externalId).toBe(encodedExternalId);
    const calledUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe('/v2/subscriptions/list');
    expect(calledUrl.searchParams.get('externalId')).toBe(encodedExternalId);
    expect(calledUrl.searchParams.get('limit')).toBe('2');
  });

  it('retorna null quando a reconciliação não encontra checkout', async () => {
    const fetcher = queuedFetch([
      jsonResponse({
        success: true,
        error: null,
        data: [],
        pagination: { hasMore: false },
      }),
    ]);

    await expect(
      client(fetcher).findCheckoutByExternalId(externalId),
    ).resolves.toBeNull();
  });

  it('marca externalId duplicado como ambíguo', async () => {
    const fetcher = queuedFetch([
      jsonResponse({
        success: true,
        error: null,
        data: [
          checkoutData(),
          checkoutData({
            id: 'bill_duplicate',
            url: 'https://app.abacatepay.com/pay/bill_duplicate',
          }),
        ],
        pagination: { hasMore: false },
      }),
    ]);

    await expect(
      client(fetcher).findCheckoutByExternalId(externalId),
    ).rejects.toMatchObject({
      kind: 'ambiguous',
      code: 'DUPLICATE_EXTERNAL_ID',
      retryable: false,
    });
  });

  it('marca paginação truncada como ambígua mesmo com um resultado', async () => {
    const fetcher = queuedFetch([
      jsonResponse({
        success: true,
        error: null,
        data: [checkoutData()],
        pagination: { hasMore: true, next: 'opaque-cursor' },
      }),
    ]);

    await expect(
      client(fetcher).findCheckoutByExternalId(externalId),
    ).rejects.toMatchObject({
      kind: 'ambiguous',
      code: 'CHECKOUT_LOOKUP_TRUNCATED',
    });
  });

  it('classifica timeout de POST como ambíguo e não retenta', async () => {
    const fetcher = abortingFetch();

    await expect(
      client(fetcher, { ABACATEPAY_TIMEOUT_MS: 5 }).createMonthlyCheckout({
        productId,
        externalId,
        customerId,
        returnUrl: 'https://finance.example.com/pagamento/pendente',
        completionUrl: 'https://finance.example.com/pagamento/concluido',
      }),
    ).rejects.toMatchObject({
      kind: 'ambiguous',
      code: 'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('classifica timeout de GET como indisponibilidade', async () => {
    const fetcher = abortingFetch();

    await expect(
      client(fetcher, { ABACATEPAY_TIMEOUT_MS: 5 }).getProduct(productId),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'rejected', 'PROVIDER_AUTHENTICATION_REJECTED'],
    [404, 'rejected', 'PROVIDER_RESOURCE_NOT_FOUND'],
    [422, 'rejected', 'PROVIDER_REQUEST_REJECTED'],
    [429, 'unavailable', 'PROVIDER_RATE_LIMITED'],
    [503, 'unavailable', 'PROVIDER_UNAVAILABLE'],
  ])('classifica HTTP %i sem expor o body', async (status, kind, code) => {
    const fetcher = queuedFetch([
      jsonResponse(
        { error: `${devApiKey} https://app.abacatepay.com/pay/secret` },
        status,
      ),
    ]);

    let caught: unknown;
    try {
      await client(fetcher).getProduct(productId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PaymentProviderError);
    expect(caught).toMatchObject({ kind, code });
    expect(String((caught as Error).message)).not.toContain(devApiKey);
    expect(JSON.stringify(caught)).not.toContain(devApiKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distingue rejeição em envelope 2xx de quebra de contrato JSON', async () => {
    const rejectedFetch = queuedFetch([
      jsonResponse({ success: false, data: null, error: devApiKey }),
    ]);
    const invalidFetch = queuedFetch([
      new Response('not-json', { status: 200 }),
    ]);

    await expect(
      client(rejectedFetch).getProduct(productId),
    ).rejects.toMatchObject({
      kind: 'rejected',
      code: 'PROVIDER_RESPONSE_REJECTED',
    });
    await expect(client(invalidFetch).getProduct(productId)).rejects.toMatchObject(
      {
        kind: 'contract',
        code: 'INVALID_PROVIDER_JSON',
      },
    );
  });

  it('cancela assinatura com subs id e exige resposta CARD/CANCELLED correlacionada', async () => {
    const fetcher = queuedFetch([jsonResponse(cancelledEnvelope())]);

    const subscription = await client(fetcher).cancelSubscription(subscriptionId);

    expect(subscription).toEqual({
      id: subscriptionId,
      customerId,
      amountCents: 2990,
      currency: 'BRL',
      method: 'CARD',
      status: 'CANCELLED',
      devMode: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      id: subscriptionId,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${baseUrl}/subscriptions/cancel`);
  });

  it('recusa cancelamento com bill id antes de chamar o provider', async () => {
    const fetcher = queuedFetch([]);

    await expect(client(fetcher).cancelSubscription(checkoutId)).rejects.toMatchObject(
      {
        kind: 'contract',
        code: 'INVALID_INPUT',
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falha com configuração inválida sem iniciar request', async () => {
    const fetcher = queuedFetch([]);

    await expect(
      client(fetcher, { ABACATEPAY_DEV_API_KEY: '' }).getProduct(productId),
    ).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_CONFIGURATION',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recusa base /v2 fora do host oficial mesmo sem passar pelo bootstrap', async () => {
    const fetcher = queuedFetch([]);

    await expect(
      client(fetcher, { ABACATEPAY_DEV_API_URL: 'https://evil.example/v2' }).getProduct(
        productId,
      ),
    ).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_CONFIGURATION',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
