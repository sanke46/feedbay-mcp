#!/usr/bin/env node
/**
 * stdio transport — how local MCP clients (Claude Code, Claude Desktop, Cursor)
 * launch this server.
 *
 * stdout carries the protocol, so every diagnostic goes to stderr. A stray
 * console.log here corrupts the JSON-RPC stream and the client just sees the
 * server die.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeApiKey } from "../client/api-key.js";
import { ToolTextSource } from "../client/tool-text.js";
import { ConfigError, loadConfig, type FeedBayConfig } from "../config.js";
import { createServer, tokenSourceFor } from "../server.js";

/**
 * Дверь у человека на его машине.
 *
 * На старте даём тексту доехать, но не больше трёх секунд: дольше — и хост
 * решит, что сервер не поднялся. Дальше перечитываем раз в десять минут; если
 * ревизия сменилась, `updateToolText` шлёт живому клиенту `tools/list_changed`.
 */
const STARTUP_BUDGET_MS = 3_000;
const REFRESH_EVERY_MS = 10 * 60 * 1000;

/**
 * Права берутся из самого ключа, как у HTTP-транспорта.
 *
 * Прежде stdio знал только флаг FEEDBAY_MCP_READONLY, и человек с ключом «только
 * для чтения» видел все изменяющие инструменты: модель выбирала
 * `survey_create`, бэкенд отвечал 403, ход был потрачен впустую. Флаг остаётся
 * и может только сузить права, но не расширить их.
 *
 * Не достучались до бэкенда — стартуем как есть: бэкенд всё равно не даст
 * ключу лишнего, а сервер, который не поднялся из-за нашей сети, хуже
 * сервера с лишними кнопками. Отозванный ключ тоже не повод падать: ошибка
 * доедет до модели на первом вызове вместе с подсказкой, где взять новый, —
 * человек увидит её в разговоре, а не в логе хоста.
 */
async function withKeyPermissions(config: FeedBayConfig): Promise<FeedBayConfig> {
  if (config.credentials.kind !== "apiKey") return config;
  try {
    const identity = await describeApiKey(config.apiUrl, config.credentials.apiKey, STARTUP_BUDGET_MS);
    return { ...config, readOnly: config.readOnly || identity.readOnly };
  } catch (error) {
    console.error(`feedbay-mcp: could not check the API key's permissions: ${(error as Error).message}`);
    return config;
  }
}

async function main(): Promise<void> {
  const loaded = loadConfig();
  const tokens = tokenSourceFor(loaded.credentials, loaded.apiUrl, loaded.requestTimeoutMs);

  /**
   * ЭТА ДВЕРЬ НЕ ИМЕЕТ ПРАВА УПАСТЬ ИЗ-ЗА НАС.
   *
   * Наш эндпоинт настроек лежит — чужой Claude Desktop обязан стартовать, и
   * стартовать он будет на описаниях из кода: они уже здесь, в этом же пакете.
   * Поэтому `ToolTextSource` не бросает вовсе, а жалоба — ровно одна строка в
   * stderr. `process.exit` тут не появляется намеренно: код 2 занят
   * `ConfigError`, и превращать «не прочитали настройку» в «сервер не
   * настроен» значит соврать человеку о причине.
   */
  const toolText = new ToolTextSource({
    apiUrl: loaded.apiUrl,
    token: () => tokens.getAccessToken(),
    ttlMs: REFRESH_EVERY_MS,
    timeoutMs: STARTUP_BUDGET_MS,
    warn: (message) => console.error(`feedbay-mcp: ${message}`),
  });

  const [config, catalogue] = await Promise.all([withKeyPermissions(loaded), toolText.get(STARTUP_BUDGET_MS)]);
  const { server, toolCount, updateToolText } = createServer(config, tokens, catalogue);

  await server.connect(new StdioServerTransport());
  console.error(
    `feedbay-mcp ready on stdio – ${toolCount} tools against ${config.apiUrl}` +
      ` via ${config.credentials.kind === "apiKey" ? "API key" : "service account"}` +
      `${config.readOnly ? " (read-only mode)" : ""}` +
      `${toolText.revision === null ? "" : `, tool text revision ${toolText.revision}`}`,
  );

  // Таймер не держит процесс живым: сервер живёт, пока открыт stdio, и
  // «сервер не выключается, потому что раз в десять минут проверяет настройку»
  // было бы поломкой, а не фичей.
  const timer = setInterval(() => {
    void toolText.refresh().then(() => updateToolText(toolText.current()));
  }, REFRESH_EVERY_MS);
  timer.unref?.();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`feedbay-mcp: ${error.message}`);
    process.exit(2);
  }
  console.error("feedbay-mcp failed to start:", error);
  process.exit(1);
});
