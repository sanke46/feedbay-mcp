import { describe, expect, it } from "vitest";
import { channelGuidance, isEmailInteractive, EMAIL_DEGRADED_TYPES } from "../src/domain/channels.js";

/**
 * Что ассистент знает про канал опроса.
 *
 * <p>ПОЧЕМУ ЭТО ВАЖНО, А НЕ УКРАШЕНИЕ. Ассистент правит опрос, не видя, где
 * тот живёт. Для ссылки и сайта разницы почти нет, для письма она решающая:
 * в почте нет JavaScript, и матрица, дата, форма контактов и длинный текст
 * превращаются в ссылку «ответить на сайте». Человек, собравший рассылку из
 * матриц, узнавал об этом от подписчиков.
 */
describe("что остаётся кликабельным в письме", () => {
  it.each(["NPS", "CSAT", "CES", "RATING_SCALE", "SMILEY_SCALE", "YES_NO", "THUMB", "SINGLE_ANSWER", "MULTIPLE_ANSWER", "DROPDOWN"])(
    "%s — да",
    (type) => expect(isEmailInteractive(type)).toBe(true),
  );

  it.each(EMAIL_DEGRADED_TYPES)("%s — нет", (type) => {
    expect(isEmailInteractive(type)).toBe(false);
  });

  // Сюда приходят и старые написания из базы, и «обычные слова» от модели.
  it("понимает любое написание, а не только каноническое", () => {
    expect(isEmailInteractive("multiple choice")).toBe(true);
    expect(isEmailInteractive("MULTIPLE_CHOICE")).toBe(true);
    expect(isEmailInteractive("contact form")).toBe(false);
  });

  it("неизвестный тип не считается кликабельным", () => {
    expect(isEmailInteractive("magic slider")).toBe(false);
    expect(isEmailInteractive(undefined)).toBe(false);
  });
});

describe("подсказка про канал", () => {
  it("для письма называет и ограничение, и его причину", () => {
    const text = channelGuidance("EMAIL").join(" ");
    expect(text).toContain("no JavaScript");
    expect(text).toContain("MATRIX");
    // Вторая половина правды: в письмо уезжает только первый вопрос.
    expect(text).toContain("FIRST question");
  });

  it("для сайта говорит про сниппет, без которого ссылка бесполезна", () => {
    expect(channelGuidance("WEBSITE").join(" ")).toContain("survey_install_snippet");
  });

  // Отдельная страница умеет всё; лишний абзац только разбавил бы промпт.
  it("для ссылки молчит", () => {
    expect(channelGuidance("LINK")).toEqual([]);
    expect(channelGuidance(undefined)).toEqual([]);
  });
});
