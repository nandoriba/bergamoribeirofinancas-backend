import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('contrato de deploy dos convites', () => {
  it('não registra o bearer token do path e impede seu envio como referrer', () => {
    const nginx = readFileSync(resolve(process.cwd(), 'deploy/nginx-financas.conf'), 'utf8');
    const inviteLocations = [
      ...nginx.matchAll(/location \^~ \/convite\/ \{([\s\S]*?)\n    \}/g),
    ].map((match) => match[1]);

    expect(inviteLocations).toHaveLength(2);
    for (const location of inviteLocations) {
      expect(location).toContain('access_log off;');
      expect(location).toContain('error_log /dev/null crit;');
    }
    expect(inviteLocations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('return 301 https://bergamoribeirofinancas.com.br$request_uri;'),
        expect.stringContaining('proxy_pass http://127.0.0.1:8181;'),
      ]),
    );

    const webServer = nginx.match(
      /server \{[\s\S]*?server_name bergamoribeirofinancas\.com\.br;([\s\S]*?)\n\}/,
    )?.[1];
    expect(webServer).toContain('add_header Referrer-Policy "no-referrer" always;');
  });
});
