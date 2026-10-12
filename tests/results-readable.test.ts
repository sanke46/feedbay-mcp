import { describe, expect, it } from "vitest";

import { readableQuestionStats } from "../src/domain/aggregate.js";
import type { Question } from "../src/types.js";

/**
 * Итоги по вопросам, как их видит модель клиента.
 *
 * Прогон 12.10 на опросе салона: бэкенд прислал заголовки-id, тип `choice`
 * для всего, открытый текст процентами по 9,09 % и никакого NPS — все три
 * модели вызывали question_list и считали индекс руками.
 */

const QUESTIONS: Question[] = [
  { id: "z00f8lt", order: 0, type: "NPS", title: "Порекомендуете?", required: true, config: {} },
  { id: "uwk8c35", order: 1, type: "SINGLE_ANSWER", title: "Какая услуга?", required: true, config: {} },
  { id: "144f6j5", order: 2, type: "LONG_TEXT", title: "Что улучшить?", required: false, config: {} },
] as Question[];

const tally = (values: Record<string, number>) =>
  Object.entries(values).map(([value, count]) => ({ value, count, percentage: 0 }));

const BACKEND_STATS = [
  {
    questionId: "144f6j5",
    questionTitle: "144f6j5",
    questionType: "choice",
    responseCount: 3,
    statistics: { type: "choice", options: tally({ "Громкая музыка": 1, "Дорого": 2 }) },
  },
  {
    questionId: "z00f8lt",
    questionTitle: "z00f8lt",
    questionType: "choice",
    responseCount: 12,
    statistics: { type: "choice", options: tally({ "10": 3, "9": 2, "8": 1, "7": 1, "6": 1, "5": 1, "4": 1, "3": 1, "2": 1 }) },
  },
  {
    questionId: "uwk8c35",
    questionTitle: "uwk8c35",
    questionType: "choice",
    responseCount: 12,
    statistics: { type: "choice", options: tally({ Стрижка: 4, Маникюр: 3 }) },
  },
];

describe("readableQuestionStats", () => {
  const rows = readableQuestionStats(BACKEND_STATS, QUESTIONS) as Array<Record<string, unknown>>;

  it("заголовки и типы — из опроса, порядок — как в опросе", () => {
    expect(rows.map((row) => [row.title, row.type])).toEqual([
      ["Порекомендуете?", "NPS"],
      ["Какая услуга?", "SINGLE_ANSWER"],
      ["Что улучшить?", "LONG_TEXT"],
    ]);
  });

  it("NPS посчитан: 5 промоутеров и 5 критиков из 12 — ноль", () => {
    expect(rows[0]!.nps).toEqual({ score: 0, promoters: 5, passives: 2, detractors: 5 });
    expect(rows[0]!.average).toBeCloseTo(6.92, 2);
  });

  it("открытый текст — ответами, а не процентами", () => {
    expect(rows[2]!.answers).toEqual(["Громкая музыка", "Дорого", "Дорого"]);
    expect(rows[2]).not.toHaveProperty("options");
  });

  it("выбор остаётся подсчётом вариантов", () => {
    expect(rows[1]!.options).toEqual(tally({ Стрижка: 4, Маникюр: 3 }));
  });
});
