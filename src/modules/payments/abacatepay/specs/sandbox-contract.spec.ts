import { describe, expect, it, vi } from 'vitest';

import {
  type AbacatePaySandboxProbeConfig,
  ABACATEPAY_SANDBOX_API_URL,
  runAbacatePaySandboxProbe,
} from '../sandbox-contract';

type ProbeFetch = NonNullable<AbacatePaySandboxProbeConfig['fetch']>;

const apiKey = 'dev-secret-token-that-must-never-be-reported';
const productId = 'prod_monthly_private_identifier';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function productPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: productId,
      price: 2990,
      devMode: true,
      currency: 'BRL',
      status: 'ACTIVE',
      cycle: 'MONTHLY',
      trialDays: null,
      ...overrides,
    },
  };
}

function checkoutPayload(
  externalId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    success: true,
    error: null,
    data: {
      id: 'bill_private_identifier',
      externalId,
      url: 'https://app.abacatepay.com/pay/bill_private_identifier',
      status: 'PENDING',
      devMode: true,
      items: [{ id: productId, quantity: 1 }],
      ...overrides,
    },
  };
}

function createFetch(responses: Response[]) {
  return vi.fn<ProbeFetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return response;
  });
}

function probeConfig(fetcher: ProbeFetch): AbacatePaySandboxProbeConfig {
  let run = 0;
  return {
    apiKey,
    monthlyProductId: productId,
    fetch: fetcher,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    createRunId: () => `run-${++run}`,
    timeoutMs: 100,
  };
}

describe('runAbacatePaySandboxProbe', () => {
  it('não chama a rede quando a configuração obrigatória está ausente', async () => {
    const fetcher = vi.fn() as ProbeFetch;

    const report = await runAbacatePaySandboxProbe({
      apiKey: '',
      monthlyProductId: '',
      fetch: fetcher,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.result).toBe('BLOCKED');
    expect(report.missingConfiguration).toEqual([
      'ABACATEPAY_DEV_API_KEY',
      'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID',
    ]);
    expect(report.allowedMethods).toEqual(['CARD']);
  });

  it('recusa execução do sandbox quando NODE_ENV é production', async () => {
    const fetcher = vi.fn() as ProbeFetch;

    const report = await runAbacatePaySandboxProbe({
      ...probeConfig(fetcher),
      nodeEnv: 'production',
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.result).toBe('BLOCKED');
    expect(report.checks).toContainEqual({
      name: 'CONFIGURATION',
      status: 'BLOCKED',
      code: 'PRODUCTION_ENVIRONMENT_REFUSED',
    });
  });

  it('mantém somente CARD e bloqueia quando a API rejeita PIX sem código específico documentado', async () => {
    const fetcher = createFetch([
      jsonResponse(productPayload()),
      jsonResponse(checkoutPayload('probe-card-run-1')),
      jsonResponse({ error: 'PIX não disponível' }, 422),
    ]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('BLOCKED');
    expect(report.allowedMethods).toEqual(['CARD']);
    expect(report.methods.CARD).toEqual({
      decision: 'ENABLED',
      evidenceCode: 'CHECKOUT_ACCEPTED',
    });
    expect(report.methods.PIX).toEqual({
      decision: 'DISABLED',
      evidenceCode: 'REQUEST_REJECTED',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);

    const productCall = fetcher.mock.calls[0];
    expect(productCall?.[0]).toBe(
      `${ABACATEPAY_SANDBOX_API_URL}/products/get?id=${productId}`,
    );

    const cardBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    const pixBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(cardBody).toMatchObject({
      items: [{ id: productId, quantity: 1 }],
      methods: ['CARD'],
    });
    expect(pixBody).toMatchObject({
      items: [{ id: productId, quantity: 1 }],
      methods: ['PIX'],
    });
    expect(cardBody).not.toHaveProperty('cycle');
    expect(pixBody).not.toHaveProperty('cycle');
  });

  it('não habilita PIX quando o checkout é aceito sem prova de completed e renewed', async () => {
    const fetcher = createFetch([
      jsonResponse(productPayload()),
      jsonResponse(checkoutPayload('probe-card-run-1')),
      jsonResponse(checkoutPayload('probe-pix-run-2')),
    ]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('BLOCKED');
    expect(report.allowedMethods).toEqual(['CARD']);
    expect(report.methods.PIX).toEqual({
      decision: 'DISABLED',
      evidenceCode: 'PIX_METHOD_AND_RENEWAL_NOT_VALIDATED',
    });
    expect(report.checks).toContainEqual({
      name: 'PIX_CHECKOUT',
      status: 'BLOCKED',
      code: 'REQUEST_ACCEPTED_METHOD_UNCONFIRMED',
    });
    expect(report.checks).toContainEqual({
      name: 'PIX_RENEWAL',
      status: 'BLOCKED',
      code: 'COMPLETED_AND_RENEWED_NOT_VALIDATED',
    });
  });

  it.each([
    ['produto de produção', { devMode: false }],
    ['ciclo anual', { cycle: 'ANNUALLY' }],
    ['produto inativo', { status: 'INACTIVE' }],
    ['moeda desconhecida', { currency: 'USD' }],
    ['produto com trial', { trialDays: 7 }],
    ['trial impossível de confirmar', { trialDays: undefined }],
  ])('falha fechado para %s', async (_scenario, overrides) => {
    const fetcher = createFetch([jsonResponse(productPayload(overrides))]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('FAILED');
    expect(report.allowedMethods).toEqual(['CARD']);
    expect(report.methods.PIX.decision).toBe('DISABLED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('trata 403 no PIX como bloqueio inconclusivo, não como rejeição contratual', async () => {
    const fetcher = createFetch([
      jsonResponse(productPayload()),
      jsonResponse(checkoutPayload('probe-card-run-1')),
      jsonResponse({ error: 'forbidden' }, 403),
    ]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('BLOCKED');
    expect(report.methods.PIX.evidenceCode).toBe(
      'PERMISSION_OR_FEATURE_UNAVAILABLE',
    );
    expect(report.allowedMethods).toEqual(['CARD']);
  });

  it('não interpreta conflito HTTP 409 como prova de indisponibilidade do PIX', async () => {
    const fetcher = createFetch([
      jsonResponse(productPayload()),
      jsonResponse(checkoutPayload('probe-card-run-1')),
      jsonResponse({ error: 'conflict' }, 409),
    ]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('BLOCKED');
    expect(report.methods.PIX.evidenceCode).toBe('REQUEST_REJECTED');
    expect(report.allowedMethods).toEqual(['CARD']);
  });

  it('falha fechado quando a resposta 2xx muda de formato', async () => {
    const fetcher = createFetch([
      jsonResponse({ success: true, data: { id: productId } }),
    ]);

    const report = await runAbacatePaySandboxProbe(probeConfig(fetcher));

    expect(report.result).toBe('FAILED');
    expect(report.checks).toEqual([
      { name: 'PRODUCT', status: 'FAIL', code: 'UNEXPECTED_RESPONSE' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('emite somente campos allowlisted, sem token, URLs ou identificadores brutos', async () => {
    const checkoutId = 'bill_do_not_expose';
    const checkoutUrl = `https://app.abacatepay.com/pay/${checkoutId}`;
    const fetcher = createFetch([
      jsonResponse(productPayload()),
      jsonResponse(
        checkoutPayload('probe-card-run-1', {
          id: checkoutId,
          url: checkoutUrl,
        }),
      ),
      jsonResponse(
        { error: `rejected ${apiKey} ${checkoutUrl} ${productId}` },
        422,
      ),
    ]);

    const reportText = JSON.stringify(
      await runAbacatePaySandboxProbe(probeConfig(fetcher)),
    );

    expect(reportText).not.toContain(apiKey);
    expect(reportText).not.toContain(productId);
    expect(reportText).not.toContain(checkoutId);
    expect(reportText).not.toContain(checkoutUrl);
    expect(JSON.parse(reportText).allowedMethods).toEqual(['CARD']);
  });
});
