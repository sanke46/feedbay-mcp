import { describe, expect, it } from "vitest";
import { normalizeColor } from "../src/domain/design.js";
import { QUESTION_TYPES } from "../src/domain/question-types.js";
import { designTools } from "../src/tools/design.js";

/**
 * Карточки тестировщика про ассистента и дизайн (Trello, 23.09):
 * «rgb понимает, а hex нет», «нет настройки layout», «vertical/horizontal нет».
 */

const tool = (name: string) => designTools.find((entry) => entry.name === name)!;

/** Опрос в памяти: инструмент читает его и пишет назад целиком. */
function surveyStore(design: Record<string, unknown>) {
  const state = { design };
  const client = {
    getSurvey: async () => ({ id: "s1", name: "Test", design: state.design }),
    updateSurvey: async (_id: string, patch: { design: Record<string, unknown> }) => {
      state.design = patch.design;
      return { id: "s1", name: "Test", design: state.design };
    },
  };
  return { state, context: { client, config: { apiUrl: "http://x/api/v1", readOnly: false } } as never };
}

describe("normalizeColor", () => {
  it.each([
    ["#a4de02", "#A4DE02"],
    ["A4DE02", "#A4DE02"],
    ["#fff", "#FFFFFF"],
    ["rgb(164, 222, 2)", "#A4DE02"],
    ["rgba(164,222,2,0.5)", "#A4DE02"],
    ["rgb(164 222 2)", "#A4DE02"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeColor(input)).toBe(expected);
  });

  it.each(["green", "#12345", "rgb(300, 0, 0)", ""])("%s не цвет", (input) => {
    expect(normalizeColor(input)).toBeNull();
  });
});

describe("design_update", () => {
  it("хранит цвет в том виде, что и палитра редактора", async () => {
    const { state, context } = surveyStore({ buttonColor: "#000000" });

    await tool("design_update").handler({ surveyId: "s1", buttonColor: "a4de02", answerColor: "rgb(164, 222, 2)" }, context);

    expect(state.design).toMatchObject({ buttonColor: "#A4DE02", answerColor: "#A4DE02" });
  });

  // Прогон на проде (Trello 8Uojv6ny): «фирменный цвет» ушёл только в
  // primaryColor, а кнопки остались синими — редактор подмешивает свою палитру.
  it("фирменный цвет красит кнопки, отметки и прогресс", async () => {
    const { state, context } = surveyStore({ buttonColor: "#3B82F6", answerColor: "#3B82F6", progressColor: "#3B82F6" });

    await tool("design_update").handler({ surveyId: "s1", primaryColor: "#A4DE02" }, context);

    expect(state.design).toMatchObject({
      primaryColor: "#A4DE02",
      buttonColor: "#A4DE02",
      answerColor: "#A4DE02",
      progressColor: "#A4DE02",
    });
    // Светло-зелёная кнопка — тёмная подпись, иначе белое на салатовом не читается.
    expect(state.design.buttonTextColor).toBe("#0A0A0A");
  });

  it("явно заданные цвета кнопки не перезаписываются акцентом", async () => {
    const { state, context } = surveyStore({});

    await tool("design_update").handler({ surveyId: "s1", primaryColor: "#A4DE02", buttonColor: "#111111" }, context);

    expect(state.design).toMatchObject({ buttonColor: "#111111", answerColor: "#A4DE02" });
    expect(state.design.buttonTextColor).toBeUndefined();
  });

  it("переключает раскладку вопросов", async () => {
    const { state, context } = surveyStore({ questionLayout: "one" });

    await tool("design_update").handler({ surveyId: "s1", questionLayout: "all" }, context);

    expect(state.design.questionLayout).toBe("all");
  });

  it("раскладка видна модели в схеме инструмента", () => {
    expect(Object.keys(tool("design_update").inputSchema)).toContain("questionLayout");
  });
});

describe("design_apply_preset", () => {
  it("brand оставляет названный цвет как есть", async () => {
    const { state, context } = surveyStore({});

    await tool("design_apply_preset").handler({ surveyId: "s1", preset: "brand", brandColor: "#A4DE02" }, context);

    expect(state.design).toMatchObject({ buttonColor: "#A4DE02", answerColor: "#A4DE02", primaryColor: "#A4DE02" });
  });

  it("сдвигает цвет только по просьбе — и говорит, в какую сторону", async () => {
    const { state, context } = surveyStore({});

    const result = await tool("design_apply_preset").handler(
      { surveyId: "s1", preset: "brand", brandColor: "#A4DE02", adjustForContrast: true },
      context,
    );

    expect(state.design.buttonColor).not.toBe("#A4DE02");
    expect(JSON.stringify(result)).toMatch(/darkened to #/);
  });

  it.each(["light", "dark", "brand"])("%s не сбрасывает «все вопросы на одной странице»", async (preset) => {
    const { state, context } = surveyStore({ questionLayout: "all" });

    await tool("design_apply_preset").handler({ surveyId: "s1", preset, brandColor: "#7C3AED" }, context);

    expect(state.design.questionLayout).toBe("all");
  });
});

describe("каталог типов", () => {
  it.each(["RATING_SCALE", "NPS", "CSAT", "CES", "YES_NO", "SINGLE_ANSWER", "MULTIPLE_ANSWER"])(
    "%s описывает ориентацию ответов",
    (type) => {
      const spec = QUESTION_TYPES.find((entry) => entry.type === type)!;
      expect(spec.configFields).toHaveProperty("optionsOrientation");
    },
  );

  it("у выпадающего списка оси нет — и поля нет", () => {
    const spec = QUESTION_TYPES.find((entry) => entry.type === "DROPDOWN")!;
    expect(spec.configFields).not.toHaveProperty("optionsOrientation");
  });
});
