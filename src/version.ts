/**
 * Версия сервера — та же, что в package.json.
 *
 * Её видит клиент в рукопожатии, и по ней человек в issue говорит, что у него
 * стоит. Вписанная руками строка отставала бы от релиза на первом же теге.
 * package.json лежит рядом и в npm-пакете, и в установщике для Claude Desktop.
 */

import { createRequire } from "node:module";

export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
