import type { NestExpressApplication } from "@nestjs/platform-express";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureHttpBodyParsers } from "../http-body-parsers";

interface RawRequest extends Request {
  rawBody?: Buffer;
}

describe("configureHttpBodyParsers", () => {
  let endpoint: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    configureHttpBodyParsers(app as unknown as NestExpressApplication);
    app.post("/payments/webhooks/abacatepay", (request: RawRequest, response) => {
      response.json({
        bodyIsBuffer: Buffer.isBuffer(request.body),
        raw: request.rawBody?.toString("utf8") ?? null,
      });
    });
    app.post("/regular", (request: RawRequest, response) => {
      response.json({
        body: request.body,
        hasRawBody: Buffer.isBuffer(request.rawBody),
      });
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  afterAll(async () => {
    await close?.();
  });

  it("preserva somente os bytes exatos do webhook antes de qualquer parse", async () => {
    const raw = '{ "id": "evt_exact", "nested": {"ok":true} }';
    const response = await fetch(`${endpoint}/payments/webhooks/abacatepay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bodyIsBuffer: true,
      raw,
    });
  });

  it("analisa JSON comum sem manter uma segunda cópia bruta sensível", async () => {
    const response = await fetch(`${endpoint}/regular`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "sensitive-value" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      body: { password: "sensitive-value" },
      hasRawBody: false,
    });
  });
});
