import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import {
  type CancelledPaymentSubscription,
  type CreateMonthlyCheckoutInput,
  type CreatePaymentCustomerInput,
  type PaymentCheckout,
  type PaymentCustomer,
  type PaymentProduct,
  type PaymentProvider,
  PaymentProviderError,
  type PaymentProviderErrorCode,
  type PaymentProviderOperation,
} from '../payment-provider';

export const ABACATEPAY_HTTP_FETCH = Symbol('ABACATEPAY_HTTP_FETCH');

export type AbacatePayHttpFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const idSchema = z.string().trim().min(1).max(255);
const providerProductIdSchema = idSchema.regex(/^prod[_-][A-Za-z0-9_-]+$/);
const providerCustomerIdSchema = idSchema.regex(/^cust_[A-Za-z0-9_-]+$/);
const providerCheckoutIdSchema = idSchema.regex(/^bill_[A-Za-z0-9_-]+$/);
const providerSubscriptionIdSchema = idSchema.regex(/^subs_[A-Za-z0-9_-]+$/);
const externalIdSchema = z.string().trim().min(1).max(255);
const metadataValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const metadataSchema = z.record(metadataValueSchema);
const billingCycleSchema = z.enum([
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUALLY',
  'ANNUALLY',
]);
const checkoutStatusSchema = z.enum([
  'PENDING',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);

const httpUrlSchema = z.string().url().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid URL' });
    return;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid URL' });
  }
});

const createCustomerInputSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(200).optional(),
  metadata: metadataSchema.optional(),
});

const retryPolicySchema = z.object({
  maxRetries: z.number().int().min(1).max(10),
  intervalDays: z.number().int().min(1).max(30),
});

const createCheckoutInputSchema = z.object({
  productId: providerProductIdSchema,
  externalId: externalIdSchema,
  customerId: providerCustomerIdSchema.optional(),
  metadata: metadataSchema.optional(),
  returnUrl: httpUrlSchema,
  completionUrl: httpUrlSchema,
  retryPolicy: retryPolicySchema.optional(),
});

const productSchema = z.object({
  id: providerProductIdSchema,
  name: z.string().min(1),
  price: z.number().int().positive(),
  currency: z.literal('BRL'),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  cycle: billingCycleSchema.nullable(),
  trialDays: z.number().int().min(0).max(90).nullable(),
  devMode: z.boolean(),
});

const customerSchema = z.object({
  id: providerCustomerIdSchema,
  email: z.string().email(),
  name: z.string().min(1).nullable().optional(),
  devMode: z.boolean(),
});

const checkoutSchema = z.object({
  id: providerCheckoutIdSchema,
  externalId: externalIdSchema,
  url: z.string().url(),
  amount: z.number().int().positive(),
  currency: z.literal('BRL').optional(),
  status: checkoutStatusSchema,
  devMode: z.boolean(),
  customerId: providerCustomerIdSchema.nullable().optional(),
  items: z
    .array(
      z.object({
        id: providerProductIdSchema,
        quantity: z.literal(1),
      }),
    )
    .length(1),
});

const cancelledSubscriptionSchema = z.object({
  id: providerSubscriptionIdSchema,
  customerId: providerCustomerIdSchema.nullable().optional(),
  amount: z.number().int().positive(),
  currency: z.literal('BRL'),
  method: z.literal('CARD'),
  status: z.literal('CANCELLED'),
  devMode: z.boolean(),
});

function successEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.literal(true),
    error: z.null().optional(),
    data,
  });
}

const productEnvelopeSchema = successEnvelope(productSchema);
const customerEnvelopeSchema = successEnvelope(customerSchema);
const checkoutEnvelopeSchema = successEnvelope(checkoutSchema);
const cancelledSubscriptionEnvelopeSchema = successEnvelope(
  cancelledSubscriptionSchema,
);
const checkoutListEnvelopeSchema = successEnvelope(z.array(checkoutSchema)).extend({
  pagination: z
    .object({
      hasMore: z.boolean(),
      next: z.string().nullable().optional(),
      before: z.string().nullable().optional(),
    })
    .optional(),
});
const rejectedEnvelopeSchema = z.object({ success: z.literal(false) });

interface RuntimeConfig {
  apiKey: string;
  baseUrl: string;
  expectedDevMode: boolean;
  timeoutMs: number;
}

interface CheckoutExpectation {
  externalId: string;
  productId?: string;
  customerId?: string;
  initial?: boolean;
}

interface AbacatePayCheckoutPayload {
  items: [{ id: string; quantity: 1 }];
  methods: ['CARD'];
  externalId: string;
  returnUrl: string;
  completionUrl: string;
  customerId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  retryPolicy?: {
    maxRetry: number;
    retryEvery: number;
  };
}

@Injectable()
export class AbacatePayV2Client implements PaymentProvider {
  constructor(
    private readonly config: ConfigService,
    @Inject(ABACATEPAY_HTTP_FETCH)
    private readonly httpFetch: AbacatePayHttpFetch,
  ) {}

  async getProduct(rawId: string): Promise<PaymentProduct> {
    const operation = 'get_product' as const;
    const id = this.parseInput(providerProductIdSchema, rawId, operation);
    const runtime = this.runtimeConfig(operation);
    const url = this.endpoint(runtime, '/products/get', { id });
    const envelope = await this.requestJson(
      runtime,
      operation,
      'GET',
      url,
      productEnvelopeSchema,
    );
    const product = envelope.data;

    this.assertEnvironment(product.devMode, runtime, operation);
    if (product.id !== id) {
      throw this.contractError(operation, 'RESOURCE_CORRELATION_MISMATCH');
    }

    return {
      id: product.id,
      name: product.name,
      priceCents: product.price,
      currency: product.currency,
      status: product.status,
      cycle: product.cycle,
      trialDays: product.trialDays ?? null,
      devMode: product.devMode,
    };
  }

  async createCustomer(
    rawInput: CreatePaymentCustomerInput,
  ): Promise<PaymentCustomer> {
    const operation = 'create_customer' as const;
    const input = this.parseInput(
      createCustomerInputSchema,
      rawInput,
      operation,
    );
    const runtime = this.runtimeConfig(operation);
    const body = {
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const envelope = await this.requestJson(
      runtime,
      operation,
      'POST',
      this.endpoint(runtime, '/customers/create'),
      customerEnvelopeSchema,
      body,
    );
    const customer = envelope.data;

    this.assertEnvironment(customer.devMode, runtime, operation);
    if (customer.email.trim().toLowerCase() !== input.email.toLowerCase()) {
      throw this.contractError(operation, 'RESOURCE_CORRELATION_MISMATCH');
    }

    return {
      id: customer.id,
      email: customer.email,
      name: customer.name ?? null,
      devMode: customer.devMode,
    };
  }

  async findCheckoutByExternalId(
    rawExternalId: string,
  ): Promise<PaymentCheckout | null> {
    const operation = 'find_checkout' as const;
    const externalId = this.parseInput(
      externalIdSchema,
      rawExternalId,
      operation,
    );
    const runtime = this.runtimeConfig(operation);
    const url = this.endpoint(runtime, '/subscriptions/list', {
      externalId,
      limit: '2',
    });
    const envelope = await this.requestJson(
      runtime,
      operation,
      'GET',
      url,
      checkoutListEnvelopeSchema,
    );

    const checkouts = envelope.data.map((checkout) =>
      this.normalizeCheckout(checkout, runtime, operation, { externalId }),
    );
    if (checkouts.length > 1) {
      throw new PaymentProviderError(
        'ambiguous',
        'DUPLICATE_EXTERNAL_ID',
        operation,
      );
    }
    if (envelope.pagination?.hasMore) {
      throw new PaymentProviderError(
        'ambiguous',
        'CHECKOUT_LOOKUP_TRUNCATED',
        operation,
      );
    }

    return checkouts[0] ?? null;
  }

  async createMonthlyCheckout(
    rawInput: CreateMonthlyCheckoutInput,
  ): Promise<PaymentCheckout> {
    const operation = 'create_checkout' as const;
    const input = this.parseInput(
      createCheckoutInputSchema,
      rawInput,
      operation,
    );
    const runtime = this.runtimeConfig(operation);
    const body: AbacatePayCheckoutPayload = {
      items: [{ id: input.productId, quantity: 1 }],
      methods: ['CARD'],
      externalId: input.externalId,
      returnUrl: input.returnUrl,
      completionUrl: input.completionUrl,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.retryPolicy
        ? {
            retryPolicy: {
              maxRetry: input.retryPolicy.maxRetries,
              retryEvery: input.retryPolicy.intervalDays,
            },
          }
        : {}),
    };
    const envelope = await this.requestJson(
      runtime,
      operation,
      'POST',
      this.endpoint(runtime, '/subscriptions/create'),
      checkoutEnvelopeSchema,
      body,
    );

    return this.normalizeCheckout(envelope.data, runtime, operation, {
      externalId: input.externalId,
      productId: input.productId,
      customerId: input.customerId,
      initial: true,
    });
  }

  async cancelSubscription(
    rawId: string,
  ): Promise<CancelledPaymentSubscription> {
    const operation = 'cancel_subscription' as const;
    const id = this.parseInput(providerSubscriptionIdSchema, rawId, operation);
    const runtime = this.runtimeConfig(operation);
    const envelope = await this.requestJson(
      runtime,
      operation,
      'POST',
      this.endpoint(runtime, '/subscriptions/cancel'),
      cancelledSubscriptionEnvelopeSchema,
      { id },
    );
    const subscription = envelope.data;

    this.assertEnvironment(subscription.devMode, runtime, operation);
    if (subscription.id !== id) {
      throw this.contractError(operation, 'RESOURCE_CORRELATION_MISMATCH');
    }

    return {
      id: subscription.id,
      customerId: subscription.customerId ?? null,
      amountCents: subscription.amount,
      currency: subscription.currency,
      method: subscription.method,
      status: subscription.status,
      devMode: subscription.devMode,
    };
  }

  private normalizeCheckout(
    checkout: z.infer<typeof checkoutSchema>,
    runtime: RuntimeConfig,
    operation: PaymentProviderOperation,
    expected: CheckoutExpectation,
  ): PaymentCheckout {
    this.assertEnvironment(checkout.devMode, runtime, operation);
    if (
      checkout.externalId !== expected.externalId ||
      (expected.productId && checkout.items[0]?.id !== expected.productId) ||
      (expected.customerId && checkout.customerId !== expected.customerId) ||
      (expected.initial && checkout.status !== 'PENDING')
    ) {
      throw this.contractError(operation, 'RESOURCE_CORRELATION_MISMATCH');
    }

    const expectedUrl = `https://app.abacatepay.com/pay/${checkout.id}`;
    if (checkout.url !== expectedUrl) {
      throw this.contractError(operation, 'INVALID_CHECKOUT_URL');
    }

    return {
      id: checkout.id,
      externalId: checkout.externalId,
      url: checkout.url,
      amountCents: checkout.amount,
      currency: 'BRL',
      status: checkout.status,
      customerId: checkout.customerId ?? null,
      productId: checkout.items[0].id,
      quantity: 1,
      devMode: checkout.devMode,
    };
  }

  private runtimeConfig(operation: PaymentProviderOperation): RuntimeConfig {
    const production = this.config.get<string>('NODE_ENV') === 'production';
    const apiKeyName = production
      ? 'ABACATEPAY_PROD_API_KEY'
      : 'ABACATEPAY_DEV_API_KEY';
    const apiUrlName = production
      ? 'ABACATEPAY_PROD_API_URL'
      : 'ABACATEPAY_DEV_API_URL';
    const candidate = {
      apiKey: this.config.get<string>(apiKeyName),
      baseUrl: this.config.get<string>(apiUrlName),
      timeoutMs: this.config.get<number>('ABACATEPAY_TIMEOUT_MS'),
    };
    const parsed = z
      .object({
        apiKey: z.string().trim().min(1),
        baseUrl: z.string().url(),
        timeoutMs: z.number().int().positive(),
      })
      .safeParse(candidate);
    if (!parsed.success || !this.isSafeApiBaseUrl(parsed.data.baseUrl)) {
      throw this.contractError(operation, 'INVALID_CONFIGURATION');
    }

    return {
      ...parsed.data,
      baseUrl: parsed.data.baseUrl.replace(/\/+$/, ''),
      expectedDevMode: !production,
    };
  }

  private isSafeApiBaseUrl(value: string): boolean {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.abacatepay.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname.replace(/\/+$/, '') === '/v2'
    );
  }

  private endpoint(
    runtime: RuntimeConfig,
    path: string,
    query?: Record<string, string>,
  ): string {
    const url = new URL(`${runtime.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private parseInput<T>(
    schema: z.ZodType<T>,
    input: unknown,
    operation: PaymentProviderOperation,
  ): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw this.contractError(operation, 'INVALID_INPUT');
    }
    return parsed.data;
  }

  private async requestJson<T>(
    runtime: RuntimeConfig,
    operation: PaymentProviderOperation,
    method: 'GET' | 'POST',
    url: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.httpFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${runtime.apiKey}`,
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        throw this.transportError(method, operation, this.isAbortError(error));
      }

      if (!response.ok) {
        throw this.httpError(method, operation, response.status);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || this.isAbortError(error)) {
          throw this.transportError(method, operation, true);
        }
        throw this.contractError(
          operation,
          'INVALID_PROVIDER_JSON',
          response.status,
        );
      }

      if (rejectedEnvelopeSchema.safeParse(payload).success) {
        throw new PaymentProviderError(
          'rejected',
          'PROVIDER_RESPONSE_REJECTED',
          operation,
          response.status,
        );
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw this.contractError(
          operation,
          'INVALID_PROVIDER_RESPONSE',
          response.status,
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private transportError(
    method: 'GET' | 'POST',
    operation: PaymentProviderOperation,
    timedOut: boolean,
  ): PaymentProviderError {
    if (method === 'POST') {
      return new PaymentProviderError(
        'ambiguous',
        timedOut
          ? 'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN'
          : 'PROVIDER_NETWORK_OUTCOME_UNKNOWN',
        operation,
      );
    }
    return new PaymentProviderError(
      'unavailable',
      timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      operation,
    );
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private httpError(
    method: 'GET' | 'POST',
    operation: PaymentProviderOperation,
    status: number,
  ): PaymentProviderError {
    if (status === 408 && method === 'POST') {
      return new PaymentProviderError(
        'ambiguous',
        'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN',
        operation,
        status,
      );
    }
    if (status === 408) {
      return new PaymentProviderError(
        'unavailable',
        'PROVIDER_TIMEOUT',
        operation,
        status,
      );
    }
    if (method === 'POST' && status === 409) {
      return new PaymentProviderError(
        'ambiguous',
        'DUPLICATE_EXTERNAL_ID',
        operation,
        status,
      );
    }
    if (method === 'POST' && status === 425) {
      return new PaymentProviderError(
        'ambiguous',
        'PROVIDER_HTTP_OUTCOME_UNKNOWN',
        operation,
        status,
      );
    }
    if (status === 429) {
      return new PaymentProviderError(
        method === 'POST' ? 'ambiguous' : 'unavailable',
        'PROVIDER_RATE_LIMITED',
        operation,
        status,
      );
    }
    if (status >= 500) {
      return new PaymentProviderError(
        method === 'POST' ? 'ambiguous' : 'unavailable',
        'PROVIDER_UNAVAILABLE',
        operation,
        status,
      );
    }
    if (status === 401 || status === 403) {
      return new PaymentProviderError(
        'rejected',
        'PROVIDER_AUTHENTICATION_REJECTED',
        operation,
        status,
      );
    }
    if (status === 404) {
      return new PaymentProviderError(
        'rejected',
        'PROVIDER_RESOURCE_NOT_FOUND',
        operation,
        status,
      );
    }
    if (status >= 400 && status < 500) {
      return new PaymentProviderError(
        'rejected',
        'PROVIDER_REQUEST_REJECTED',
        operation,
        status,
      );
    }
    return this.contractError(operation, 'INVALID_PROVIDER_RESPONSE', status);
  }

  private assertEnvironment(
    devMode: boolean,
    runtime: RuntimeConfig,
    operation: PaymentProviderOperation,
  ): void {
    if (devMode !== runtime.expectedDevMode) {
      throw this.contractError(operation, 'ENVIRONMENT_MISMATCH');
    }
  }

  private contractError(
    operation: PaymentProviderOperation,
    code: PaymentProviderErrorCode,
    status: number | null = null,
  ): PaymentProviderError {
    return new PaymentProviderError('contract', code, operation, status);
  }
}

export { AbacatePayV2Client as AbacatePayClient };
