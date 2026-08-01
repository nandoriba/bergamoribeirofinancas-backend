import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AbacatePayWebhookAuthenticationError,
  type AbacatePayWebhookAuthenticationErrorCode,
  type AbacatePayWebhookAuthenticationInput,
  authenticateAbacatePayWebhook,
} from "./webhook-security";

const registeredSecret = "registered-webhook-secret-with-sufficient-entropy";
const rawBody = Buffer.from(
  '{\n  "id": "log_golden", "event": "subscription.completed"\n}\n',
  "utf8",
);

function signatureFor(body: Buffer, secret = registeredSecret): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function validInput(
  overrides: Partial<AbacatePayWebhookAuthenticationInput> = {},
): AbacatePayWebhookAuthenticationInput {
  return {
    rawBody,
    querySecret: registeredSecret,
    signature: signatureFor(rawBody),
    registeredSecret,
    ...overrides,
  };
}

function expectAuthenticationError(
  code: AbacatePayWebhookAuthenticationErrorCode,
  overrides: Partial<AbacatePayWebhookAuthenticationInput>,
): void {
  try {
    authenticateAbacatePayWebhook(validInput(overrides));
    throw new Error("expected authentication error");
  } catch (error) {
    expect(error).toBeInstanceOf(AbacatePayWebhookAuthenticationError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain(registeredSecret);
  }
}

describe("authenticateAbacatePayWebhook", () => {
  it("validates the exact raw bytes with the registered secret", () => {
    expect(() => authenticateAbacatePayWebhook(validInput())).not.toThrow();
  });

  it.each([
    ["one changed byte", Buffer.from(rawBody).fill("X".charCodeAt(0), 3, 4)],
    [
      "equivalent JSON with different whitespace",
      Buffer.from(
        '{"id":"log_golden","event":"subscription.completed"}',
        "utf8",
      ),
    ],
    [
      "one appended whitespace byte",
      Buffer.concat([rawBody, Buffer.from(" ")]),
    ],
  ])(
    "rejects %s when the signature belongs to the golden body",
    (_label, changedBody) => {
      expectAuthenticationError("AUTHENTICATION_FAILED", {
        rawBody: changedBody,
      });
    },
  );

  it("requires the query secret and HMAC to match independently", () => {
    expectAuthenticationError("AUTHENTICATION_FAILED", {
      querySecret: "another-query-secret",
    });
    expectAuthenticationError("AUTHENTICATION_FAILED", {
      signature: signatureFor(rawBody, "another-hmac-secret"),
    });
  });

  it("never accepts a signature made with a different published or fallback key", () => {
    expectAuthenticationError("AUTHENTICATION_FAILED", {
      signature: signatureFor(
        rawBody,
        "provider-public-key-must-not-be-accepted",
      ),
    });
  });

  it.each([
    ["MISSING_QUERY_SECRET", { querySecret: undefined }],
    ["MISSING_QUERY_SECRET", { querySecret: null }],
    ["MALFORMED_QUERY_SECRET", { querySecret: "" }],
    ["MALFORMED_QUERY_SECRET", { querySecret: [registeredSecret] }],
    ["MISSING_SIGNATURE", { signature: undefined }],
    ["MISSING_SIGNATURE", { signature: null }],
    ["MALFORMED_SIGNATURE", { signature: "" }],
    ["MALFORMED_SIGNATURE", { signature: "not-base64%%%" }],
    ["MALFORMED_SIGNATURE", { signature: "YQ==" }],
    [
      "MALFORMED_SIGNATURE",
      { signature: signatureFor(rawBody).replace(/=$/, "") },
    ],
    ["MALFORMED_SIGNATURE", { signature: [signatureFor(rawBody)] }],
  ] as const)(
    "rejects malformed authentication input with %s",
    (code, overrides) => {
      expectAuthenticationError(code, overrides);
    },
  );

  it("rejects an absent registered secret before authenticating", () => {
    expectAuthenticationError("INVALID_REGISTERED_SECRET", {
      registeredSecret: "",
    });
  });

  it("requires a Buffer so HMAC cannot silently use a parsed or reserialized body", () => {
    expectAuthenticationError("INVALID_RAW_BODY", {
      rawBody: '{"id":"log_golden"}' as unknown as Buffer,
    });
  });
});
