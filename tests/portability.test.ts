/**
 * То, что уходит клиенту в `tools/list`, должно читаться любой моделью.
 *
 * Claude принимает почти любую JSON Schema, но сервером пользуются и через
 * ChatGPT, Codex, Cursor, Gemini. Их обёртки берут подмножество: Gemini на
 * старом пути отвергает весь запрос из-за одного `$ref` или `type: [..,"null"]`,
 * Cursor отдаёт агенту только первые ~40 инструментов, а каждый символ списка —
 * токены модели клиента в каждом разговоре. Проверяется собранный сервер через
 * настоящий MCP-клиент: ровно то, что видит чужая модель.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { ApiKeyTokenSource } from "../src/client/auth.js";
import type { ToolRuntimeConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Cursor отдаёт агенту не больше ~40 инструментов на все серверы сразу. */
const MAX_TOOLS = 40;
/**
 * Весь `tools/list` в символах JSON: ~3,5 символа на токен модели клиента.
 * Порог — по факту, чтобы список не рос незаметно; ниже его тянут не описания
 * (в них правила, ради которых модель и не ошибается), а лишние инструменты.
 */
const MAX_TOOL_LIST_CHARS = 41_000;
/** Claude Code показывает модели около 2 тыс. символов инструкций, остальное обрезает. */
const MAX_INSTRUCTIONS_CHARS = 2_000;

/** Свободные объекты, ключи которых перечислены в описании, а не в схеме. */
const FREE_FORM_ALLOWED = [/\.config$/, /^survey_create\.design$/];

/** Инструменты, которые ходят по чужим адресам: сайт бренда и ссылки на медиа. */
const OPEN_WORLD = new Set(["brand_read_site", "survey_create", "question_add", "question_update", "questions_replace"]);

let tools: Tool[] = [];
let instructions = "";

beforeAll(async () => {
  const config = {
    readOnly: false,
    filesystemOwner: "server",
    apiUrl: "http://localhost:0",
    requestTimeoutMs: 1000,
    downloadDir: "/tmp",
  } as unknown as ToolRuntimeConfig;
  const { server } = createServer(config, new ApiKeyTokenSource("fb_live_test"));
  const client = new Client({ name: "portability", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools;
  instructions = client.getInstructions() ?? "";
});

type Node = Record<string, unknown>;

/** Каждый узел схемы с путём `tool.prop.prop`. */
function* walk(node: unknown, path: string): Generator<[string, Node]> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Node;
  yield [path, schema];
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  for (const [key, child] of Object.entries(properties)) yield* walk(child, `${path}.${key}`);
  if (schema.items) yield* walk(schema.items, `${path}[]`);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const [index, child] of ((schema[key] ?? []) as unknown[]).entries()) yield* walk(child, `${path}|${key}${index}`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    yield* walk(schema.additionalProperties, `${path}{}`);
  }
}

function offenders(test: (schema: Node, path: string) => boolean): string[] {
  return tools.flatMap((tool) => [...walk(tool.inputSchema, tool.name)].filter(([path, schema]) => test(schema, path)).map(([path]) => path));
}

describe("схемы входа — подмножество, которое понимает любой провайдер", () => {
  it("нет $ref, $defs и definitions: Gemini их не принимает, а описание рядом с $ref теряется", () => {
    expect(offenders((schema) => "$ref" in schema || "$defs" in schema || "definitions" in schema)).toEqual([]);
  });

  it("нет type-массивов и anyOf с null: необязательное поле — это optional, а не nullable", () => {
    const nullable = (schema: Node) =>
      Array.isArray(schema.type) ||
      ((schema.anyOf ?? schema.oneOf) as Node[] | undefined)?.some((branch) => branch.type === "null") === true;
    expect(offenders(nullable)).toEqual([]);
  });

  it("свободные объекты — только там, где ключи перечислены в описании", () => {
    const freeForm = (schema: Node, path: string) =>
      schema.type === "object" &&
      !schema.properties &&
      !FREE_FORM_ALLOWED.some((allowed) => allowed.test(path));
    expect(offenders(freeForm)).toEqual([]);
  });

  it("имена инструментов подходят под правила OpenAI и Gemini", () => {
    expect(tools.map((tool) => tool.name).filter((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))).toEqual([]);
  });
});

describe("цена списка для модели клиента", () => {
  it(`инструментов не больше ${MAX_TOOLS}`, () => {
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it(`весь tools/list не больше ${MAX_TOOL_LIST_CHARS} символов`, () => {
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(MAX_TOOL_LIST_CHARS);
  });

  it(`instructions не больше ${MAX_INSTRUCTIONS_CHARS} символов`, () => {
    expect(instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });
});

describe("аннотации говорят клиенту правду", () => {
  it("всё, что требует confirm, помечено как разрушающее", () => {
    const needsConfirm = tools.filter((tool) => "confirm" in ((tool.inputSchema.properties ?? {}) as object));
    expect(needsConfirm.filter((tool) => tool.annotations?.destructiveHint !== true).map((tool) => tool.name)).toEqual(
      [],
    );
  });

  it("openWorldHint только у тех, кто ходит по чужим адресам", () => {
    const wrong = tools
      .filter((tool) => (tool.annotations?.openWorldHint === true) !== OPEN_WORLD.has(tool.name))
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });
});
