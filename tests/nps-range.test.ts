import { describe, expect, it } from "vitest";

import { findQuestionType } from "../src/domain/question-types.js";
import { surveyWarnings } from "../src/domain/survey-warnings.js";
import type { Question } from "../src/types.js";

/**
 * NPS в FeedBay рисуется 1–10 (решение по продукту 24.07.2026, Rating.tsx и
 * question-type-mapper.ts). Каталог называл его «standard 0-10», и модели
 * писали «Del 0 al 10» над кнопками 1–10 (короткий прогон матрицы 12.10.2026).
 */

const nps = (title: string): Question => ({ id: "n", order: 0, type: "NPS", title, required: true, config: {} }) as Question;

describe("NPS: шкала 1–10", () => {
  it("каталог говорит 1-10 и не обещает ноль", () => {
    const description = findQuestionType("NPS")!.description;
    expect(description).toMatch(/1-10/);
    expect(description).not.toMatch(/0-10/);
  });

  it("текст «от 0 до 10» на любом из языков опроса получает предупреждение", () => {
    for (const title of [
      "Del 0 al 10, ¿qué tan probable es que nos recomiendes?",
      "On a scale of 0 to 10, how likely are you to recommend us?",
      "Auf einer Skala von 0 bis 10 – wie wahrscheinlich…",
      "De 0 à 10, quelle est la probabilité…",
      "De 0 a 10, qual a probabilidade…",
      "От 0 до 10 – насколько вероятно…",
      "How likely (0–10) are you to recommend us?",
    ]) {
      expect(surveyWarnings([nps(title)], "es").join(" "), title).toMatch(/shows 1-10 with no 0/);
    }
  });

  it("правильный или безымянный диапазон, а также 0 в других числах — без предупреждения", () => {
    for (const title of [
      "How likely are you to recommend us?",
      "On a scale of 1 to 10, how likely…",
      "We served 100 to 1000 guests – would you recommend us?",
      "Rate us 10/10?",
    ]) {
      expect(surveyWarnings([nps(title)]).join(" "), title).not.toMatch(/no 0/);
    }
  });
});
