/**
 * Удалённый транспорт: сессии, ключи, выселение.
 *
 * Приложение поднимается на случайном порту, клиент — настоящий
 * `StreamableHTTPClientTransport` из SDK. Бэкенд не нужен: проверка ключа
 * подменена, каталог описаний выключен.
 */

import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiKeyIdentity } from "../src/client/api-key.js";
import { ApiError } from "../src/client/http.js";
import { createHttpApp, type HttpApp } from "../src/http-app.js";

const FULL = "fb_live_full_access_key";
const OTHER = "fb_live_someone_else_key";
const READ_ONLY = "fb_live_read_only_key";

const identities: Record<string, ApiKeyIdentity> = {
  [FULL]: { name: "full", keyPrefix: "fb_live_full", readOnly: false },
  [OTHER]: { name: "other", keyPrefix: "fb_live_some", readOnly: false },
  [READ_ONLY]: { name: "ro", keyPrefix: "fb_live_read", readOnly: true },
};

let listening: Server | null = null;
let api: Server | null = null;
const clients: Client[] = [];
/** Ключи, отозванные посреди теста: проверка их больше не пропускает. */
const revoked = new Set<string>();

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of [listening, api]) {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
  listening = null;
  api = null;
  revoked.clear();
});

/** API, который отказывает любому запросу: так выглядит отозванный ключ. */
async function rejectingApi(): Promise<string> {
  api = await new Promise<Server>((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: { code: "INVALID_API_KEY", message: "The API key is revoked." } }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  return `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}

async function start(options: { maxSessionsPerKey?: number; clock?: { now: number }; apiUrl?: string } = {}) {
  const clock = options.clock ?? { now: 1_000_000 };
  const http = createHttpApp({
    api: { apiUrl: options.apiUrl ?? "http://backend.invalid", requestTimeoutMs: 1_000 },
    http: { port: 0, downloadDir: "/tmp", allowedOrigins: ["*"] },
    describeKey: async (apiKey) => {
      const identity = revoked.has(apiKey) ? undefined : identities[apiKey];
      if (!identity) throw new ApiError("INVALID_API_KEY", "The API key is invalid or revoked.", 401);
      return identity;
    },
    toolText: null,
    maxSessionsPerKey: options.maxSessionsPerKey,
    now: () => clock.now,
    log: () => undefined,
  });
  listening = await new Promise<Server>((resolve) => {
    const server = http.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const url = new URL(`http://127.0.0.1:${(listening.address() as AddressInfo).port}/mcp`);
  return { http, url, clock };
}

async function connect(url: URL, apiKey: string): Promise<{ client: Client; sessionId: string }> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, sessionId: String(transport.sessionId) };
}

async function post(url: URL, body: unknown, headers: Record<string, string>): Promise<globalThis.Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const listTools = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };

describe("рукопожатие и ключ", () => {
  it("годный ключ открывает сессию и видит инструменты", async () => {
    const { http, url } = await start();
    const { client } = await connect(url, FULL);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("survey_create");
    expect(http.sessionCount()).toBe(1);
  });

  it("ключ только для чтения не видит изменяющих инструментов", async () => {
    const { url } = await start();
    const { client } = await connect(url, READ_ONLY);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("survey_list");
    expect(names).not.toContain("survey_create");
  });

  it("без ключа и с отозванным ключом — 401 с объяснением", async () => {
    const { url } = await start();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };

    const missing = await post(url, initialize, {});
    expect(missing.status).toBe(401);
    expect(JSON.stringify(await missing.json())).toMatch(/Account → API keys/);

    const revoked = await post(url, initialize, { Authorization: "Bearer fb_live_revoked" });
    expect(revoked.status).toBe(401);
    expect(JSON.stringify(await revoked.json())).toMatch(/invalid or revoked/);
  });

  it("сессия привязана к ключу: чужой ключ с тем же id получает 403", async () => {
    const { url } = await start();
    const { sessionId } = await connect(url, FULL);

    const stolen = await post(url, listTools, { Authorization: `Bearer ${OTHER}`, "mcp-session-id": sessionId });
    expect(stolen.status).toBe(403);
  });

  it("API отказал ключу посреди сессии — следующий запрос сверяет его заново", async () => {
    const { url } = await start({ apiUrl: await rejectingApi() });
    const { client, sessionId } = await connect(url, FULL);

    const failed = await client.callTool({ name: "feedbay_whoami", arguments: {} });
    expect(failed.isError).toBe(true);

    // Ключ жив, отказ был случайным: сессия работает дальше.
    const stillValid = await post(url, listTools, { Authorization: `Bearer ${FULL}`, "mcp-session-id": sessionId });
    expect(stillValid.status).toBe(200);
    await stillValid.body?.cancel();

    await client.callTool({ name: "feedbay_whoami", arguments: {} });
    revoked.add(FULL);
    const afterRevoke = await post(url, listTools, { Authorization: `Bearer ${FULL}`, "mcp-session-id": sessionId });
    expect(afterRevoke.status).toBe(401);
    expect(JSON.stringify(await afterRevoke.json())).toMatch(/invalid or revoked/);
  });
});

describe("незнакомая сессия — 404, чтобы клиент переподключился сам", () => {
  it("POST с id, которого нет (процесс перезапущен деплоем), получает 404, а не 400", async () => {
    const { url } = await start();
    const response = await post(url, listTools, {
      Authorization: `Bearer ${FULL}`,
      "mcp-session-id": "6f1c1d0e-0000-4000-8000-000000000000",
    });
    expect(response.status).toBe(404);
  });

  it("POST без id и без initialize — по-прежнему 400", async () => {
    const { url } = await start();
    const response = await post(url, listTools, { Authorization: `Bearer ${FULL}` });
    expect(response.status).toBe(400);
  });
});

describe("сессии не копятся", () => {
  it("простаивающая дольше получаса закрывается, её id дальше отвечает 404", async () => {
    const { http, url, clock } = await start();
    const { sessionId } = await connect(url, FULL);

    clock.now += 29 * 60_000;
    expect(await http.sweepIdle()).toBe(0);

    clock.now += 2 * 60_000;
    expect(await http.sweepIdle()).toBe(1);
    expect(http.sessionCount()).toBe(0);

    const late = await post(url, listTools, { Authorization: `Bearer ${FULL}`, "mcp-session-id": sessionId });
    expect(late.status).toBe(404);
  });

  it("запрос продлевает жизнь сессии", async () => {
    const { http, url, clock } = await start();
    const { client } = await connect(url, FULL);

    clock.now += 20 * 60_000;
    await client.listTools();
    clock.now += 20 * 60_000;

    expect(await http.sweepIdle()).toBe(0);
  });

  it("лишняя сессия одного ключа вытесняет самую давнюю, чужие не трогает", async () => {
    const { http, url, clock } = await start({ maxSessionsPerKey: 2 });
    const first = await connect(url, FULL);
    clock.now += 1_000;
    await connect(url, FULL);
    clock.now += 1_000;
    await connect(url, OTHER);
    clock.now += 1_000;
    await connect(url, FULL);

    expect(http.sessionCount()).toBe(3);
    const evicted = await post(url, listTools, {
      Authorization: `Bearer ${FULL}`,
      "mcp-session-id": first.sessionId,
    });
    expect(evicted.status).toBe(404);
  });
});

describe("перебор ключей упирается в лимит по IP", () => {
  it("после 60 неудачных рукопожатий за 10 минут — 429, удачные не считаются", async () => {
    const { url } = await start();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };

    await connect(url, FULL);
    await connect(url, FULL);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await post(url, initialize, { Authorization: `Bearer fb_live_guess_${attempt}` });
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("запрос без ключа — не перебор: так клиент OAuth узнаёт, где входить, и с общего IP их много", async () => {
    const { url } = await start();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const response = await post(url, initialize, {});
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses.every((status) => status === 401)).toBe(true);
  });
});
