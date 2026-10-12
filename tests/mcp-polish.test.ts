/**
 * Остаток матрицы 12.10.2026 (PR-D): тариф, опечатки в типах, тёмная тема,
 * разрез оценок по ответу, предупреждения только там, где что-то меняют.
 */

import { describe, expect, it } from "vitest";

import { buildSegments } from "../src/domain/aggregate.js";
import { canonicalizeQuestionType, suggestQuestionTypes } from "../src/domain/question-types.js";
import { activeTheme, applyDesignChanges } from "../src/domain/themes.js";
import { designTools } from "../src/tools/design.js";
import { metaTools } from "../src/tools/meta.js";
import { questionTools } from "../src/tools/questions.js";
import { responseTools } from "../src/tools/responses.js";
import { surveyTools } from "../src/tools/surveys.js";
import type { ToolDefinition } from "../src/tools/shared.js";
import type { Question, SurveyResponseItem } from "../src/types.js";

const tool = (tools: ToolDefinition[], name: string) => tools.find((candidate) => candidate.name === name)!;
const firstLine = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const payload = (result: { content: unknown[] }) => JSON.parse((result.content[1] as { text: string }).text);
const q = (id: string, type: string, title: string): Question =>
  ({ id, order: 0, type, title, required: false, config: {} }) as Question;
const response = (answers: Record<string, unknown>) => ({ id: "r", answers, completed: true }) as SurveyResponseItem;

describe("feedbay_whoami", () => {
  it("называет тариф словами", async () => {
    const result = await tool(metaTools, "feedbay_whoami").handler({}, {
      client: {
        getProfile: async () => ({ email: "a@b.c", fullName: "A" }),
        getResponseLimit: async () => ({ used: 3, total: 1000, remaining: 997, resetDate: null, canPublish: true, plan: "Core" }),
      },
      config: { readOnly: false },
    } as never);
    expect(firstLine(result)).toMatch(/Plan: Core\./);
    expect(payload(result).plan).toBe("Core");
  });

  it("Free с правом публикации не выглядит противоречием", async () => {
    const result = await tool(metaTools, "feedbay_whoami").handler({}, {
      client: {
        getProfile: async () => ({ email: "a@b.c", fullName: "A" }),
        getResponseLimit: async () => ({ used: 3, total: 500, remaining: 497, resetDate: null, canPublish: true, plan: "Free" }),
      },
      config: { readOnly: false },
    } as never);
    expect(firstLine(result)).toMatch(/Plan: Free, with publishing granted to this account\. .*This account can publish\./);
  });
});

describe("типы вопросов", () => {
  it("опечатка получает «did you mean», а не список из 25 типов", () => {
    expect(suggestQuestionTypes("MATRX")).toContain("MATRIX");
    expect(() => canonicalizeQuestionType("SINGLE_ANSWR")).toThrow(/Did you mean SINGLE_ANSWER/);
  });

  it("каталог узнаёт те же слова, что принимает survey_create", async () => {
    const result = await tool(metaTools, "feedbay_question_types").handler({ types: ["rating", "text", "MATRX"] }, {} as never);
    expect(payload(result).types.map((spec: { type: string }) => spec.type)).toEqual(
      expect.arrayContaining(["RATING_SCALE", "TEXT_ANSWER"]),
    );
    expect(firstLine(result)).toMatch(/MATRX \(did you mean MATRIX\?\)/);
    expect(firstLine(result)).toMatch(/Read rating as RATING_SCALE, text as TEXT_ANSWER\./);
    expect(payload(result).readAs).toEqual({ rating: "RATING_SCALE", text: "TEXT_ANSWER" });
    expect(payload(result).allTypes).toEqual(expect.arrayContaining(["WELCOME – Welcome screen", "THANK_YOU – Thank-you screen"]));
    expect(firstLine(result)).toMatch(/WELCOME and THANK_YOU screens/);
  });
});

describe("design_update и две темы", () => {
  const light = { backgroundColor: "#FFFFFF", buttonColor: "#7A1FA2", questionColor: "#111111" };

  it("тёмный фон переключает тему, а светлая палитра человека откладывается", () => {
    const edit = applyDesignChanges(light, { backgroundColor: "#101014", questionColor: "#F5F5F5" });
    expect(edit).toMatchObject({ shown: "dark", replaced: "light" });
    expect(edit.design.themes?.light).toMatchObject({ buttonColor: "#7A1FA2", backgroundColor: "#FFFFFF" });
  });

  it("сохранённая копия темы на экране не устаревает", () => {
    const withCopy = { ...light, themes: { light: { ...light, buttonColor: "#000000" } } };
    const edit = applyDesignChanges(withCopy, { buttonColor: "#7A1FA2" }, "light");
    expect(edit.design.themes?.light?.buttonColor).toBe("#7A1FA2");
    expect(applyDesignChanges(light, { buttonColor: "#123456" }).design.themes).toBeUndefined();
  });

  it("theme: dark правит тёмную тему, не трогая экран", () => {
    const edit = applyDesignChanges(light, { buttonColor: "#FFD400", fontFamily: "Inter" }, "dark");
    expect(activeTheme(edit.design)).toBe("light");
    expect(edit.design.buttonColor).toBe("#7A1FA2");
    expect(edit.design.fontFamily).toBe("Inter");
    expect(edit.design.themes?.dark?.buttonColor).toBe("#FFD400");
    expect(edit.design.themes?.dark?.backgroundColor).toBeTruthy();
  });

  it("ответ инструмента говорит, какая тема изменилась", async () => {
    let saved: Record<string, unknown> = {};
    const result = await tool(designTools, "design_update").handler({ surveyId: "s-1", theme: "dark", buttonColor: "#FFD400" }, {
      client: {
        getSurvey: async () => ({ id: "s-1", name: "NPS", design: light }),
        updateSurvey: async (_id: string, body: { design: Record<string, unknown> }) => {
          saved = body.design;
          return { id: "s-1", name: "NPS", design: body.design };
        },
      },
    } as never);
    expect(firstLine(result)).toMatch(/Saved to the dark theme; the survey still shows the light one/);
    expect((saved.themes as { dark: { buttonColor: string } }).dark.buttonColor).toBe("#FFD400");
  });
});

describe("results_breakdown с segmentBy", () => {
  const questions = [q("branch", "SINGLE_ANSWER", "Филиал"), q("nps", "NPS", "Порекомендуете?"), q("csat", "CSAT", "Довольны?")];
  const responses = [
    response({ branch: "Центр", nps: 10, csat: 5 }),
    response({ branch: "Центр", nps: 9, csat: 4 }),
    response({ branch: "Север", nps: 3, csat: 2 }),
    response({ nps: 8 }),
  ];

  it("NPS и средние по каждому ответу", () => {
    const result = buildSegments(responses, questions, questions[0]!);
    const centre = result.segments.find((segment) => segment.value === "Центр")!;
    expect(centre.responses).toBe(2);
    expect(centre.metrics.find((metric) => metric.questionId === "nps")).toMatchObject({ nps: 100, average: 9.5, promoters: 2, passives: 0, detractors: 0 });
    expect(result.segments.find((segment) => segment.value === "Север")!.metrics[0]!.nps).toBe(-100);
    expect(result.unanswered).toBe(1);
  });

  it("мультивыбор попадает в каждую из своих групп", () => {
    const multi = q("tags", "MULTIPLE_ANSWER", "Что понравилось");
    const result = buildSegments([response({ tags: ["Кофе", "Сервис"], nps: 10 })], [multi, questions[1]!], multi);
    expect(result.segments.map((segment) => segment.value).sort()).toEqual(["Кофе", "Сервис"]);
  });

  it("неизвестный вопрос — понятная ошибка, а не пустой разрез", async () => {
    const result = await tool(responseTools, "results_breakdown").handler({ surveyId: "s-1", segmentBy: "nope" }, {
      client: { getSurvey: async () => ({ id: "s-1", name: "NPS", config: { questions } }) },
    } as never);
    expect(result.isError).toBe(true);
    expect(firstLine(result)).toMatch(/question_list/);
  });
});

describe("предупреждения на чтении — только в данных", () => {
  const survey = { id: "s-1", name: "Анкета", status: "DRAFT", design: {}, config: { questions: [q("q1", "TEXT_ANSWER", "Что улучшить?")] } };

  it("survey_get и question_list не повторяют их в первой строке", async () => {
    for (const [tools, name] of [[surveyTools, "survey_get"], [questionTools, "question_list"]] as const) {
      const result = await tool(tools, name).handler({ surveyId: "s-1" }, { client: { getSurvey: async () => survey } } as never);
      expect(firstLine(result), name).not.toMatch(/Warnings/);
      expect(JSON.stringify(payload(result).warnings), name).toMatch(/locale/);
    }
  });
});

describe("instructions", () => {
  it("вопрос — не повод создавать опрос (прогон на английском, S1: Haiku завёл черновик «проверить»)", async () => {
    const { INSTRUCTIONS } = await import("../src/server.js");
    expect(INSTRUCTIONS).toMatch(/Asked a question, answer it: never create a survey to find something out/);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });
});

describe("question_add без позиции", () => {
  async function addTo(existing: Question[], type: string): Promise<string[]> {
    let saved: Question[] = [];
    await tool(questionTools, "question_add").handler({ surveyId: "s-1", type, title: "New" }, {
      client: {
        getSurvey: async () => ({ id: "s-1", name: "S", design: {}, config: { questions: existing } }),
        updateSurvey: async (_id: string, body: { config: { questions: Question[] } }) => {
          saved = body.config.questions;
          return { id: "s-1", name: "S", design: {}, config: body.config };
        },
      },
    } as never);
    return saved.map((question) => question.type);
  }

  it("встаёт перед экраном благодарности, а не после него", async () => {
    expect(await addTo([q("a", "NPS", "Recommend?"), q("t", "THANK_YOU", "Thanks")], "CSAT")).toEqual([
      "NPS",
      "CSAT",
      "THANK_YOU",
    ]);
  });

  it("без экрана благодарности — в конец, сам экран — тоже в конец", async () => {
    expect(await addTo([q("a", "NPS", "Recommend?")], "CSAT")).toEqual(["NPS", "CSAT"]);
    expect(await addTo([q("a", "NPS", "Recommend?")], "THANK_YOU")).toEqual(["NPS", "THANK_YOU"]);
  });
});
