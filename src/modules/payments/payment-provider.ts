export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentProviderFailureKind =
  | 'unavailable'
  | 'ambiguous'
  | 'rejected'
  | 'contract';

export type PaymentProviderOperation =
  | 'get_product'
  | 'create_customer'
  | 'find_checkout'
  | 'create_checkout'
  | 'cancel_subscription';

export type PaymentProviderErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_TIMEOUT_OUTCOME_UNKNOWN'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_NETWORK_OUTCOME_UNKNOWN'
  | 'PROVIDER_HTTP_OUTCOME_UNKNOWN'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_REJECTED'
  | 'PROVIDER_RESOURCE_NOT_FOUND'
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_RESPONSE_REJECTED'
  | 'INVALID_PROVIDER_JSON'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'ENVIRONMENT_MISMATCH'
  | 'RESOURCE_CORRELATION_MISMATCH'
  | 'INVALID_CHECKOUT_URL'
  | 'DUPLICATE_EXTERNAL_ID'
  | 'CHECKOUT_LOOKUP_TRUNCATED';

export class PaymentProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: PaymentProviderFailureKind,
    readonly code: PaymentProviderErrorCode,
    readonly operation: PaymentProviderOperation,
    readonly status: number | null = null,
  ) {
    super('Payment provider operation failed.');
    this.name = 'PaymentProviderError';
    this.retryable = kind === 'unavailable';
  }
}

export type PaymentMetadataValue = string | number | boolean | null;
export type PaymentMetadata = Readonly<Record<string, PaymentMetadataValue>>;

export type PaymentBillingCycle =
  | 'WEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'ANNUALLY';

export interface PaymentProduct {
  id: string;
  name: string;
  priceCents: number;
  currency: 'BRL';
  status: 'ACTIVE' | 'INACTIVE';
  cycle: PaymentBillingCycle | null;
  trialDays: number | null;
  devMode: boolean;
}

export interface CreatePaymentCustomerInput {
  email: string;
  name?: string;
  metadata?: PaymentMetadata;
}

export interface PaymentCustomer {
  id: string;
  email: string;
  name: string | null;
  devMode: boolean;
}

export type PaymentCheckoutStatus =
  | 'PENDING'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface PaymentCheckout {
  id: string;
  externalId: string;
  url: string;
  amountCents: number;
  currency: 'BRL';
  status: PaymentCheckoutStatus;
  customerId: string | null;
  productId: string;
  quantity: 1;
  devMode: boolean;
}

export interface PaymentRetryPolicy {
  maxRetries: number;
  intervalDays: number;
}

export interface CreateMonthlyCheckoutInput {
  productId: string;
  externalId: string;
  customerId?: string;
  metadata?: PaymentMetadata;
  returnUrl: string;
  completionUrl: string;
  retryPolicy?: PaymentRetryPolicy;
}

export interface CancelledPaymentSubscription {
  id: string;
  customerId: string | null;
  amountCents: number;
  currency: 'BRL';
  method: 'CARD';
  status: 'CANCELLED';
  devMode: boolean;
}

export interface PaymentProvider {
  getProduct(id: string): Promise<PaymentProduct>;
  createCustomer(input: CreatePaymentCustomerInput): Promise<PaymentCustomer>;
  findCheckoutByExternalId(externalId: string): Promise<PaymentCheckout | null>;
  createMonthlyCheckout(input: CreateMonthlyCheckoutInput): Promise<PaymentCheckout>;
  cancelSubscription(id: string): Promise<CancelledPaymentSubscription>;
}
