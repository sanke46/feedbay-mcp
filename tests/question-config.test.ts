import { describe, expect, it } from "vitest";
import { normalizeContactFields, normalizeQuestionConfig, QuestionConfigError } from "../src/domain/question-config.js";
import { buildQuestion, patchQuestion } from "../src/domain/questions.js";

/**
 * Опрос тестировщика (Trello, 25.09): модель прислала опции объектами, поля
 * контакт-формы без id и выдуманный стиль звёзд. Всё это сохранялось как есть.
 */

describe("options", () => {
  it("objects become the strings the editor shows (EQuV17XO: [object Object])", () => {
    const config = normalizeQuestionConfig("MULTIPLE_ANSWER", {
      options: [{ label: "Карта" }, { value: "PayPal" }, "Банковский перевод", { text: "Другое" }],
    });
    expect(config.options).toEqual(["Карта", "PayPal", "Банковский перевод", "Другое"]);
  });

  it("a question added by the assistant is stored with string options", () => {
    const question = buildQuestion(
      { type: "checkboxes", title: "Какие способы оплаты?", config: { options: [{ label: "Карта" }, { label: "PayPal" }] } },
      0,
    );
    expect(question.config.options).toEqual(["Карта", "PayPal"]);
  });
});

describe("contact fields (c7QICB6H)", () => {
  it("fields without id get unique ids, so answers no longer share the key 'undefined'", () => {
    const fields = normalizeContactFields([
      { type: "text", label: "Имя", required: true },
      { type: "email", label: "Email", required: true },
      { type: "text", label: "Телефон", required: true },
    ]);
    const ids = fields.map((f) => f.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(fields[1].id).toBe("email");
  });

  it("template strings become full fields", () => {
    const fields = normalizeContactFields(["name", "email", "phone"]);
    expect(fields.map((f) => [f.id, f.type])).toEqual([
      ["name", "text"],
      ["email", "email"],
      ["phone", "phone"],
    ]);
  });

  it("existing ids are kept, duplicates are made unique", () => {
    const fields = normalizeContactFields([
      { id: "name", type: "text", label: "A" },
      { id: "name", type: "text", label: "B" },
    ]);
    expect(fields.map((f) => f.id)).toEqual(["name", "name_2"]);
  });

  it("editing an old broken contact question repairs it", () => {
    const question = buildQuestion({ type: "CONTACT_FORM", title: "Контакты" }, 0);
    const broken = { ...question, config: { fields: [{ type: "text", label: "Имя" }, { type: "email", label: "Email" }] } };
    const edited = patchQuestion(broken, { title: "Оставьте контакты" });
    expect((edited.config.fields as { id: string }[]).map((f) => f.id)).toEqual(["field_1", "email"]);
  });
});

describe("rating icons (9IxzzjNP)", () => {
  it("an invented style is refused with the list and the recipe for filled stars", () => {
    expect(() => buildQuestion({ type: "RATING_SCALE", config: { style: "filled_stars" } }, 0)).toThrow(
      QuestionConfigError,
    );
    try {
      buildQuestion({ type: "RATING_SCALE", config: { style: "filled_stars" } }, 0);
    } catch (error) {
      expect((error as Error).message).toContain('style "stars" with iconVariant "filled"');
    }
  });

  it("filled stars are accepted", () => {
    const question = buildQuestion({ type: "RATING_SCALE", config: { style: "stars", iconVariant: "filled" } }, 0);
    expect(question.config).toMatchObject({ style: "stars", iconVariant: "filled" });
  });

  it("a legacy bad style does not block an unrelated edit", () => {
    const question = buildQuestion({ type: "RATING_SCALE" }, 0);
    const legacy = { ...question, config: { ...question.config, style: "filled_stars" } };
    expect(() => patchQuestion(legacy, { title: "New title" })).not.toThrow();
  });
});
