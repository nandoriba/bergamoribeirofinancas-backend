import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8180),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  WEB_ORIGIN: z.string().default('http://127.0.0.1:8181'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  INITIAL_ADMIN_EMAIL: z.string().email().default('admin@casaribeiro.local'),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).default('change-me-local'),
  INITIAL_ADMIN_NAME: z.string().default('Administrador Casa Ribeiro'),
  FAMILY_NAME: z.string().default('Casa Ribeiro'),
});

export type AppConfig = z.infer<typeof schema>;

export function validateConfig(config: Record<string, unknown>) {
  return schema.parse(config);
}

export function configuration() {
  return validateConfig(process.env);
}

