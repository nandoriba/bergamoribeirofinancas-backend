import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './shared/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const webOrigin = config.getOrThrow<string>('WEB_ORIGIN');
  const nodeEnv = config.getOrThrow<string>('NODE_ENV');
  const allowedOrigins = webOrigin.split(',').map((origin) => origin.trim());

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || isAllowedLocalDevOrigin(origin, nodeEnv)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origem não permitida pelo CORS: ${origin}`));
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('PORT');
  const host = nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1';
  await app.listen(port, host);
  logger.log(`Financeiro API listening at http://${host}:${port}`);
}

void bootstrap();

function isAllowedLocalDevOrigin(origin: string, nodeEnv: string): boolean {
  if (nodeEnv === 'production') {
    return false;
  }

  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
}
