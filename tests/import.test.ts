import { describe, expect, it } from "vitest";

import { importedSurveySchema, sanitizeImportedText, IMPORT_LIMITS } from "../src/domain/import/schema.js";
import { normalizeImported } from "../src/domain/import/normalize.js";
import { readTable } from "../src/domain/import/tabular.js";

const parse = (input: unknown) => importedSurveySchema.parse(input);

describe("imported document schema", () => {
  it("strips markup out of what the model returns", () => {
    expect(sanitizeImportedText("<b>How</b> likely  are you?")).toBe("How likely are you?");
  });

  // Перенос строки — разделитель слов, а не мусор: вырезав его молча, мы
  // склеили бы «цена устраивает» в одно слово.
  it("turns line breaks into spaces instead of dropping them", () => {
    expect(sanitizeImportedText("Was the price\nfair?")).toBe("Was the price fair?");
  });

  it("caps a title that came back far too long", () => {
    const parsed = parse({ questions: [{ title: "x".repeat(400), type: "TEXT_ANSWER" }] });
    expect(parsed.questions[0].title).toHaveLength(IMPORT_LIMITS.title);
  });

  it("refuses a question with more options than anyone would answer", () => {
    const options = Array.from({ length: IMPORT_LIMITS.options + 1 }, (_, i) => `option ${i}`);
    expect(() => parse({ questions: [{ title: "Pick one", type: "SINGLE_ANSWER", options }] })).toThrow();
  });
});

describe("normalising an imported document", () => {
  it("produces questions shaped exactly like hand-made ones", () => {
    const result = normalizeImported(
      parse({
        title: "Delivery feedback",
        questions: [
          { title: "How was the delivery?", type: "RATING_SCALE", scale: 5 },
          { title: "What went wrong?", type: "LONG_TEXT", required: true },
        ],
      }),
    );

    expect(result.title).toBe("Delivery feedback");
    expect(result.questions.map((q) => q.order)).toEqual([0, 1]);
    expect(result.questions.every((q) => q.id.length > 0)).toBe(true);
    expect(result.questions[0].config.scale).toBe(5);
    expect(result.questions[1].required).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  // Один неизвестный тип не должен стоить человеку всего импорта.
  //
  // Раньше примером стоял «SLIDER» — с появлением `vocabulary.ts` он честно
  // распознаётся как шкала, и тест сломался ростом возможностей, а не
  // регрессом. Пример заменён на слово, которое ничего не значит.
  //
  // «Неизвестный» тут не то же, что в `contract.test.ts`: там `SLIDER` — по-
  // прежнему верный отрицательный пример, потому что ХРАНИТЬ его нельзя,
  // рендерер такого не нарисует. Словарь импорта и контракт хранения отвечают
  // на разные вопросы.
  it("falls back to a text question instead of losing the whole file", () => {
    const result = normalizeImported(parse({ questions: [{ title: "Rate us", type: "WIDGETRON" }] }));

    expect(result.questions[0].type).toBe("TEXT_ANSWER");
    expect(result.warnings).toMatchObject([{ code: "TYPE_FALLBACK", questionIndex: 0 }]);
  });

  // Выбор из одного варианта — это недочитанный документ, а не намерение.
  it("keeps a choice question but says its options went missing", () => {
    const result = normalizeImported(
      parse({ questions: [{ title: "Pick one", type: "SINGLE_ANSWER", options: ["Only this"] }] }),
    );

    expect(result.questions[0].type).toBe("SINGLE_ANSWER");
    expect(result.warnings).toMatchObject([{ code: "OPTIONS_MISSING" }]);
    expect((result.questions[0].config.options as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it("stops at the ceiling and says how much it dropped", () => {
    const questions = Array.from({ length: IMPORT_LIMITS.questions + 5 }, (_, i) => ({
      title: `Question ${i}`,
      type: "TEXT_ANSWER",
    }));

    const result = normalizeImported(parse({ questions }));

    expect(result.questions).toHaveLength(IMPORT_LIMITS.questions);
    expect(result.warnings[0]).toMatchObject({ code: "TRUNCATED" });
  });

  // Экраны ответа не собирают, поэтому обязательными быть не могут — это
  // правило buildQuestion, и импорт обязан ему подчиняться, а не обходить.
  it("never marks a welcome screen as required", () => {
    const result = normalizeImported(parse({ questions: [{ title: "Hello", type: "WELCOME", required: true }] }));

    expect(result.questions[0].required).toBe(false);
  });

  it("passes through what the document contained but was not a question", () => {
    const result = normalizeImported(
      parse({
        questions: [{ title: "Anything else?", type: "LONG_TEXT" }],
        ignored: [{ text: "Corporate colours: #FF0000", reason: "branding" }],
      }),
    );

    expect(result.ignored).toMatchObject([{ reason: "branding" }]);
  });
});

describe("reading a table without the model", () => {
  it("reads a question grid one row at a time", () => {
    const parsed = readTable([
      ["Question", "Type", "Required", "Options"],
      ["How likely are you to recommend us?", "NPS", "yes", ""],
      ["Which plan are you on?", "SINGLE_ANSWER", "no", "Free; Pro; Team"],
    ]);

    expect(parsed).not.toBeNull();
    const result = normalizeImported(parsed!.survey, parsed!.warnings);
    expect(result.questions.map((q) => q.type)).toEqual(["NPS", "SINGLE_ANSWER"]);
    expect(result.questions[0].required).toBe(true);
    expect(result.questions[1].config.options).toEqual(["Free", "Pro", "Team"]);
    expect(result.warnings).toHaveLength(0);
  });

  it("collects numbered option columns too", () => {
    const parsed = readTable([
      ["Question", "Option 1", "Option 2", "Option 3"],
      ["Pick a colour", "Red", "Green", ""],
    ]);

    const result = normalizeImported(parsed!.survey, parsed!.warnings);
    expect(result.questions[0].config.options).toEqual(["Red", "Green"]);
  });

  // Один заголовок без строк — это состояние «ничего не нашли», а не ошибка.
  it("returns nothing for a header with no rows under it", () => {
    expect(readTable([["Question", "Type"]])).toBeNull();
  });

  it("recognises a responses export and infers the types from the answers", () => {
    const parsed = readTable([
      [
        "How likely are you to recommend us?",
        "Which plan are you on?",
        "Anything else you want to tell us today?",
      ],
      ["9", "Pro", "The onboarding email arrived twice and confused my whole team"],
      ["7", "Free", "Everything was fine, no complaints at all from our side"],
      ["10", "Pro", "Please add a dark theme, we work at night and it hurts"],
    ]);

    expect(parsed).not.toBeNull();
    expect(parsed!.warnings).toMatchObject([{ code: "INFERRED_FROM_RESPONSES" }]);

    const result = normalizeImported(parsed!.survey, parsed!.warnings);
    expect(result.questions.map((q) => q.type)).toEqual(["NPS", "SINGLE_ANSWER", "TEXT_ANSWER"]);
    expect(result.questions[1].config.options).toEqual(["Pro", "Free"]);
  });

  // Ни сетка, ни выгрузка: такую таблицу надо отдавать модели, а не выдумывать
  // из неё вопросы самим.
  it("gives up on a table that is neither", () => {
    expect(
      readTable([
        ["sku", "qty", "price"],
        ["A-1", "2", "10.00"],
        ["B-2", "1", "25.50"],
      ]),
    ).toBeNull();
  });
});
