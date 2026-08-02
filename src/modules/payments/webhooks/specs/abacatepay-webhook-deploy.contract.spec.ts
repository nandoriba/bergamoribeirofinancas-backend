import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("contrato de deploy do webhook AbacatePay", () => {
  it("aceita somente a rota canônica sem registrar secrets de variantes", () => {
    const nginx = readFileSync(
      resolve(process.cwd(), "deploy/nginx-financas.conf"),
      "utf8",
    );
    const canonicalLocations = [
      ...nginx.matchAll(
        /location = \/payments\/webhooks\/abacatepay \{([\s\S]*?)\n    \}/g,
      ),
    ].map((match) => match[1]);
    const rejectedVariants = [
      ...nginx.matchAll(
        /location \^~ \/payments\/webhooks\/abacatepay\/ \{([\s\S]*?)\n    \}/g,
      ),
    ].map((match) => match[1]);

    expect(canonicalLocations).toHaveLength(2);
    expect(rejectedVariants).toHaveLength(2);
    for (const location of [...canonicalLocations, ...rejectedVariants]) {
      expect(location).toContain("access_log off;");
      expect(location).toContain("error_log /dev/null crit;");
    }

    expect(canonicalLocations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("return 404;"),
        expect.stringContaining("proxy_pass http://127.0.0.1:8180;"),
      ]),
    );
    for (const location of rejectedVariants) {
      expect(location).toContain("return 404;");
      expect(location).not.toContain("proxy_pass");
      expect(location).not.toContain("$request_uri");
    }
  });
});
