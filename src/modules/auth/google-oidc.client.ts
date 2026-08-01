import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { z } from 'zod';

const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const CACHE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5_000;

const discoverySchema = z.object({
  issuer: z.literal('https://accounts.google.com'),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  id_token_signing_alg_values_supported: z.array(z.string()).min(1),
});

const tokenResponseSchema = z
  .object({
    id_token: z.string().min(1).max(20_000),
  })
  .passthrough();

const jwksSchema = z.object({
  keys: z
    .array(
      z
        .object({
          kty: z.string().min(1),
          kid: z.string().min(1).optional(),
        })
        .passthrough(),
    )
    .min(1),
});

type GoogleDiscovery = z.infer<typeof discoverySchema>;

export interface GoogleAuthorizationInput {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface GoogleTokenExchangeInput {
  code: string;
  codeVerifier: string;
}

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  name?: string;
  nonce: string;
}

export class GoogleOidcProtocolError extends Error {
  constructor() {
    super('Falha ao concluir a autenticação com o Google.');
    this.name = 'GoogleOidcProtocolError';
  }
}

@Injectable()
export class GoogleOidcClient {
  private cachedDiscovery?: { value: GoogleDiscovery; expiresAt: number };
  private cachedJwks?: { uri: string; value: JSONWebKeySet; expiresAt: number };

  constructor(private readonly config: ConfigService) {}

  isEnabled() {
    return this.config.get<boolean>('GOOGLE_OAUTH_ENABLED') ?? false;
  }

  async createAuthorizationUrl(input: GoogleAuthorizationInput): Promise<string> {
    this.assertEnabled();

    try {
      const discovery = await this.getDiscovery();
      const url = new URL(discovery.authorization_endpoint);
      url.searchParams.set('client_id', this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'));
      url.searchParams.set('redirect_uri', this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('access_type', 'online');
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new GoogleOidcProtocolError();
    }
  }

  async exchangeCode(input: GoogleTokenExchangeInput): Promise<VerifiedGoogleIdentity> {
    this.assertEnabled();

    try {
      const discovery = await this.getDiscovery();
      const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: input.code,
          client_id: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
          client_secret: this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
          redirect_uri: this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
          grant_type: 'authorization_code',
          code_verifier: input.codeVerifier,
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      if (!response.ok) throw new GoogleOidcProtocolError();
      const tokenResponse = tokenResponseSchema.parse(await response.json());
      const payload = await this.verifyIdToken(tokenResponse.id_token, discovery);
      return this.normalizeClaims(payload);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new GoogleOidcProtocolError();
    }
  }

  private async verifyIdToken(idToken: string, discovery: GoogleDiscovery): Promise<JWTPayload> {
    const verify = async (forceRefresh: boolean) => {
      const jwks = await this.getJwks(discovery.jwks_uri, forceRefresh);
      return jwtVerify(idToken, createLocalJWKSet(jwks), {
        algorithms: ['RS256'],
        issuer: [discovery.issuer, 'accounts.google.com'],
        audience: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
        clockTolerance: 10,
        maxTokenAge: '10m',
      });
    };

    try {
      return (await verify(false)).payload;
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      return (await verify(true)).payload;
    }
  }

  private normalizeClaims(payload: JWTPayload): VerifiedGoogleIdentity {
    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const emailResult = z.string().trim().email().max(320).safeParse(payload.email);

    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      !emailResult.success ||
      payload.email_verified !== true ||
      typeof payload.nonce !== 'string' ||
      payload.nonce.length === 0 ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    ) {
      throw new GoogleOidcProtocolError();
    }

    return {
      subject: payload.sub,
      email: emailResult.data.toLowerCase(),
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 160) : undefined,
      nonce: payload.nonce,
    };
  }

  private async getDiscovery(): Promise<GoogleDiscovery> {
    const now = Date.now();
    if (this.cachedDiscovery && this.cachedDiscovery.expiresAt > now) return this.cachedDiscovery.value;

    const response = await fetch(GOOGLE_DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new GoogleOidcProtocolError();

    const discovery = discoverySchema.parse(await response.json());
    this.assertOfficialEndpoint(discovery.authorization_endpoint, 'accounts.google.com');
    this.assertOfficialEndpoint(discovery.token_endpoint, 'oauth2.googleapis.com');
    this.assertOfficialEndpoint(discovery.jwks_uri, 'www.googleapis.com');
    if (!discovery.id_token_signing_alg_values_supported.includes('RS256')) {
      throw new GoogleOidcProtocolError();
    }

    this.cachedDiscovery = { value: discovery, expiresAt: now + CACHE_TTL_MS };
    return discovery;
  }

  private async getJwks(uri: string, forceRefresh: boolean): Promise<JSONWebKeySet> {
    const now = Date.now();
    if (!forceRefresh && this.cachedJwks?.uri === uri && this.cachedJwks.expiresAt > now) {
      return this.cachedJwks.value;
    }

    const response = await fetch(uri, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new GoogleOidcProtocolError();

    const value = jwksSchema.parse(await response.json()) as unknown as JSONWebKeySet;
    this.cachedJwks = { uri, value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  private assertOfficialEndpoint(value: string, hostname: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password) {
      throw new GoogleOidcProtocolError();
    }
  }

  private assertEnabled() {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('Login com Google indisponível.');
    }
  }
}
