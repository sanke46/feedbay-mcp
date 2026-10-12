/**
 * Вход по OAuth: так подключаются Claude (веб, десктоп, телефон) и ChatGPT.
 *
 * Протокол отвечает SDK MCP; здесь проверяется, что он собран правильно:
 * клиент находит метаданные по 401, регистрируется публичным, уходит на
 * страницу согласия, меняет код на токены через бэкенд — и сессия переживает
 * ежечасную смену токена, не пуская при этом чужой.
 *
 * Бэкенд подменён памятью: его сторона проверяется в OAuthServiceTest.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiKeyIdentity } from "../src/client/api-key.js";
import { ApiError } from "../src/client/http.js";
import { createHttpApp } from "../src/http-app.js";
import type { OAuthBackend } from "../src/oauth/backend.js";

const identities: Record<string, ApiKeyIdentity> = {
  fb_oat_first: { id: "grant-1", kind: "oauth", name: "Claude", keyPrefix: "fb_oat_", readOnly: false },
  fb_oat_rotated: { id: "grant-1", kind: "oauth", name: "Claude", keyPrefix: "fb_oat_", readOnly: false },
  fb_oat_someone_else: { id: "grant-2", kind: "oauth", name: "ChatGPT", keyPrefix: "fb_oat_", readOnly: false },
  // Время — как его отдаёт бэкенд: без пояса.
  fb_oat_hour: {
    id: "grant-1",
    kind: "oauth",
    name: "Claude",
    keyPrefix: "fb_oat_",
    readOnly: false,
    expiresAt: "2026-10-11T20:16:55",
  },
  fb_oat_next_hour: {
    id: "grant-1",
    kind: "oauth",
    name: "Claude",
    keyPrefix: "fb_oat_",
    readOnly: false,
    expiresAt: "2026-10-11T21:20:00",
  },
};

const ISSUED_AT = Date.parse("2026-10-11T19:16:55");
const AFTER_EXPIRY = Date.parse("2026-10-11T20:20:00");

class MemoryBackend {
  clients = new Map<string, OAuthClientInformationFull>();
  authorizations: Array<Record<string, unknown>> = [];
  tokenCalls: Array<Record<string, unknown>> = [];

  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, client);
    return client;
  }

  async startAuthorization(request: Record<string, unknown>) {
    this.authorizations.push(request);
    return "req-42";
  }

  async token(request: Record<string, unknown>) {
    this.tokenCalls.push(request);
    if (request.grantType === "refresh_token") {
      return { accessToken: "fb_oat_next_hour", refreshToken: "fb_ort_2", expiresIn: 3600, scope: "feedbay:read feedbay:write" };
    }
    return { accessToken: "fb_oat_first", refreshToken: "fb_ort_1", expiresIn: 3600, scope: "feedbay:read feedbay:write" };
  }

  async revoke() {}
}

let listening: Server | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await new Promise<void>((resolve) => (listening ? listening.close(() => resolve()) : resolve()));
  listening = null;
});

async function start(clock: { now: number } = { now: ISSUED_AT }) {
  const backend = new MemoryBackend();
  // Публичный адрес совпадает с адресом теста: SDK требует https, кроме localhost.
  const server = await new Promise<Server>((resolve) => {
    const placeholder = createHttpApp({
      api: { apiUrl: "http://backend.invalid", requestTimeoutMs: 1_000 },
      http: { port: 0, downloadDir: "/tmp", allowedOrigins: ["*"] },
      toolText: null,
      oauthBackend: null,
      log: () => undefined,
    }).app.listen(0, "127.0.0.1", () => resolve(placeholder));
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const publicUrl = `http://localhost:${port}`;
  const http = createHttpApp({
    api: { apiUrl: "http://backend.invalid", requestTimeoutMs: 1_000 },
    http: { port, downloadDir: "/tmp", allowedOrigins: ["*"], publicUrl, appUrl: "https://feedbay.test" },
    oauthBackend: backend as unknown as OAuthBackend,
    describeKey: async (token) => {
      const identity = identities[token];
      if (!identity) throw new ApiError("INVALID_TOKEN", "The access token is not valid.", 401);
      return identity;
    },
    toolText: null,
    now: () => clock.now,
    log: () => undefined,
  });
  listening = await new Promise<Server>((resolve) => {
    const s = http.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  return { backend, publicUrl };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const listTools = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };

function post(url: string, body: unknown, headers: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("клиент находит, как войти", () => {
  it("401 без токена указывает на метаданные ресурса", async () => {
    const { publicUrl } = await start();
    const response = await post(`${publicUrl}/mcp`, initialize, {});

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("метаданные ресурса — и по адресу с путём, и в корне", async () => {
    const { publicUrl } = await start();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const metadata = (await (await fetch(`${publicUrl}${path}`)).json()) as Record<string, unknown>;
      expect(metadata.resource).toBe(`${publicUrl}/mcp`);
      expect(metadata.authorization_servers).toEqual([`${publicUrl}/`]);
    }
  });

  it("метаданные сервера авторизации: регистрация, PKCE S256, refresh", async () => {
    const { publicUrl } = await start();
    const metadata = (await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(metadata.registration_endpoint).toBe(`${publicUrl}/register`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.grant_types_supported).toContain("refresh_token");
    expect(metadata.scopes_supported).toEqual(["feedbay:read", "feedbay:write"]);
  });
});

describe("регистрация, согласие, токены", () => {
  async function register(publicUrl: string): Promise<OAuthClientInformationFull> {
    const response = await fetch(`${publicUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as OAuthClientInformationFull;
  }

  it("клиент регистрируется публичным: без секрета, только PKCE", async () => {
    const { publicUrl, backend } = await start();
    const client = await register(publicUrl);

    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(backend.clients.get(client.client_id)?.client_secret).toBeUndefined();
  });

  it("/authorize уводит человека на страницу согласия в дашборде", async () => {
    const { publicUrl, backend } = await start();
    const client = await register(publicUrl);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${publicUrl}/mcp`,
    });

    const response = await fetch(`${publicUrl}/authorize?${query}`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://feedbay.test/connect/authorize?request=req-42");
    expect(backend.authorizations[0]).toMatchObject({ clientId: client.client_id, state: "xyz" });
  });

  it("токен для чужого ресурса не выдаётся", async () => {
    const { publicUrl } = await start();
    const client = await register(publicUrl);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: "https://other.example/mcp",
    });

    const response = await fetch(`${publicUrl}/authorize?${query}`, { redirect: "manual" });
    const location = new URL(String(response.headers.get("location")));
    expect(location.origin).toBe("https://claude.ai");
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });

  it("код меняется на токены в бэкенде, verifier уходит туда же", async () => {
    const { publicUrl, backend } = await start();
    const client = await register(publicUrl);

    const response = await fetch(`${publicUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: "fb_oac_code",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: "fb_oat_first",
      token_type: "Bearer",
      refresh_token: "fb_ort_1",
      expires_in: 3600,
    });
    expect(backend.tokenCalls[0]).toMatchObject({
      grantType: "authorization_code",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
  });
});

describe("сессия OAuth", () => {
  it("переживает смену токена той же учётки и не пускает чужую", async () => {
    const { publicUrl } = await start();
    const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer fb_oat_first" } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const sessionId = String(transport.sessionId);

    const rotated = await post(`${publicUrl}/mcp`, listTools, {
      Authorization: "Bearer fb_oat_rotated",
      "mcp-session-id": sessionId,
    });
    expect(rotated.status).toBe(200);
    await rotated.body?.cancel();

    const foreign = await post(`${publicUrl}/mcp`, listTools, {
      Authorization: "Bearer fb_oat_someone_else",
      "mcp-session-id": sessionId,
    });
    expect(foreign.status).toBe(403);
  });

  it("недействительный токен — 401 с error=invalid_token, чтобы клиент обновил его", async () => {
    const { publicUrl } = await start();
    const response = await post(`${publicUrl}/mcp`, initialize, { Authorization: "Bearer fb_oat_expired" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("истёкший токен в живой сессии — 401 invalid_token, обновлённый продолжает ту же сессию", async () => {
    const clock = { now: ISSUED_AT };
    const { publicUrl } = await start(clock);
    const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer fb_oat_hour" } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    const sessionId = String(transport.sessionId);

    clock.now = AFTER_EXPIRY;
    const stale = await post(`${publicUrl}/mcp`, listTools, {
      Authorization: "Bearer fb_oat_hour",
      "mcp-session-id": sessionId,
    });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const fresh = await post(`${publicUrl}/mcp`, listTools, {
      Authorization: "Bearer fb_oat_next_hour",
      "mcp-session-id": sessionId,
    });
    expect(fresh.status).toBe(200);
    await fresh.body?.cancel();
  });

  it("клиент SDK, как Claude Code, сам обновляет истёкший токен и работает дальше без браузера", async () => {
    const clock = { now: ISSUED_AT };
    const { backend, publicUrl } = await start(clock);
    backend.clients.set("client-1", {
      client_id: "client-1",
      client_id_issued_at: 0,
      redirect_uris: ["http://localhost:5000/callback"],
      token_endpoint_auth_method: "none",
    });

    let saved: OAuthTokens = {
      access_token: "fb_oat_hour",
      token_type: "Bearer",
      refresh_token: "fb_ort_1",
      expires_in: 3600,
    };
    const provider: OAuthClientProvider = {
      redirectUrl: "http://localhost:5000/callback",
      clientMetadata: { redirect_uris: ["http://localhost:5000/callback"], client_name: "test" },
      clientInformation: () => ({ client_id: "client-1" }),
      tokens: () => saved,
      saveTokens: (tokens) => {
        saved = tokens;
      },
      redirectToAuthorization: () => {
        throw new Error("Обновление не должно звать человека в браузер");
      },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "unused",
    };
    // Поток уведомлений (GET) клиент открывает сам после рукопожатия. Часы
    // переводятся, когда он уже открыт: иначе на 401 уйдут два запроса разом.
    let streamOpened!: () => void;
    const opened = new Promise<void>((resolve) => (streamOpened = resolve));
    const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      authProvider: provider,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if ((init?.method ?? "GET") === "GET" && String(input).endsWith("/mcp")) streamOpened();
        return response;
      },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    const sessionId = transport.sessionId;
    await opened;

    clock.now = AFTER_EXPIRY;
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    expect(saved.access_token).toBe("fb_oat_next_hour");
    expect(transport.sessionId).toBe(sessionId);
    expect(backend.tokenCalls).toEqual([
      expect.objectContaining({ grantType: "refresh_token", clientId: "client-1", refreshToken: "fb_ort_1" }),
    ]);
  });

  it("одновременные обновления одним refresh-токеном получают одни и те же токены, бэкенд видит одно", async () => {
    const { backend, publicUrl } = await start();
    backend.clients.set("client-1", {
      client_id: "client-1",
      client_id_issued_at: 0,
      redirect_uris: ["http://localhost:5000/callback"],
      token_endpoint_auth_method: "none",
    });
    const refresh = () =>
      fetch(`${publicUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "client-1",
          refresh_token: "fb_ort_1",
          resource: `${publicUrl}/mcp`,
        }),
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as OAuthTokens }));

    const [first, second] = await Promise.all([refresh(), refresh()]);
    const late = await refresh();

    for (const response of [first, second, late]) {
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe("fb_oat_next_hour");
      expect(response.body.refresh_token).toBe("fb_ort_2");
    }
    expect(backend.tokenCalls).toHaveLength(1);
  });
});
