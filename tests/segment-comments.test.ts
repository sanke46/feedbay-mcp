/**
 * Комментарии респондентов в сегментах results_breakdown: попадают в свою
 * группу, ограничены по числу и длине, персональные поля не пропускают.
 */

import { describe, expect, it } from "vitest";

import { buildSegments } from "../src/domain/aggregate.js";
import { responseTools } from "../src/tools/responses.js";
import { TOOLS_RETURNING_FOREIGN_TEXT } from "../src/tools/untrusted.js";
import type { Question, SurveyResponseItem } from "../src/types.js";

const q = (id: string, type: string, title: string): Question =>
  ({ id, order: 0, type, title, required: false, config: {} }) as Question;
const response = (answers: Record<string, unknown>, createdAt?: string) =>
  ({ id: "r", answers, completed: true, ...(createdAt ? { createdAt } : {}) }) as SurveyResponseItem;

const branch = q("branch", "SINGLE_ANSWER", "Филиал");
const nps = q("nps", "NPS", "Порекомендуете?");
const why = q("why", "LONG_TEXT", "Почему?");
const questions = [branch, nps, why];

describe("комментарии в сегментах", () => {
  it("комментарии попадают в свои группы, оценка NPS приложена", () => {
    const result = buildSegments(
      [
        response({ branch: "Центр", nps: 10, why: "Отлично" }),
        response({ branch: "Север", nps: 3, why: "Долго ждали" }),
        response({ branch: "Центр", why: "   " }),
      ],
      questions,
      branch,
    );
    const centre = result.segments.find((segment) => segment.value === "Центр")!;
    const north = result.segments.find((segment) => segment.value === "Север")!;
    expect(centre.comments).toEqual([{ text: "Отлично", score: 10 }]);
    expect(centre.commentsTotal).toBe(1);
    expect(north.comments).toEqual([{ text: "Долго ждали", score: 3 }]);
  });

  it("без вопроса NPS оценки в комментарии нет", () => {
    const result = buildSegments([response({ branch: "Центр", why: "Ок" })], [branch, why], branch);
    expect(result.segments[0]!.comments).toEqual([{ text: "Ок" }]);
  });

  it("мультивыбор раскладывает комментарий по всем группам", () => {
    const tags = q("tags", "MULTIPLE_ANSWER", "Что понравилось");
    const result = buildSegments([response({ tags: ["Кофе", "Сервис"], why: "Всё хорошо" })], [tags, why], tags);
    expect(result.segments).toHaveLength(2);
    for (const segment of result.segments) expect(segment.comments).toEqual([{ text: "Всё хорошо" }]);
  });

  it("не больше 10 на группу, считает все, свежие первыми", () => {
    const many = Array.from({ length: 13 }, (_, index) =>
      response({ branch: "Центр", why: `c${index}` }, `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00Z`),
    );
    const segment = buildSegments(many, questions, branch).segments[0]!;
    expect(segment.comments).toHaveLength(10);
    expect(segment.commentsTotal).toBe(13);
    expect(segment.comments[0]!.text).toBe("c12");
  });

  it("без дат сохраняется порядок ввода", () => {
    const rows = [0, 1, 2].map((index) => response({ branch: "Центр", why: `c${index}` }));
    expect(buildSegments(rows, questions, branch).segments[0]!.comments.map((c) => c.text)).toEqual(["c0", "c1", "c2"]);
  });

  it("текст режется до 300 знаков с многоточием", () => {
    const long = "а".repeat(500);
    const exact = "б".repeat(300);
    const segment = buildSegments(
      [response({ branch: "Центр", why: long }), response({ branch: "Центр", why: exact })],
      questions,
      branch,
    ).segments[0]!;
    expect(segment.comments[0]!.text).toBe(`${"а".repeat(300)}…`);
    expect(segment.comments[1]!.text).toBe(exact);
  });

  it("EMAIL, CONTACT_FORM и DATE не попадают никогда", () => {
    const email = q("email", "EMAIL", "Почта");
    const contact = q("contact", "CONTACT_FORM", "Контакты");
    const date = q("date", "DATE", "Дата визита");
    const segment = buildSegments(
      [
        response({
          branch: "Центр",
          email: "a@b.c",
          contact: { name: "Иван", phone: "+7 900 000-00-00" },
          date: "2026-10-01",
          why: "Только это",
        }),
      ],
      [branch, email, contact, date, why],
      branch,
    ).segments[0]!;
    expect(segment.comments).toEqual([{ text: "Только это" }]);
    expect(JSON.stringify(segment)).not.toMatch(/a@b\.c|Иван|900|2026-10-01/);
  });

  it("текст самого разреза не дублируется в комментариях", () => {
    const text = q("city", "TEXT_ANSWER", "Город");
    const result = buildSegments([response({ city: "Москва", why: "Норм" })], [text, why], text);
    expect(result.segments[0]!.value).toBe("Москва");
    expect(result.segments[0]!.comments).toEqual([{ text: "Норм" }]);
    const alone = buildSegments([response({ city: "Москва" })], [text], text);
    expect(alone.segments[0]!.comments).toEqual([]);
    expect(alone.segments[0]!.commentsTotal).toBe(0);
  });
});

describe("results_breakdown с segmentBy", () => {
  const tool = responseTools.find((candidate) => candidate.name === "results_breakdown")!;
  const client = {
    getSurvey: async () => ({ id: "s-1", name: "NPS", config: { questions } }),
    listResponses: async () => ({
      content: [response({ branch: "Центр", nps: 9, why: "Хорошо" })],
      totalElements: 1,
      last: true,
    }),
  };
  const run = async (args: Record<string, unknown>) => {
    const result = await tool.handler({ surveyId: "s-1", ...args }, { client } as never);
    return JSON.parse((result.content[1] as { text: string }).text) as Record<string, unknown>;
  };

  it("segments идут первым ключом, чтобы обрезка с конца задела посуточные данные", async () => {
    expect(Object.keys(await run({ segmentBy: "branch" }))[0]).toBe("segments");
  });

  it("без segmentBy ключа segments нет", async () => {
    expect(await run({})).not.toHaveProperty("segments");
  });

  it("вывод по-прежнему под забором чужого текста", () => {
    expect(TOOLS_RETURNING_FOREIGN_TEXT.has("results_breakdown")).toBe(true);
  });
});
