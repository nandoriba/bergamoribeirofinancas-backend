import type { INestApplication } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { configureHttpBodyParsers } from "../../../../shared/http-body-parsers";
import { webhookSafeNestApplicationOptions } from "../../../../shared/nest-application-options";
import { IS_PUBLIC_KEY } from "../../../../shared/public.decorator";
import {
  AbacatePayWebhookApplicationError,
  AbacatePayWebhookApplicationService,
} from "../abacatepay-webhook-application.service";
import { AbacatePayWebhookController } from "../abacatepay-webhook.controller";

const secret = "dev-webhook-secret-with-at-least-32-characters";
const values: Record<string, unknown> = {
  NODE_ENV: "test",
  ABACATEPAY_WEBHOOK_ENABLED: true,
  ABACATEPAY_WEBHOOK_HMAC_MODE: "registered_secret",
  ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED: true,
  ABACATEPAY_DEV_WEBHOOK_SECRET: secret,
};
const application = {
  processAuthenticatedEvent: vi
    .fn()
    .mockResolvedValue({ disposition: "processed" }),
};

describe("AbacatePayWebhookController HTTP", () => {
  let app: INestApplication;
  let endpoint: string;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({
      controllers: [AbacatePayWebhookController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: (key: string) => values[key] },
        },
        {
          provide: AbacatePayWebhookApplicationService,
          useValue: application,
        },
      ],
    }).compile();
    app = testingModule.createNestApplication(
      webhookSafeNestApplicationOptions,
    );
    configureHttpBodyParsers(app as NestExpressApplication);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/payments/webhooks/abacatepay`;
  });

  beforeEach(() => {
    values.ABACATEPAY_WEBHOOK_ENABLED = true;
    values.NODE_ENV = "test";
    application.processAuthenticatedEvent.mockReset().mockResolvedValue({
      disposition: "processed",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("autentica os bytes exatos antes de normalizar e aplicar", async () => {
    const body = JSON.stringify(cancelledEvent());
    const response = await post(body, signature(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      disposition: "processed",
    });
    expect(application.processAuthenticatedEvent).toHaveBeenCalledOnce();
    expect(
      application.processAuthenticatedEvent.mock.calls[0]![0].payloadHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("nega assinatura de outro corpo, inclusive diferença só de whitespace", async () => {
    const signed = JSON.stringify(cancelledEvent());
    const changed = `${signed} `;
    const response = await post(changed, signature(signed));

    expect(response.status).toBe(401);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("autentica antes do parse: JSON malformado com assinatura inválida retorna 401", async () => {
    const response = await post("{", signature("different"));

    expect(response.status).toBe(401);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita JSON malformado autenticado sem tocar no banco", async () => {
    const body = "{";
    const response = await post(body, signature(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "WEBHOOK_INVALID_JSON",
    });
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita UTF-8 inválido mesmo quando os bytes foram autenticados", async () => {
    const body = Buffer.from([0xc3, 0x28]);
    const response = await post(body, signature(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "WEBHOOK_INVALID_JSON",
    });
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita content-type que não produz corpo bruto autenticável", async () => {
    const body = JSON.stringify(cancelledEvent());
    const response = await fetch(
      `${endpoint}?webhookSecret=${encodeURIComponent(secret)}`,
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-webhook-signature": signature(body),
        },
        body,
      },
    );

    expect(response.status).toBe(401);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita webhook maior que o limite antes de aplicar o evento", async () => {
    const body = Buffer.alloc(256 * 1024 + 1, 0x20);
    const response = await post(body, signature(body));

    expect(response.status).toBe(413);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita webhookSecret duplicado em vez de escolher um valor", async () => {
    const body = JSON.stringify(cancelledEvent());
    const encoded = encodeURIComponent(secret);
    const response = await fetch(
      `${endpoint}?webhookSecret=${encoded}&webhookSecret=${encoded}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature(body),
        },
        body,
      },
    );

    expect(response.status).toBe(401);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("rejeita evento do ambiente oposto após autenticação", async () => {
    const body = JSON.stringify(cancelledEvent({ devMode: false }));
    const response = await post(body, signature(body));

    expect(response.status).toBe(422);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("fica invisível quando o rollout do webhook está desligado", async () => {
    values.ABACATEPAY_WEBHOOK_ENABLED = false;
    const body = JSON.stringify(cancelledEvent());
    const response = await post(body, signature(body));

    expect(response.status).toBe(404);
    expect(application.processAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("retorna 503 para configuração interna de retenção e permite retry", async () => {
    application.processAuthenticatedEvent.mockRejectedValueOnce(
      new AbacatePayWebhookApplicationError("RETENTION_CONFIGURATION_INVALID"),
    );
    const body = JSON.stringify(cancelledEvent());
    const response = await post(body, signature(body));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "WEBHOOK_CONFIGURATION_INVALID",
    });
  });

  it("mapeia conflito idempotente autenticado para 409 sem expor detalhes", async () => {
    application.processAuthenticatedEvent.mockRejectedValueOnce(
      new AbacatePayWebhookApplicationError("IDEMPOTENCY_CONFLICT"),
    );
    const body = JSON.stringify(cancelledEvent());
    const response = await post(body, signature(body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "WEBHOOK_IDEMPOTENCY_CONFLICT",
      message: "Evento conflitante.",
    });
  });

  it("é público pelo mecanismo próprio, sem BrowserOrigin, e limitado a 60/min", () => {
    const handler = AbacatePayWebhookController.prototype.receive;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata("THROTTLER:LIMITdefault", handler)).toBe(60);
    expect(Reflect.getMetadata("THROTTLER:TTLdefault", handler)).toBe(60_000);
  });

  function post(body: string | Buffer, hmac: string) {
    return fetch(`${endpoint}?webhookSecret=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": hmac,
      },
      body: typeof body === "string" ? body : Uint8Array.from(body).buffer,
    });
  }
});

function signature(body: string | Buffer): string {
  return createHmac("sha256", secret)
    .update(typeof body === "string" ? Buffer.from(body) : body)
    .digest("base64");
}

function cancelledEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_cancelled_controller_1",
    event: "subscription.cancelled",
    apiVersion: 2,
    devMode: true,
    data: {
      subscription: {
        id: "subs_controller_1",
        amount: 1990,
        currency: "BRL",
        method: "CARD",
        frequency: "MONTHLY",
        status: "CANCELLED",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
        canceledAt: "2026-08-01T12:00:00.000Z",
        cancelPolicy: "NOW",
        cancelledDueTo: "owner_requested",
      },
    },
    ...overrides,
  };
}
