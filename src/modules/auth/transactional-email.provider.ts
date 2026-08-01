export const TRANSACTIONAL_EMAIL_PROVIDER = Symbol('TRANSACTIONAL_EMAIL_PROVIDER');

export interface TransactionalEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface TransactionalEmailProvider {
  send(message: TransactionalEmailMessage): Promise<{ providerMessageId: string }>;
}

export class EmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super('Transactional email delivery failed.');
    this.name = 'EmailDeliveryError';
  }
}
