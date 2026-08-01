import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, raw, urlencoded } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";

interface RequestWithRawBody {
  rawBody?: Buffer;
}

export function configureHttpBodyParsers(app: NestExpressApplication): void {
  const captureRawBody = (
    request: IncomingMessage,
    _response: ServerResponse,
    buffer: Buffer,
  ) => {
    (request as IncomingMessage & RequestWithRawBody).rawBody =
      Buffer.from(buffer);
  };

  // This parser intentionally runs before JSON parsing. The controller can
  // authenticate the exact bytes and only then deserialize an authenticated
  // payload. Unsupported content types never acquire a raw body.
  app.use(
    "/payments/webhooks/abacatepay",
    raw({ type: "application/json", limit: "256kb", verify: captureRawBody }),
  );
  // Other JSON endpoints do not need a second in-memory copy of credentials or
  // financial payloads. Only the exact webhook route receives `rawBody`.
  app.use(json({ limit: "1mb" }));
  app.use(urlencoded({ extended: true, limit: "1mb" }));
}
