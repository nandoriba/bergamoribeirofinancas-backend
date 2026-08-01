import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Google OAuth deployment contract', () => {
  it('does not log the callback query containing code and state at the reverse proxy', () => {
    const nginx = readFileSync(resolve(process.cwd(), 'deploy/nginx-financas.conf'), 'utf8');
    const callbackLocation = nginx.match(/location = \/auth\/google\/callback \{([\s\S]*?)\n    \}/)?.[1];

    expect(callbackLocation).toContain('access_log off;');
    expect(callbackLocation).toContain('error_log /dev/null crit;');
    expect(callbackLocation).not.toContain('$request_uri');
  });
});
