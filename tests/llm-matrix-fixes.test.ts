/**
 * Находки матрицы 12.10.2026 (screenshots/mcp-llm-matrix), вторая очередь:
 * что сервер обязан сказать модели сам и что ей не нужно тащить в контекст.
 */

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isRenderableFont, SYSTEM_SERIF_STACK, wantsSerif } from "../src/domain/fonts.js";
import { buildQuestion } from "../src/domain/questions.js";
import { surveyWarnings } from "../src/domain/survey-warnings.js";
import { designTools } from "../src/tools/design.js";
import { metaTools } from "../src/tools/meta.js";
import { responseTools } from "../src/tools/responses.js";
import { surveyTools } from "../src/tools/surveys.js";
import type { ToolDefinition } from "../src/tools/shared.js";
import type { Question } from "../src/types.js";

const tool = (tools: ToolDefinition[], name: string) => tools.find((candidate) => candidate.name === name)!;
const firstLine = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const payload = (result: { content: unknown[] }) => JSON.parse((result.content[1] as { text: string }).text);

const q = (type: string, title: string, config: Record<string, unknown> = {}): Question =>
  ({ id: title, order: 0, type, title, required: false, config }) as Question;

describe("предупреждения об опросе", () => {
  it("CSAT со звёздами и широкая матрица — без предупреждений: ссылка рисует их как надо", () => {
    // Ложное предупреждение в прогоне «после» заставило модели менять CSAT
    // на шкалу и терять метрику; с 12.10 ссылка рисует стиль CSAT, а
    // матрица на узком экране перестраивается в строки.
    const columns = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, value: i }));
    expect(surveyWarnings([q("CSAT", "Satisfied?", { style: "stars" }), q("MATRIX", "Rate", { columns })])).toEqual([]);
  });

  it("больше пяти вопросов, без учёта экранов", () => {
    const five = [q("WELCOME", "Hi"), ...Array.from({ length: 5 }, (_, i) => q("TEXT_ANSWER", `Q${i}`)), q("THANK_YOU", "Bye")];
    expect(surveyWarnings(five)).toEqual([]);
    expect(surveyWarnings([...five, q("TEXT_ANSWER", "Q6")]).join(" ")).toMatch(/^6 questions/);
  });


  it("русский текст без языка опроса — совет поставить locale ru; с ним — тишина", () => {
    expect(surveyWarnings([q("TEXT_ANSWER", "Что улучшить?")]).join(" ")).toMatch(/locale "ru"/);
    expect(surveyWarnings([q("TEXT_ANSWER", "Что улучшить?")], "ru")).toEqual([]);
    expect(surveyWarnings([q("TEXT_ANSWER", "What should we improve?")])).toEqual([]);
  });

  it("французский и испанский текст — совет поставить es/de/fr/pt, пока язык en или не задан", () => {
    for (const text of ["Qu'est-ce qu'on améliore ?", "¿Qué podemos mejorar?"]) {
      const line = surveyWarnings([q("TEXT_ANSWER", text)]).join(" ");
      expect(line).toMatch(/locale "es", "de", "fr" or "pt"/);
      expect(surveyWarnings([q("TEXT_ANSWER", text)], "en").join(" ")).toMatch(/"fr" or "pt"/);
      expect(surveyWarnings([q("TEXT_ANSWER", text)], text.startsWith("¿") ? "es" : "fr")).toEqual([]);
    }
  });

  it("язык вне словаря (китайский) — кнопки останутся английскими, совет тот же", () => {
    expect(surveyWarnings([q("TEXT_ANSWER", "我们该改进什么？")]).join(" ")).toMatch(/Other languages keep English/);
  });

});

describe("экран благодарности без заголовка", () => {
  it("называется своим текстом, а не «New question»", () => {
    expect(buildQuestion({ type: "THANK_YOU", config: { message: "Спасибо за отзыв!" } }, 3).title).toBe(
      "Спасибо за отзыв!",
    );
  });
});

describe("шрифты", () => {
  it("засечки узнаются по имени и не подменяются Inter", () => {
    for (const name of ["serif", "Playfair Display", "Georgia", "PT Serif"]) expect(wantsSerif(name), name).toBe(true);
    for (const name of ["Inter", "Open Sans", "PT Sans"]) expect(wantsSerif(name), name).toBe(false);
  });

  it("рендерер рисует свои 8 шрифтов и стеки с общим запасным", () => {
    expect(isRenderableFont("Inter")).toBe(true);
    expect(isRenderableFont(SYSTEM_SERIF_STACK)).toBe(true);
    expect(isRenderableFont("Comic Sans MS")).toBe(false);
  });

  it("design_match_brand с просьбой о засечках ставит системный serif и говорит об этом", async () => {
    let saved: Record<string, unknown> = {};
    const result = await tool(designTools, "design_match_brand").handler(
      { surveyId: "s-1", brandColor: "#7A1FA2", fontFamily: "serif" },
      {
        client: {
          getSurvey: async () => ({ id: "s-1", name: "NPS", design: {} }),
          updateSurvey: async (_id: string, body: { design: Record<string, unknown> }) => {
            saved = body.design;
            return { id: "s-1", name: "NPS", design: body.design };
          },
        },
        config: {},
      } as never,
    );
    expect(saved.fontFamily).toBe(SYSTEM_SERIF_STACK);
    expect(firstLine(result)).toMatch(/no serif web font/);
  });
});

describe("контраст и шрифт в design_update", () => {
  it("ответ несёт contrastReport и предупреждает о шрифте, которого нет", async () => {
    const result = await tool(designTools, "design_update").handler(
      { surveyId: "s-1", fontFamily: "Comic Sans MS", buttonColor: "#FFFF00", buttonTextColor: "#FFFFFF" },
      {
        client: {
          getSurvey: async () => ({ id: "s-1", name: "NPS", design: {} }),
          updateSurvey: async (_id: string, body: { design: Record<string, unknown> }) => ({
            id: "s-1",
            name: "NPS",
            design: body.design,
          }),
        },
      } as never,
    );
    const body = payload(result);
    expect(body.contrastReport.find((entry: { pair: string }) => entry.pair === "button label on button")).toMatchObject({
      target: 3,
      passesAA: false,
    });
    expect(firstLine(result)).toMatch(/Comic Sans MS" is not one of FeedBay's fonts/);
    expect(firstLine(result)).toMatch(/button label on button .* below the 3:1 target/);
  });
});

describe("выгрузка на хостинге не пишет файлов на сервере", () => {
  it("CSV приходит в ответе, на диске сервера ничего", async () => {
    const downloadDir = await mkdtemp(join(tmpdir(), "feedbay-export-"));
    const result = await tool(responseTools, "responses_export").handler(
      { surveyId: "s-1" },
      {
        client: {
          getSurvey: async () => ({ id: "s-1", name: "NPS", responseCount: 1 }),
          exportResponses: async () => ({ bytes: new TextEncoder().encode("a,b\n1,2\n"), contentType: "text/csv" }),
        },
        config: { filesystemOwner: "server", downloadDir },
      } as never,
    );
    expect(firstLine(result)).toMatch(/hosted server keeps no copy/);
    expect((result.content[1] as { text: string }).text).toContain("a,b");
    expect(await readdir(downloadDir)).toEqual([]);
  });
});

describe("лишнее не уходит в контекст модели", () => {
  it("каталог типов по умолчанию — компактный, полный — по запросу", async () => {
    const handler = tool(metaTools, "feedbay_question_types").handler;
    const compact = payload(await handler({}, {} as never));
    expect(compact.types[0].configFields).toEqual(expect.any(Array));
    const full = payload(await handler({ types: ["matrix"] }, {} as never));
    expect(full.types).toHaveLength(1);
    expect(full.types[0].configFields.columns).toMatch(/rating options/);
  });

  it("feedbay_templates с templateId отдаёт шаблон целиком", async () => {
    const result = await tool(metaTools, "feedbay_templates").handler({ templateId: "nps" }, {
      client: { getTemplate: async (id: string) => ({ id, name: "NPS", questions: [{ title: "Recommend?" }] }) },
    } as never);
    expect(payload(result).questions).toHaveLength(1);
  });

  it("survey_list без дизайна каждого опроса", async () => {
    const result = await tool(surveyTools, "survey_list").handler({}, {
      client: {
        listSurveys: async () => ({
          content: [{ id: "s-1", publicId: "p", name: "NPS", status: "DRAFT", design: { themes: {} } }],
          totalElements: 1,
          totalPages: 1,
          number: 0,
        }),
      },
    } as never);
    expect(JSON.stringify(payload(result))).not.toContain("themes");
  });

  it("response_list без IP и user agent, с заголовками вопросов", async () => {
    const result = await tool(responseTools, "response_list").handler({ surveyId: "s-1" }, {
      client: {
        getSurvey: async () => ({ id: "s-1", config: { questions: [{ id: "q1", type: "NPS", title: "Recommend?", order: 0 }] } }),
        listResponses: async () => ({
          content: [{ id: "r1", answers: { q1: 9 }, ipAddress: "46.17.98.27", userAgent: "UA", completed: true }],
          totalElements: 1,
          totalPages: 1,
          number: 0,
        }),
      },
    } as never);
    const body = payload(result);
    expect(JSON.stringify(body)).not.toMatch(/46\.17\.98\.27|userAgent/);
    expect(body.questions).toEqual({ q1: "Recommend?" });
  });
});

describe("язык опроса при создании", () => {
  async function created(args: Record<string, unknown>): Promise<{ design: Record<string, unknown>; line: string }> {
    let design: Record<string, unknown> = {};
    const result = await tool(surveyTools, "survey_create").handler(
      { name: "S", ...args },
      {
        client: {
          createSurvey: async (body: { design?: Record<string, unknown> }) => {
            design = body.design ?? {};
            return { id: "s-1", name: "S", status: "DRAFT", design };
          },
        },
      } as never,
    );
    return { design, line: firstLine(result) };
  }

  it("русские вопросы без locale — русские кнопки сами, и об этом сказано", async () => {
    const { design, line } = await created({ questions: [{ type: "LONG_TEXT", title: "Что улучшить?" }] });
    expect(design.locale).toBe("ru");
    expect(line).toMatch(/locale ru/);
    expect(line).not.toMatch(/Warnings/);
  });

  it("survey_create принимает новые коды языков", async () => {
    for (const locale of ["es", "de", "fr", "pt"]) {
      const { design } = await created({ locale, questions: [{ type: "LONG_TEXT", title: "Hola" }] });
      expect(design.locale).toBe(locale);
    }
  });
  it("схемы survey_create и design_update принимают es/de/fr/pt и отвергают чужое", () => {
    for (const [tools, name] of [[surveyTools, "survey_create"], [designTools, "design_update"]] as const) {
      const locale = (tool(tools, name).inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>).locale!;
      for (const code of ["en", "ru", "es", "de", "fr", "pt"]) expect(locale.safeParse(code).success, `${name} ${code}`).toBe(true);
      expect(locale.safeParse("it").success, name).toBe(false);
    }
  });

  it("названный locale не перебивается", async () => {
    const { design } = await created({ locale: "en", questions: [{ type: "LONG_TEXT", title: "Что улучшить?" }] });
    expect(design.locale).toBe("en");
  });

  it("английские вопросы — без locale, как было", async () => {
    const { design } = await created({ questions: [{ type: "LONG_TEXT", title: "What should we improve?" }] });
    expect(design.locale).toBeUndefined();
  });
});
