import { describe, expect, it } from "vitest";
import {
  buildQuestion,
  configWithQuestions,
  deepMerge,
  patchQuestion,
  readQuestions,
  renumber,
} from "../src/domain/questions.js";
import { canonicalizeQuestionType } from "../src/domain/question-types.js";
import type { Question, Survey } from "../src/types.js";

const survey = (config: Record<string, unknown>): Survey =>
  ({ id: "s1", name: "Test", config }) as unknown as Survey;

describe("deepMerge", () => {
  it("merges nested objects field by field", () => {
    expect(deepMerge({ labels: { left: "Bad", right: "Good" } }, { labels: { right: "Great" } })).toEqual({
      labels: { left: "Bad", right: "Great" },
    });
  });

  it("replaces arrays wholesale — a new option list means exactly that list", () => {
    expect(deepMerge({ options: ["a", "b", "c"] }, { options: ["x"] })).toEqual({ options: ["x"] });
  });

  it("ignores undefined so an omitted argument never erases a stored value", () => {
    expect(deepMerge({ scale: 5 }, { scale: undefined })).toEqual({ scale: 5 });
  });
});

describe("readQuestions", () => {
  it("returns an empty list for a survey that has no questions yet", () => {
    expect(readQuestions(survey({}))).toEqual([]);
    expect(readQuestions(survey({ questions: "not an array" }))).toEqual([]);
  });

  it("repairs rows missing an id or order rather than dropping them", () => {
    const questions = readQuestions(survey({ questions: [{ type: "NPS", title: "How likely?" }] }));
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toMatch(/^[0-9a-z]{7}$/);
    expect(questions[0]?.order).toBe(0);
    expect(questions[0]?.required).toBe(false);
  });
});

describe("buildQuestion", () => {
  it("fills in the type's defaults and title when only a type is given", () => {
    const question = buildQuestion({ type: "single_choice" }, 0);
    expect(question.type).toBe("SINGLE_ANSWER");
    expect(question.title).toBe("Select one option");
    expect(question.config).toEqual({ options: ["Option 1", "Option 2"], allowMultiple: false });
  });

  it("layers the caller's config over the defaults", () => {
    const question = buildQuestion({ type: "NPS", config: { minLabel: "Never" } }, 3);
    expect(question.config).toEqual({ scale: 10, minLabel: "Never" });
    expect(question.order).toBe(3);
  });

  it("never marks a welcome or thank-you screen as required — they collect no answer", () => {
    expect(buildQuestion({ type: "WELCOME", required: true }, 0).required).toBe(false);
    expect(buildQuestion({ type: "THANK_YOU", required: true }, 1).required).toBe(false);
  });

  it("rejects an unknown type instead of storing something that will not render", () => {
    // `SLIDER` раньше был здесь «неизвестным», а словарь импорта честно читает его как шкалу.
    expect(() => buildQuestion({ type: "HOLOGRAM" }, 0)).toThrow(/Unknown question type/);
  });
});

describe("patchQuestion", () => {
  const base: Question = {
    id: "q1",
    type: "RATING_SCALE",
    title: "Rate us",
    required: true,
    order: 0,
    config: { scale: 5, style: "stars" },
  };

  it("merges config without dropping the untouched fields", () => {
    expect(patchQuestion(base, { config: { scale: 7 } }).config).toEqual({ scale: 7, style: "stars" });
  });

  it("keeps the id and the existing title when the patch omits them", () => {
    const patched = patchQuestion(base, { required: false });
    expect(patched.id).toBe("q1");
    expect(patched.title).toBe("Rate us");
    expect(patched.required).toBe(false);
  });

  it("brings in the new type's defaults when the type changes", () => {
    const patched = patchQuestion(base, { type: "single_choice" });
    expect(patched.type).toBe("SINGLE_ANSWER");
    expect(patched.config).toMatchObject({ options: ["Option 1", "Option 2"], scale: 5 });
  });

  // Разметка заголовка живёт в `config.titleRich` парой {html, text} и
  // показывается, только если текст совпадает с `title`. Ассистент про это
  // поле не знает: он правит заголовок и уходит. Респондент увидит верный
  // текст в любом случае — но запись, которая уже никогда не совпадёт,
  // остаётся в базе мусором, который однажды примут за правду.
  it("снимает разметку заголовка, когда правят сам заголовок", () => {
    const rich: Question = {
      ...base,
      config: { ...base.config, titleRich: { html: "<b>Rate us</b>", text: "Rate us" } },
    };
    expect(patchQuestion(rich, { title: "How did we do?" }).config.titleRich).toBeUndefined();
  });

  it("не трогает разметку, если заголовок не правят", () => {
    const rich: Question = {
      ...base,
      config: { ...base.config, titleRich: { html: "<b>Rate us</b>", text: "Rate us" } },
    };
    expect(patchQuestion(rich, { required: false }).config.titleRich)
      .toEqual({ html: "<b>Rate us</b>", text: "Rate us" });
  });

  it("не мешает править заголовок вместе с его разметкой", () => {
    const patched = patchQuestion(base, {
      title: "How did we do?",
      config: { titleRich: { html: "<b>How</b> did we do?", text: "How did we do?" } },
    });
    expect(patched.config.titleRich)
      .toEqual({ html: "<b>How</b> did we do?", text: "How did we do?" });
  });

  it("edits a question whose stored type is a spelling the vocabulary no longer lists", () => {
    const legacy: Question = { ...base, type: "LEGACY_SLIDER" };
    expect(patchQuestion(legacy, { title: "New title" })).toMatchObject({ type: "LEGACY_SLIDER", title: "New title" });
  });
});

describe("writing back", () => {
  it("renumbers order to match position", () => {
    const reordered = renumber([
      { ...({} as Question), id: "b", order: 5 },
      { ...({} as Question), id: "a", order: 2 },
    ]);
    expect(reordered.map((question) => question.order)).toEqual([0, 1]);
  });

  it("preserves everything else in config when replacing the questions", () => {
    const config = configWithQuestions(survey({ templateId: "nps", productName: "Acme", questions: [] }), [
      { ...({} as Question), id: "q1", order: 0 },
    ]);
    expect(config).toMatchObject({ templateId: "nps", productName: "Acme" });
    expect((config.questions as Question[])[0]?.id).toBe("q1");
  });
});

/**
 * Разделители в названии типа.
 *
 * ЭТИ ПРОВЕРКИ ПОЯВИЛИСЬ ИЗ ЖИВОГО ПРОГОНА, И ЭТО ВАЖНО. Схема ответа модели
 * в `/ai/import` просит назвать тип обычными словами и сама приводит примеры
 * «single choice», «long text», «rating scale». Модель отвечала ровно так, а
 * таблица псевдонимов знала только `SINGLE_CHOICE` — и каждый вопрос с
 * вариантами приезжал текстовым полем с предупреждением «тип не
 * поддерживается» про тип, который поддерживается с первого дня.
 *
 * Юнит-тесты этого не видели, потому что брали типы уже в канонической
 * записи — то есть проверяли путь, которым настоящий импорт не ходит.
 */
describe("названия типов с пробелами и косыми", () => {
  it("принимает то, что просит у модели схема импорта", () => {
    expect(canonicalizeQuestionType("single choice")).toBe("SINGLE_ANSWER");
    expect(canonicalizeQuestionType("long text")).toBe("LONG_TEXT");
    expect(canonicalizeQuestionType("rating scale")).toBe("RATING_SCALE");
    expect(canonicalizeQuestionType("yes/no")).toBe("YES_NO");
    expect(canonicalizeQuestionType("Yes / No")).toBe("YES_NO");
  });

  it("каноническая запись продолжает работать", () => {
    expect(canonicalizeQuestionType("SINGLE_ANSWER")).toBe("SINGLE_ANSWER");
    expect(canonicalizeQuestionType("nps")).toBe("NPS");
  });

  // Снисходительность к разделителям — не снисходительность к выдумкам.
  it("незнакомый тип по-прежнему отвергается", () => {
    expect(() => canonicalizeQuestionType("magic slider")).toThrow(/Unknown question type/);
  });
});

describe("config.media", () => {
  const withGallery: Question = {
    id: "q1",
    type: "SINGLE_ANSWER",
    title: "Pick one",
    required: false,
    order: 0,
    config: {
      options: ["A", "B"],
      media: { kind: "image", items: [{ url: "https://x/a.jpg", name: "a.jpg", sizeBytes: 10 }] },
    },
  };

  it("replaces the stored media instead of merging into it", () => {
    const patched = patchQuestion(withGallery, {
      config: { media: { kind: "video", item: { url: "https://x/v.mp4" } } },
    });
    expect(patched.config.media).toEqual({
      kind: "video",
      item: { url: "https://x/v.mp4", name: "", sizeBytes: 0 },
    });
    expect(patched.config.options).toEqual(["A", "B"]);
  });

  it("null removes the media", () => {
    expect(patchQuestion(withGallery, { config: { media: null } }).config).not.toHaveProperty("media");
  });

  it.each([
    ["a bare url", "https://x/a.jpg"],
    ["type instead of kind", { type: "image", url: "https://x/a.jpg" }],
    ["image with url instead of items", { kind: "image", url: "https://x/a.jpg" }],
    ["items as strings", { kind: "image", items: ["https://x/a.jpg"] }],
    ["video with url instead of item", { kind: "video", url: "https://x/v.mp4" }],
  ])("rejects %s with the expected shape in the message", (_name, media) => {
    expect(() => patchQuestion(withGallery, { config: { media } })).toThrow(/config\.media has the wrong shape.*Expected/);
    expect(() => buildQuestion({ type: "SINGLE_ANSWER", config: { media } }, 0)).toThrow(/config\.media/);
  });

  it("leaves a question without a media patch untouched", () => {
    expect(patchQuestion(withGallery, { title: "New" }).config).toEqual(withGallery.config);
  });
});

describe("слова модели вместо канонического типа", () => {
  // Trello c7lL3VJR: `rating` ронял survey_create, и человек видел красную
  // строку ошибки, хотя опрос в итоге создался.
  it.each([
    ["rating", "RATING_SCALE"],
    ["Stars", "RATING_SCALE"],
    ["paragraph", "LONG_TEXT"],
    ["checkboxes", "MULTIPLE_ANSWER"],
    ["yes/no", "YES_NO"],
    ["net promoter score", "NPS"],
  ])("%s → %s, и хранится каноническим", (word, canonical) => {
    expect(buildQuestion({ type: word }, 0).type).toBe(canonical);
    expect(patchQuestion(buildQuestion({ type: "TEXT_ANSWER" }, 0), { type: word }).type).toBe(canonical);
  });

  it("неизвестное слово по-прежнему отказывает со списком типов", () => {
    expect(() => buildQuestion({ type: "hologram" }, 0)).toThrow(/Unknown question type "hologram"/);
  });
});
