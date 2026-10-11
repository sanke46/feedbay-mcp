#!/usr/bin/env node
/**
 * Streamable HTTP transport: процесс, порт и таймеры.
 *
 * Всё про сессии, ключи и лимиты — в src/http-app.ts.
 */

import { ConfigError, loadApiConfig, loadHttpConfig } from "../config.js";
import { createHttpApp } from "../http-app.js";

const REFRESH_EVERY_MS = 60_000;
const SWEEP_EVERY_MS = 60_000;

async function main(): Promise<void> {
  const api = loadApiConfig();
  const http = loadHttpConfig();
  const server = createHttpApp({ api, http });

  /**
   * Перечитывание по часам, а не только при новом рукопожатии.
   *
   * БЕЗ ЭТОГО ТАЙМЕРА ОДИНОКАЯ ДОЛГОЖИВУЩАЯ СЕССИЯ НЕ УЗНАЁТ НИЧЕГО. Обновление
   * висело на открытии сессии, то есть текст менялся у того, кто подключился
   * следующим, — а единственный подключённый клиент мог сидеть на прежних
   * описаниях сколько угодно. Хуже всего это било по рубильнику: «вернуть все
   * двери к коду одним движением» не работало ровно для той двери, которая
   * сейчас чем-то занята.
   *
   * Таймеры не держат процесс живым: сервер живёт, пока слушает порт.
   */
  setInterval(() => void server.refreshToolText(), REFRESH_EVERY_MS).unref?.();
  setInterval(() => void server.sweepIdle(), SWEEP_EVERY_MS).unref?.();

  server.app.listen(http.port, () => {
    console.log(
      `[feedbay-mcp] listening on :${http.port}/mcp against ${api.apiUrl}; ` +
        `per-request API keys` +
        `${http.publicUrl && http.internalSecret ? `, OAuth as ${http.publicUrl}` : ", OAuth off"}; ` +
        `origins: ${http.allowedOrigins.join(", ")}`,
    );
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`feedbay-mcp: ${error.message}`);
    process.exit(2);
  }
  console.error("feedbay-mcp (http) failed to start:", error);
  process.exit(1);
});
