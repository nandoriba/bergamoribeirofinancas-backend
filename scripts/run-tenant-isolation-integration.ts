import { PrismaClient } from '@prisma/client';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

async function main() {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? readDatabaseUrlFromEnvFile();
  if (!baseUrl) {
    throw new Error('Defina TEST_DATABASE_URL ou DATABASE_URL para executar os testes PostgreSQL');
  }

  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
    throw new Error('O teste de integração exige PostgreSQL');
  }

  const schema = `it_tenant_${randomUUID().replaceAll('-', '')}`;
  const testUrl = withSchema(baseUrl, schema);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  let api: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await stopChild(api);
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.$disconnect();
      }
    })();
    return cleanupPromise;
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    runNodeCli(path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), ['migrate', 'deploy'], {
      DATABASE_URL: testUrl,
    });
    runNodeCli(path.join(process.cwd(), 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'), ['build'], {
      DATABASE_URL: testUrl,
    });
    const apiEntrypoint = path.join(process.cwd(), 'dist', 'src', 'main.js');
    await waitForBuildArtifact(apiEntrypoint);
    const port = await reservePort();
    api = spawn(process.execPath, [apiEntrypoint], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testUrl, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    api.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    await waitForApi(api, `http://127.0.0.1:${port}/health`);
    runNodeCli(path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'), [
      'run',
      '--config',
      'vitest.integration.config.ts',
    ], {
      DATABASE_URL: testUrl,
      RUN_TENANT_INTEGRATION: 'true',
      TEST_API_URL: `http://127.0.0.1:${port}`,
    });
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await cleanup();
  }
}

async function waitForBuildArtifact(entrypoint: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(entrypoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Artefato da API não foi gerado: ${entrypoint}`);
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForApi(api: ChildProcess, healthUrl: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`A API encerrou antes do teste (código ${String(api.exitCode)})`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // A porta ainda não abriu.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('A API de integração não iniciou dentro do prazo');
}

async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function runNodeCli(entrypoint: string, args: string[], extraEnv: Record<string, string>) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Comando falhou com código ${String(result.status)}`);
}

function withSchema(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function readDatabaseUrlFromEnvFile() {
  try {
    const contents = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const line = contents.split(/\r?\n/).find((entry) => entry.startsWith('DATABASE_URL='));
    return line?.slice('DATABASE_URL='.length).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Falha desconhecida';
  process.stderr.write(`Falha no teste PostgreSQL: ${message}\n`);
  process.exitCode = 1;
});
