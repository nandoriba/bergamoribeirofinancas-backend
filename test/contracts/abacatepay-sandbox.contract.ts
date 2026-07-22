import { existsSync } from 'node:fs';

import {
  ABACATEPAY_SANDBOX_CONTRACT_VERSION,
  runAbacatePaySandboxProbe,
  type AbacatePaySandboxProbeReport,
} from '../../src/modules/payments/abacatepay/sandbox-contract';

function exitCodeFor(report: AbacatePaySandboxProbeReport) {
  if (report.result === 'BLOCKED') return 2;
  return 1;
}

function writeReport(report: AbacatePaySandboxProbeReport) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const report = await runAbacatePaySandboxProbe({
    apiKey: process.env.ABACATEPAY_DEV_API_KEY?.trim() ?? '',
    monthlyProductId:
      process.env.ABACATEPAY_DEV_MONTHLY_PRODUCT_ID?.trim() ?? '',
    nodeEnv: process.env.NODE_ENV,
  });

  writeReport(report);
  process.exitCode = exitCodeFor(report);
}

void main().catch(() => {
  writeReport({
    contractVersion: ABACATEPAY_SANDBOX_CONTRACT_VERSION,
    provider: 'abacatepay',
    environment: 'sandbox',
    checkedAt: new Date().toISOString(),
    result: 'FAILED',
    product: {
      fingerprint: 'UNAVAILABLE',
      expectedCycle: 'MONTHLY',
      observedCycle: 'UNKNOWN',
      trial: 'UNKNOWN',
    },
    methods: {
      CARD: { decision: 'BLOCKED', evidenceCode: 'RUNNER_FAILURE' },
      PIX: { decision: 'DISABLED', evidenceCode: 'RUNNER_FAILURE' },
    },
    checks: [{ name: 'CONFIGURATION', status: 'FAIL', code: 'RUNNER_FAILURE' }],
    allowedMethods: ['CARD'],
  });
  process.exitCode = 1;
});
