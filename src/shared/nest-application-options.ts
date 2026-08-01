import type { NestApplicationOptions } from '@nestjs/common';

export const nestApplicationOptions = {
  bufferLogs: true,
  rawBody: true,
} satisfies NestApplicationOptions;

/**
 * The production bootstrap installs a raw parser for the AbacatePay route
 * before the general JSON parser. This keeps authentication ahead of JSON
 * parsing, including for malformed or attacker-controlled bodies.
 */
export const webhookSafeNestApplicationOptions = {
  ...nestApplicationOptions,
  bodyParser: false,
} satisfies NestApplicationOptions;
