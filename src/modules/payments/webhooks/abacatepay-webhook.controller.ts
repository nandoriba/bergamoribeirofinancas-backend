import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Query,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { createHash } from "node:crypto";

import { Public } from "../../../shared/public.decorator";
import {
  AbacatePayWebhookApplicationError,
  AbacatePayWebhookApplicationService,
} from "./abacatepay-webhook-application.service";
import {
  AbacatePayWebhookContractError,
  parseAndNormalizeAbacatePayWebhook,
} from "./abacatepay-webhook";
import {
  AbacatePayWebhookAuthenticationError,
  authenticateAbacatePayWebhook,
} from "./webhook-security";

@Controller("payments/webhooks")
export class AbacatePayWebhookController {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AbacatePayWebhookApplicationService)
    private readonly application: AbacatePayWebhookApplicationService,
  ) {}

  @Post("abacatepay")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Query("webhookSecret") querySecret: unknown,
  ) {
    if (this.config.get<boolean>("ABACATEPAY_WEBHOOK_ENABLED") !== true) {
      throw new NotFoundException("Recurso não encontrado.");
    }

    const rawBody = request.rawBody;
    try {
      authenticateAbacatePayWebhook({
        rawBody,
        querySecret,
        signature: request.headers["x-webhook-signature"],
        registeredSecret: this.registeredSecret(),
      });
    } catch (error) {
      if (error instanceof AbacatePayWebhookAuthenticationError) {
        throw new UnauthorizedException({
          code: "WEBHOOK_AUTHENTICATION_FAILED",
          message: "Webhook não autorizado.",
        });
      }
      throw error;
    }
    if (!Buffer.isBuffer(rawBody)) {
      throw new Error("Authenticated webhook raw body invariant failed.");
    }

    let payload: unknown;
    try {
      const text = rawBody.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(rawBody)) {
        throw new Error("Invalid UTF-8.");
      }
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new BadRequestException({
        code: "WEBHOOK_INVALID_JSON",
        message: "Corpo JSON inválido.",
      });
    }

    try {
      const event = parseAndNormalizeAbacatePayWebhook(
        payload,
        this.config.get<string>("NODE_ENV") !== "production",
      );
      const result = await this.application.processAuthenticatedEvent({
        event,
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      });
      return { received: true, disposition: result.disposition };
    } catch (error) {
      if (error instanceof AbacatePayWebhookContractError) {
        throw new UnprocessableEntityException({
          code: "WEBHOOK_CONTRACT_REJECTED",
          message: "Evento incompatível com o contrato esperado.",
        });
      }
      if (error instanceof AbacatePayWebhookApplicationError) {
        if (error.code === "IDEMPOTENCY_CONFLICT") {
          throw new ConflictException({
            code: "WEBHOOK_IDEMPOTENCY_CONFLICT",
            message: "Evento conflitante.",
          });
        }
        if (error.code === "RETENTION_CONFIGURATION_INVALID") {
          throw new ServiceUnavailableException({
            code: "WEBHOOK_CONFIGURATION_INVALID",
            message: "Webhook temporariamente indisponível.",
          });
        }
        throw new UnprocessableEntityException({
          code: "WEBHOOK_APPLICATION_REJECTED",
          message: "Evento rejeitado.",
        });
      }
      throw error;
    }
  }

  private registeredSecret(): string {
    if (
      this.config.get<string>("ABACATEPAY_WEBHOOK_HMAC_MODE") !==
        "registered_secret" ||
      this.config.get<boolean>("ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED") !== true
    ) {
      throw new ServiceUnavailableException("Webhook indisponível.");
    }
    const key =
      this.config.get<string>("NODE_ENV") === "production"
        ? "ABACATEPAY_PROD_WEBHOOK_SECRET"
        : "ABACATEPAY_DEV_WEBHOOK_SECRET";
    const secret = this.config.get<string>(key);
    if (!secret) throw new ServiceUnavailableException("Webhook indisponível.");
    return secret;
  }
}
