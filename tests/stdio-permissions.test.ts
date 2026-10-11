/**
 * Скачанный сервер у человека на машине берёт права из ключа.
 *
 * Запускается настоящий bin/stdio.ts дочерним процессом, как его запустил бы
 * Claude Desktop, против маленького поддельного бэкенда на случайном порту.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let backend: Server;
let apiUrl = "";

beforeAll(async () => {
  backend = createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace("Bearer ", "");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/account/api-keys/current") {
      if (key === "fb_live_revoked") {
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, error: { code: "INVALID_API_KEY", message: "Revoked." } }));
        return;
      }
      res.end(JSON.stringify({ success: true, data: { name: "k", keyPrefix: key.slice(0, 12), readOnly: key === "fb_live_ro" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Not here." } }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
  apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

async function toolsFor(apiKey: string, extraEnv: Record<string, string> = {}): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/bin/stdio.ts"],
    cwd: PACKAGE_DIR,
    env: {
      ...(process.env as Record<string, string>),
      FEEDBAY_API_URL: apiUrl,
      FEEDBAY_API_KEY: apiKey,
      FEEDBAY_MCP_READONLY: "",
      NO_PROXY: "*",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("stdio: права из ключа", () => {
  it("ключ только для чтения не видит изменяющих инструментов", async () => {
    const names = await toolsFor("fb_live_ro");
    expect(names).toContain("survey_list");
    expect(names).not.toContain("survey_create");
  }, 20_000);

  it("полный ключ видит всё", async () => {
    expect(await toolsFor("fb_live_full")).toContain("survey_create");
  }, 20_000);

  it("флаг окружения сужает права даже полного ключа", async () => {
    expect(await toolsFor("fb_live_full", { FEEDBAY_MCP_READONLY: "1" })).not.toContain("survey_create");
  }, 20_000);

  it("отозванный ключ не роняет сервер: он стартует, ошибка доедет на первом вызове", async () => {
    expect(await toolsFor("fb_live_revoked")).toContain("feedbay_whoami");
  }, 20_000);
});
