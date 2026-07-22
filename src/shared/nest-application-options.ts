import type { NestApplicationOptions } from '@nestjs/common';

export const nestApplicationOptions = {
  bufferLogs: true,
  rawBody: true,
} satisfies NestApplicationOptions;
