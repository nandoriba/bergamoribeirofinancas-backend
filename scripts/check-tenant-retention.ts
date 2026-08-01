import { NestFactory } from "@nestjs/core";

import { RetentionCliModule } from "../src/modules/retention/retention-cli.module";
import { TenantRetentionService } from "../src/modules/retention/tenant-retention.service";

async function main() {
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ["error", "warn"],
  });
  try {
    const health = await app.get(TenantRetentionService).health();
    process.stdout.write(`${JSON.stringify(health)}\n`);
    if (!health.healthy) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : "RetentionHealthError";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
