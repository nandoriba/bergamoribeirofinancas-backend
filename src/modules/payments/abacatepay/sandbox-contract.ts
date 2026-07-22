import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

export const ABACATEPAY_SANDBOX_API_URL = 'https://api.abacatepay.com/v2';
export const ABACATEPAY_SANDBOX_CONTRACT_VERSION = '1';

const productEnvelopeSchema = z.object({
  success: z.literal(true),
  error: z.null().optional(),
  data: z.object({
    id: z.string().min(1),
    price: z.number().int().positive(),
    devMode: z.boolean(),
    currency: z.string(),
    status: z.string(),
    cycle: z.string().nullable(),
    trialDays: z.number().int().min(0).max(90).nullable().optional(),
  }),
});

const checkoutEnvelopeSchema = z.object({
  success: z.literal(true),
  error: z.null().optional(),
  data: z.object({
    id: z.string().min(1),
    externalId: z.string().min(1),
    url: z.string().url(),
    status: z.string(),
    devMode: z.boolean(),
    items: z.array(
      z.object({
        id: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    ),
  }),
});

type PaymentMethod = 'CARD' | 'PIX';
type ProbeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
type ProbeResult = 'BLOCKED' | 'FAILED';
type CheckStatus = 'PASS' | 'BLOCKED' | 'FAIL';

export interface AbacatePaySandboxProbeConfig {
  apiKey: string;
  monthlyProductId: string;
  nodeEnv?: string;
  fetch?: ProbeFetch;
  now?: () => Date;
  createRunId?: () => string;
  timeoutMs?: number;
}

export interface AbacatePaySandboxProbeReport {
  contractVersion: typeof ABACATEPAY_SANDBOX_CONTRACT_VERSION;
  provider: 'abacatepay';
  environment: 'sandbox';
  checkedAt: string;
  result: ProbeResult;
  product: {
    fingerprint: string;
    expectedCycle: 'MONTHLY';
    observedCycle: 'MONTHLY' | 'OTHER' | 'UNKNOWN';
    trial: 'NONE' | 'PRESENT' | 'UNKNOWN';
  };
  methods: {
    CARD: {
      decision: 'ENABLED' | 'BLOCKED';
      evidenceCode: string;
    };
    PIX: {
      decision: 'DISABLED';
      evidenceCode: string;
    };
  };
  checks: Array<{
    name:
      | 'CONFIGURATION'
      | 'PRODUCT'
      | 'CARD_CHECKOUT'
      | 'PIX_CHECKOUT'
      | 'PIX_RENEWAL';
    status: CheckStatus;
    code: string;
  }>;
  allowedMethods: ['CARD'];
  missingConfiguration?: Array<
    'ABACATEPAY_DEV_API_KEY' | 'ABACATEPAY_DEV_MONTHLY_PRODUCT_ID'
  >;
}

interface RequestResult {
  ok: boolean;
  status: number | null;
  payload?: unknown;
  errorCode?: string;
}

interface CheckoutResult {
  ok: boolean;
  code: string;
  status: number | null;
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function classifyHttpStatus(status: number) {
  if (status === 401) return 'AUTHENTICATION_REJECTED';
  if (status === 403) return 'PERMISSION_OR_FEATURE_UNAVAILABLE';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status === 400 || status === 409 || status === 422)
    return 'REQUEST_REJECTED';
  return 'HTTP_UNEXPECTED';
}

async function requestJson(
  fetcher: ProbeFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<RequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorCode: classifyHttpStatus(response.status),
      };
    }

    try {
      return {
        ok: true,
        status: response.status,
        payload: await response.json(),
      };
    } catch {
      return { ok: false, status: response.status, errorCode: 'INVALID_JSON' };
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      errorCode:
        error instanceof Error && error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'NETWORK_ERROR',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function baseReport(
  config: AbacatePaySandboxProbeConfig,
): AbacatePaySandboxProbeReport {
  return {
    contractVersion: ABACATEPAY_SANDBOX_CONTRACT_VERSION,
    provider: 'abacatepay',
    environment: 'sandbox',
    checkedAt: (config.now ?? (() => new Date()))().toISOString(),
    result: 'BLOCKED',
    product: {
      fingerprint: config.monthlyProductId.trim()
        ? fingerprint(config.monthlyProductId)
        : 'UNAVAILABLE',
      expectedCycle: 'MONTHLY',
      observedCycle: 'UNKNOWN',
      trial: 'UNKNOWN',
    },
    methods: {
      CARD: { decision: 'BLOCKED', evidenceCode: 'NOT_CHECKED' },
      PIX: { decision: 'DISABLED', evidenceCode: 'NOT_CHECKED' },
    },
    checks: [],
    allowedMethods: ['CARD'],
  };
}

function authorizationHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function checkoutPayload(
  productId: string,
  method: PaymentMethod,
  externalId: string,
) {
  return {
    items: [{ id: productId, quantity: 1 }],
    methods: [method],
    externalId,
    metadata: {
      contract: 'abacatepay-sandbox-pix-v1',
      purpose: 'capability-validation',
    },
  };
}

async function createCheckout(
  config: Required<
    Pick<
      AbacatePaySandboxProbeConfig,
      'apiKey' | 'monthlyProductId' | 'timeoutMs'
    >
  > & {
    fetcher: ProbeFetch;
  },
  method: PaymentMethod,
  externalId: string,
): Promise<CheckoutResult> {
  const response = await requestJson(
    config.fetcher,
    `${ABACATEPAY_SANDBOX_API_URL}/subscriptions/create`,
    {
      method: 'POST',
      headers: authorizationHeaders(config.apiKey),
      body: JSON.stringify(
        checkoutPayload(config.monthlyProductId, method, externalId),
      ),
    },
    config.timeoutMs,
  );

  if (!response.ok) {
    return {
      ok: false,
      code: response.errorCode ?? 'UNKNOWN_ERROR',
      status: response.status,
    };
  }

  const parsed = checkoutEnvelopeSchema.safeParse(response.payload);
  if (!parsed.success) {
    return { ok: false, code: 'UNEXPECTED_RESPONSE', status: response.status };
  }

  const checkout = parsed.data.data;
  const expectedItem =
    checkout.items.length === 1 &&
    checkout.items[0]?.id === config.monthlyProductId;
  const isCorrelated = checkout.externalId === externalId;
  if (
    !checkout.devMode ||
    checkout.status !== 'PENDING' ||
    !expectedItem ||
    checkout.items[0]?.quantity !== 1 ||
    !isCorrelated
  ) {
    return {
      ok: false,
      code: 'CHECKOUT_INVARIANT_MISMATCH',
      status: response.status,
    };
  }

  return { ok: true, code: 'CHECKOUT_ACCEPTED', status: response.status };
}

export async function runAbacatePaySandboxProbe(
  input: AbacatePaySandboxProbeConfig,
): Promise<AbacatePaySandboxProbeReport> {
  const report = baseReport(input);
  const missingConfiguration: AbacatePaySandboxProbeReport['missingConfiguration'] =
    [];
  if (!input.apiKey.trim()) missingConfiguration.push('ABACATEPAY_DEV_API_KEY');
  if (!input.monthlyProductId.trim()) {
    missingConfiguration.push('ABACATEPAY_DEV_MONTHLY_PRODUCT_ID');
  }
  if (missingConfiguration.length > 0) {
    report.missingConfiguration = missingConfiguration;
    report.checks.push({
      name: 'CONFIGURATION',
      status: 'BLOCKED',
      code: 'MISSING_SANDBOX_CONFIGURATION',
    });
    report.methods.PIX.evidenceCode = 'SANDBOX_NOT_CONFIGURED';
    return report;
  }
  if (input.nodeEnv === 'production') {
    report.checks.push({
      name: 'CONFIGURATION',
      status: 'BLOCKED',
      code: 'PRODUCTION_ENVIRONMENT_REFUSED',
    });
    report.methods.PIX.evidenceCode = 'SANDBOX_EXECUTION_REFUSED';
    return report;
  }

  const fetcher = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const config = {
    apiKey: input.apiKey,
    monthlyProductId: input.monthlyProductId,
    timeoutMs,
    fetcher,
  };

  const productResponse = await requestJson(
    fetcher,
    `${ABACATEPAY_SANDBOX_API_URL}/products/get?id=${encodeURIComponent(input.monthlyProductId)}`,
    { method: 'GET', headers: authorizationHeaders(input.apiKey) },
    timeoutMs,
  );

  if (!productResponse.ok) {
    const code = productResponse.errorCode ?? 'UNKNOWN_ERROR';
    const isFixableContractFailure = [
      'REQUEST_REJECTED',
      'RESOURCE_NOT_FOUND',
      'UNEXPECTED_RESPONSE',
    ].includes(code);
    report.result = isFixableContractFailure ? 'FAILED' : 'BLOCKED';
    report.checks.push({
      name: 'PRODUCT',
      status: isFixableContractFailure ? 'FAIL' : 'BLOCKED',
      code,
    });
    report.methods.PIX.evidenceCode = 'PRODUCT_NOT_VALIDATED';
    return report;
  }

  const parsedProduct = productEnvelopeSchema.safeParse(
    productResponse.payload,
  );
  if (!parsedProduct.success) {
    report.result = 'FAILED';
    report.checks.push({
      name: 'PRODUCT',
      status: 'FAIL',
      code: 'UNEXPECTED_RESPONSE',
    });
    report.methods.PIX.evidenceCode = 'PRODUCT_NOT_VALIDATED';
    return report;
  }

  const product = parsedProduct.data.data;
  report.product.observedCycle =
    product.cycle === 'MONTHLY'
      ? 'MONTHLY'
      : product.cycle == null
        ? 'UNKNOWN'
        : 'OTHER';
  report.product.trial =
    product.trialDays === null || product.trialDays === 0
      ? 'NONE'
      : product.trialDays === undefined
        ? 'UNKNOWN'
        : 'PRESENT';
  if (
    product.id !== input.monthlyProductId ||
    !product.devMode ||
    product.cycle !== 'MONTHLY' ||
    product.status !== 'ACTIVE' ||
    product.currency !== 'BRL' ||
    report.product.trial !== 'NONE'
  ) {
    report.result = 'FAILED';
    report.checks.push({
      name: 'PRODUCT',
      status: 'FAIL',
      code: 'PRODUCT_INVARIANT_MISMATCH',
    });
    report.methods.PIX.evidenceCode = 'PRODUCT_NOT_VALIDATED';
    return report;
  }
  report.checks.push({
    name: 'PRODUCT',
    status: 'PASS',
    code: 'DEV_MONTHLY_PRODUCT_CONFIRMED',
  });

  const createRunId = input.createRunId ?? randomUUID;
  const cardResult = await createCheckout(
    config,
    'CARD',
    `probe-card-${createRunId()}`,
  );
  if (!cardResult.ok) {
    const isProviderBlock = [
      'AUTHENTICATION_REJECTED',
      'PERMISSION_OR_FEATURE_UNAVAILABLE',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
    ].includes(cardResult.code);
    report.result = isProviderBlock ? 'BLOCKED' : 'FAILED';
    report.checks.push({
      name: 'CARD_CHECKOUT',
      status: isProviderBlock ? 'BLOCKED' : 'FAIL',
      code: cardResult.code,
    });
    report.methods.CARD.evidenceCode = cardResult.code;
    report.methods.PIX.evidenceCode = 'CARD_CONTROL_FAILED';
    return report;
  }
  report.checks.push({
    name: 'CARD_CHECKOUT',
    status: 'PASS',
    code: cardResult.code,
  });
  report.methods.CARD = {
    decision: 'ENABLED',
    evidenceCode: 'CHECKOUT_ACCEPTED',
  };

  const pixResult = await createCheckout(
    config,
    'PIX',
    `probe-pix-${createRunId()}`,
  );
  if (!pixResult.ok) {
    const isProviderBlock = [
      'AUTHENTICATION_REJECTED',
      'PERMISSION_OR_FEATURE_UNAVAILABLE',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
      'REQUEST_REJECTED',
    ].includes(pixResult.code);
    report.result = isProviderBlock ? 'BLOCKED' : 'FAILED';
    report.checks.push({
      name: 'PIX_CHECKOUT',
      status: isProviderBlock ? 'BLOCKED' : 'FAIL',
      code: pixResult.code,
    });
    report.methods.PIX.evidenceCode = pixResult.code;
    return report;
  }

  report.result = 'BLOCKED';
  report.checks.push({
    name: 'PIX_CHECKOUT',
    status: 'BLOCKED',
    code: 'REQUEST_ACCEPTED_METHOD_UNCONFIRMED',
  });
  report.checks.push({
    name: 'PIX_RENEWAL',
    status: 'BLOCKED',
    code: 'COMPLETED_AND_RENEWED_NOT_VALIDATED',
  });
  report.methods.PIX.evidenceCode = 'PIX_METHOD_AND_RENEWAL_NOT_VALIDATED';
  return report;
}
