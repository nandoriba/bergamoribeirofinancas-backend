import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AbacatePayWebhookAuthenticationErrorCode =
  | "INVALID_REGISTERED_SECRET"
  | "INVALID_RAW_BODY"
  | "MISSING_QUERY_SECRET"
  | "MALFORMED_QUERY_SECRET"
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "AUTHENTICATION_FAILED";

export class AbacatePayWebhookAuthenticationError extends Error {
  constructor(readonly code: AbacatePayWebhookAuthenticationErrorCode) {
    super("AbacatePay webhook authentication failed.");
    this.name = "AbacatePayWebhookAuthenticationError";
  }
}

export interface AbacatePayWebhookAuthenticationInput {
  /** Exact bytes received over HTTP, before JSON parsing or reserialization. */
  rawBody: unknown;
  /** Value received in the `webhookSecret` query parameter. */
  querySecret: unknown;
  /** Value received in the `X-Webhook-Signature` header. */
  signature: unknown;
  /** Per-webhook secret registered with AbacatePay. */
  registeredSecret: string;
}

const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Authenticates both documented webhook factors without parsing the payload.
 *
 * The same per-webhook secret is deliberately used for the query parameter and
 * HMAC. The contradictory, globally published key from the provider docs is not
 * accepted here.
 */
export function authenticateAbacatePayWebhook(
  input: AbacatePayWebhookAuthenticationInput,
): void {
  if (
    typeof input.registeredSecret !== "string" ||
    input.registeredSecret.length === 0
  ) {
    throw new AbacatePayWebhookAuthenticationError("INVALID_REGISTERED_SECRET");
  }
  if (!Buffer.isBuffer(input.rawBody)) {
    throw new AbacatePayWebhookAuthenticationError("INVALID_RAW_BODY");
  }

  const querySecret = requiredString(
    input.querySecret,
    "MISSING_QUERY_SECRET",
    "MALFORMED_QUERY_SECRET",
  );
  const signature = requiredString(
    input.signature,
    "MISSING_SIGNATURE",
    "MALFORMED_SIGNATURE",
  );
  const signatureBytes = parseCanonicalSha256Signature(signature);

  // Hashing both values first gives timingSafeEqual fixed-size inputs even when
  // the supplied and registered secrets have different lengths.
  const expectedSecretHash = createHash("sha256")
    .update(input.registeredSecret, "utf8")
    .digest();
  const suppliedSecretHash = createHash("sha256")
    .update(querySecret, "utf8")
    .digest();
  const querySecretMatches = timingSafeEqual(
    expectedSecretHash,
    suppliedSecretHash,
  );

  const expectedSignature = createHmac("sha256", input.registeredSecret)
    .update(input.rawBody)
    .digest();
  const signatureMatches = timingSafeEqual(expectedSignature, signatureBytes);

  // Both comparisons are evaluated before the branch so a caller cannot learn
  // which validly-shaped factor was incorrect from this error.
  if (!querySecretMatches || !signatureMatches) {
    throw new AbacatePayWebhookAuthenticationError("AUTHENTICATION_FAILED");
  }
}

function requiredString(
  value: unknown,
  missingCode: AbacatePayWebhookAuthenticationErrorCode,
  malformedCode: AbacatePayWebhookAuthenticationErrorCode,
): string {
  if (value === undefined || value === null) {
    throw new AbacatePayWebhookAuthenticationError(missingCode);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new AbacatePayWebhookAuthenticationError(malformedCode);
  }
  return value;
}

function parseCanonicalSha256Signature(signature: string): Buffer {
  if (!SHA256_BASE64_PATTERN.test(signature)) {
    throw new AbacatePayWebhookAuthenticationError("MALFORMED_SIGNATURE");
  }

  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== signature) {
    throw new AbacatePayWebhookAuthenticationError("MALFORMED_SIGNATURE");
  }
  return decoded;
}
