import { z } from 'zod';

export const telegramAiIntentSchema = z.enum([
  'EXPENSE',
  'INCOME',
  'INSTALLMENT',
  'RECURRING_UNSUPPORTED',
  'NON_FINANCIAL',
  'UNCLEAR',
]);

export const telegramAiResponseSchema = z.object({
  intent: telegramAiIntentSchema,
  confidence: z.number().min(0).max(1),
  amount: z
    .object({
      value: z.number().positive(),
      currency: z.literal('BRL'),
    })
    .nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  description: z.string().min(1).max(200).nullable(),
  accountHint: z.string().min(1).max(120).nullable(),
  categoryHint: z.string().min(1).max(120).nullable(),
  installments: z
    .object({
      count: z.number().int().positive(),
      totalIsKnown: z.boolean(),
    })
    .nullable(),
  missingFields: z.array(z.enum(['amount', 'account', 'category', 'date'])),
});

export type TelegramAiResponse = z.infer<typeof telegramAiResponseSchema>;

export const financialDraftSchema = z.object({
  action: z.enum(['TRANSACTION', 'INSTALLMENT_PLAN']),
  transactionType: z.enum(['income', 'expense']).optional(),
  amountCents: z.number().int().positive(),
  applicationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceMonth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  description: z.string().min(1).max(200),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  installments: z
    .object({
      count: z.number().int().min(2),
      totalIsKnown: z.boolean(),
    })
    .optional(),
  sourceMessageId: z.number().int().positive().optional(),
});

export type FinancialDraft = z.infer<typeof financialDraftSchema>;

export const telegramPendingPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FINANCIAL_DRAFT'),
    draft: financialDraftSchema,
  }),
  z.object({
    kind: z.literal('UNDO_OPERATION'),
    operationId: z.string().uuid(),
  }),
]);

export type TelegramPendingPayload = z.infer<typeof telegramPendingPayloadSchema>;
