import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('contrato operacional do worker Telegram', () => {
  it('documenta réplica única, fila global e evolução por chat', () => {
    const documentation = readFileSync(
      resolve(process.cwd(), 'docs/TELEGRAM_TENANT_ACCESS.md'),
      'utf8',
    );
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(documentation).toContain('exatamente uma réplica');
    expect(documentation).toContain('fila serial em memória');
    expect(documentation).toContain('serialização por chat');
    expect(documentation).toContain('recoverStuckUpdates');
    expect(compose).toContain('mantenha exatamente uma réplica');
  });
});
