import { NestFactory } from "@nestjs/core";

import { RetentionCliModule } from "../src/modules/retention/retention-cli.module";
import { TenantRetentionService } from "../src/modules/retention/tenant-retention.service";

async function main() {
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ["error", "warn"],
  });
  try {
    const result = await app.get(TenantRetentionService).run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : "RetentionError";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
