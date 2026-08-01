import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const publicMessage =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? (payload as { message: string | string[] }).message
        : exception instanceof Error
          ? exception.message
          : 'Erro interno';
    const message = status >= 500 ? 'Erro interno' : publicMessage;

    if (status >= 500) {
      const errorType = exception instanceof Error ? exception.name : 'UnknownError';
      this.logger.error(`Unhandled server error (${errorType})`);
    }

    const details =
      status < 500 && typeof payload === 'object' && payload !== null ? payload : {};

    response.status(status).json({
      ...details,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
