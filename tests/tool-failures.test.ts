/**
 * Как отказ выглядит для чужой модели.
 *
 * Прогон 12.10: design_match_brand с адресом сайта отвечал «сначала прочитай
 * сайт» обычным успешным результатом, и модель могла доложить человеку о
 * сделанном. Отказ, после которого ничего не изменилось, несёт `isError`.
 * Здесь же — `null` от моделей GPT в необязательных полях и «root» вместо
 * `null` для папки: схема без `nullable`, но вызов не падает.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { FeedBayClient } from "../src/client/endpoints.js";
import { ApiError } from "../src/client/http.js";
import type { ToolRuntimeConfig } from "../src/config.js";
import { designTools } from "../src/tools/design.js";
import { questionTools } from "../src/tools/questions.js";
import { registerTools } from "../src/tools/shared.js";
import { surveyTools } from "../src/tools/surveys.js";

type TextBlock = { type: string; text: string };

const config = { readOnly: false, filesystemOwner: "server" } as unknown as ToolRuntimeConfig;

const SURVEY = {
  id: "s-1",
  name: "NPS",
  status: "DRAFT",
  design: {},
  config: { questions: [{ id: "q-1", type: "NPS", title: "Recommend?", required: true, order: 0, config: {} }] },
};

async function connect(client: Partial<FeedBayClient>): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, [...surveyTools, ...questionTools, ...designTools], {
    client: client as FeedBayClient,
    config,
  });
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as TextBlock[]).map((block) => block.text).join("\n");

describe("отказ без изменений помечен isError", () => {
  it("design_match_brand с адресом и без чтеца сайта: «сначала brand_read_site» — ошибка", async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({
      name: "design_match_brand",
      arguments: { surveyId: "s-1", url: "https://brand.example" },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/brand_read_site/);
  });

  it("design_update без полей — ошибка, а не «ничего не изменилось»", async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: "design_update", arguments: { surveyId: "s-1" } });

    expect(result.isError).toBe(true);
  });

  it("question_update с несуществующим id — ошибка", async () => {
    const mcp = await connect({
      getSurvey: async () => SURVEY as never,
      updateSurvey: async () => SURVEY as never,
    });
    const result = await mcp.callTool({
      name: "question_update",
      arguments: { surveyId: "s-1", questionId: "nope", title: "x" },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/question_list/);
  });
});

describe("ошибка API называет поля, которые бэкенд отверг", () => {
  it("details из ответа бэкенда доходят до модели", async () => {
    const mcp = await connect({
      updateSurvey: async () => {
        throw new ApiError("VALIDATION_ERROR", "Validation failed", 400, { name: "must not be blank" });
      },
    });
    const result = await mcp.callTool({ name: "survey_update", arguments: { surveyId: "s-1", name: " " } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Fields: name – must not be blank.");
  });
});

describe("null и «root» вместо nullable в схеме", () => {
  it("null в необязательном поле читается как «не задано», а не валит вызов", async () => {
    let payload: Record<string, unknown> | undefined;
    const mcp = await connect({
      updateSurvey: async (_id: string, body: unknown) => {
        payload = body as Record<string, unknown>;
        return SURVEY as never;
      },
    });
    const result = await mcp.callTool({
      name: "survey_update",
      arguments: { surveyId: "s-1", name: "Renamed", description: null, displayMode: null },
    });

    expect(result.isError).toBeFalsy();
    expect(payload).toEqual({ name: "Renamed" });
  });

  it('survey_move с folderId "root" выносит опрос из папок', async () => {
    let destination: string | null | undefined;
    const mcp = await connect({
      moveSurvey: async (_id: string, folderId: string | null) => {
        destination = folderId;
        return { ...SURVEY, folderId: null, folderName: null } as never;
      },
    });
    const result = await mcp.callTool({ name: "survey_move", arguments: { surveyId: "s-1", folderId: "root" } });

    expect(result.isError).toBeFalsy();
    expect(destination).toBeNull();
  });
});

describe("подтверждение не противоречит описанию", () => {
  it("survey_delete обещает ровно то, что делает: архив с возвратом", async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: "survey_delete", arguments: { surveyId: "s-1" } });

    expect(text(result)).not.toMatch(/irreversible|no undo/i);
    expect(text(result)).toMatch(/unarchive restores it/);
    expect(text(result)).toMatch(/confirm: true/);
  });

  it("survey_delete архивирует, а не удаляет", async () => {
    const actions: string[] = [];
    const mcp = await connect({
      getSurvey: async () => ({ id: "s-1", name: "NPS", status: "PUBLISHED" }),
      surveyAction: async (_id: string, action: string) => {
        actions.push(action);
        return { id: "s-1", name: "NPS", status: "ARCHIVED" };
      },
    });
    const result = await mcp.callTool({ name: "survey_delete", arguments: { surveyId: "s-1", confirm: true } });

    expect(actions).toEqual(["archive"]);
    expect(text(result)).toMatch(/"NPS" is archived/);
  });
});
