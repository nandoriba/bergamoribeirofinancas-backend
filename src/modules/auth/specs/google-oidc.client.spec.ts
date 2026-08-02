import type { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleOidcClient, GoogleOidcProtocolError } from '../google-oidc.client';

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CLIENT_ID = 'client.apps.googleusercontent.com';

const discovery = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: TOKEN_URL,
  jwks_uri: JWKS_URL,
  id_token_signing_alg_values_supported: ['RS256'],
};

function createClient(enabled = true) {
  const values: Record<string, unknown> = {
    GOOGLE_OAUTH_ENABLED: enabled,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8180/auth/google/callback',
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
    getOrThrow: vi.fn((key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  return new GoogleOidcClient(config);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function signingKey(kid = 'key-1') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function idToken(
  privateKey: KeyLike,
  overrides: Record<string, unknown> = {},
  kid = 'key-1',
  registered: { issuer?: string; audience?: string | string[]; subject?: string | null } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
  const token = new SignJWT({
    email: 'person@example.com',
    email_verified: true,
    nonce: 'expected-nonce',
    name: 'Person Name',
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(registered.issuer ?? 'https://accounts.google.com')
    .setAudience(registered.audience ?? CLIENT_ID);
  const subject = registered.subject === undefined ? 'google-subject' : registered.subject;
  if (subject !== null) token.setSubject(subject);
  return token.sign(privateKey);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleOidcClient', () => {
  it('builds a server-side authorization code URL with exact scopes, online access and PKCE S256', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(discovery));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient();

    const result = await client.createAuthorizationUrl({
      state: 'state-value',
      nonce: 'nonce-value',
      codeChallenge: 'pkce-challenge',
    });
    const url = new URL(result);

    expect(fetchMock).toHaveBeenCalledWith(DISCOVERY_URL, expect.any(Object));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:8180/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state: 'state-value',
      nonce: 'nonce-value',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('access_token')).toBe(false);
  });

  it('exchanges the code only at the backend and verifies a signed ID token through the official JWKS', async () => {
    const { privateKey, publicJwk } = await signingKey();
    const signedToken = await idToken(privateKey);
    let tokenRequestBody = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DISCOVERY_URL) return jsonResponse(discovery);
      if (url === TOKEN_URL) {
        tokenRequestBody = String(init?.body);
        return jsonResponse({ id_token: signedToken, access_token: 'discarded-access-token' });
      }
      if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const identity = await createClient().exchangeCode({ code: 'authorization-code', codeVerifier: 'verifier' });

    expect(identity).toEqual({
      subject: 'google-subject',
      email: 'person@example.com',
      name: 'Person Name',
      nonce: 'expected-nonce',
    });
    const form = new URLSearchParams(tokenRequestBody);
    expect(Object.fromEntries(form)).toEqual({
      code: 'authorization-code',
      client_id: CLIENT_ID,
      client_secret: 'client-secret',
      redirect_uri: 'http://127.0.0.1:8180/auth/google/callback',
      grant_type: 'authorization_code',
      code_verifier: 'verifier',
    });
    const tokenCall = fetchMock.mock.calls.find(([input]) => String(input) === TOKEN_URL);
    expect(tokenCall?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
  });

  it.each([
    ['unverified email', { email_verified: false }],
    ['missing nonce', { nonce: undefined }],
    ['wrong authorized party', { azp: 'another-client' }],
  ])('fails closed for %s', async (_label, overrides) => {
    const { privateKey, publicJwk } = await signingKey();
    const signedToken = await idToken(privateKey, overrides);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === DISCOVERY_URL) return jsonResponse(discovery);
        if (url === TOKEN_URL) return jsonResponse({ id_token: signedToken });
        if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
        return jsonResponse({}, 404);
      }),
    );

    await expect(createClient().exchangeCode({ code: 'code', codeVerifier: 'verifier' })).rejects.toBeInstanceOf(
      GoogleOidcProtocolError,
    );
  });

  it.each([
    ['wrong issuer', {}, { issuer: 'https://attacker.example' }],
    ['wrong audience', {}, { audience: 'another-client' }],
    ['missing subject', {}, { subject: null }],
    ['multiple audiences without azp', {}, { audience: [CLIENT_ID, 'another-client'] }],
    ['invalid email', { email: 'not-an-email' }, {}],
    ['expired token', { iat: Math.floor(Date.now() / 1_000) - 300, exp: Math.floor(Date.now() / 1_000) - 60 }, {}],
    ['stale issued-at', { iat: Math.floor(Date.now() / 1_000) - 1_200, exp: Math.floor(Date.now() / 1_000) + 300 }, {}],
    ['future issued-at', { iat: Math.floor(Date.now() / 1_000) + 120, exp: Math.floor(Date.now() / 1_000) + 300 }, {}],
  ])('rejects a token with %s', async (_label, overrides, registered) => {
    const { privateKey, publicJwk } = await signingKey();
    const signedToken = await idToken(privateKey, overrides, 'key-1', registered);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === DISCOVERY_URL) return jsonResponse(discovery);
        if (url === TOKEN_URL) return jsonResponse({ id_token: signedToken });
        if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
        return jsonResponse({}, 404);
      }),
    );

    await expect(createClient().exchangeCode({ code: 'code', codeVerifier: 'verifier' })).rejects.toBeInstanceOf(
      GoogleOidcProtocolError,
    );
  });

  it('rejects a token whose signature does not match the advertised key', async () => {
    const signing = await signingKey('shared-kid');
    const advertised = await signingKey('shared-kid');
    const signedToken = await idToken(signing.privateKey, {}, 'shared-kid');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === DISCOVERY_URL) return jsonResponse(discovery);
        if (url === TOKEN_URL) return jsonResponse({ id_token: signedToken });
        if (url === JWKS_URL) return jsonResponse({ keys: [advertised.publicJwk] });
        return jsonResponse({}, 404);
      }),
    );

    await expect(createClient().exchangeCode({ code: 'code', codeVerifier: 'verifier' })).rejects.toBeInstanceOf(
      GoogleOidcProtocolError,
    );
  });

  it('refreshes JWKS once when Google rotates to an unknown key id', async () => {
    const active = await signingKey('active-key');
    const stale = await signingKey('stale-key');
    const signedToken = await idToken(active.privateKey, {}, 'active-key');
    let jwksRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === DISCOVERY_URL) return jsonResponse(discovery);
        if (url === TOKEN_URL) return jsonResponse({ id_token: signedToken });
        if (url === JWKS_URL) {
          jwksRequests += 1;
          return jsonResponse({ keys: [jwksRequests === 1 ? stale.publicJwk : active.publicJwk] });
        }
        return jsonResponse({}, 404);
      }),
    );

    await expect(createClient().exchangeCode({ code: 'code', codeVerifier: 'verifier' })).resolves.toMatchObject({
      subject: 'google-subject',
    });
    expect(jwksRequests).toBe(2);
  });

  it('rejects discovery endpoints outside Google and never follows them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...discovery,
        token_endpoint: 'https://attacker.example/token',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient().createAuthorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge' }),
    ).rejects.toBeInstanceOf(GoogleOidcProtocolError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is unavailable without the feature flag and performs no network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient(false).createAuthorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
