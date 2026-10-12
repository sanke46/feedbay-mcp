import { describe, expect, it } from "vitest";

import { shareTools } from "../src/tools/share.js";

/**
 * Код для сайта выполняется в браузере посетителя, поэтому адрес API в нём —
 * публичный. Хостинг говорит с бэкендом по docker-сети, и до 12.10 этот
 * внутренний адрес уходил прямо в сниппет.
 */

const snippetTool = shareTools.find((tool) => tool.name === "survey_install_snippet")!;

async function snippetFor(apiUrl: string): Promise<string> {
  const result = await snippetTool.handler({ surveyId: "s-1" }, {
    client: {
      getSurvey: async () => ({ id: "s-1", name: "NPS", status: "PUBLISHED", displayMode: "POPUP_CENTER", targeting: null }),
      getShareInfo: async () => ({ publicId: "AbCd1234", publicUrl: "https://feedbay.io/s/AbCd1234" }),
    },
    config: { apiUrl, readOnly: false },
  } as never);
  return JSON.parse((result.content[1] as { text: string }).text).snippet as string;
}

describe("survey_install_snippet: адрес API в коде для сайта", () => {
  it("внутренний адрес хостинга заменяется публичным адресом ссылки", async () => {
    const snippet = await snippetFor("http://backend:8080");

    expect(snippet).toContain("apiUrl: 'https://feedbay.io/api/v1'");
    expect(snippet).not.toContain("backend:8080");
  });

  it("публичный адрес API остаётся как есть", async () => {
    expect(await snippetFor("https://api.example.com")).toContain("apiUrl: 'https://api.example.com/api/v1'");
  });

  it("localhost при разработке остаётся", async () => {
    expect(await snippetFor("http://localhost:8080")).toContain("apiUrl: 'http://localhost:8080/api/v1'");
  });
});
