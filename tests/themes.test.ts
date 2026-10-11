import { describe, expect, it } from "vitest";
import { PRESET_DARK_DESIGN, PRESET_LIGHT_DESIGN, contrastRatio } from "../src/domain/design.js";
import {
  activeTheme,
  applyBrandThemes,
  buildBrandThemes,
  isCustomised,
  resetTheme,
  switchTheme,
} from "../src/domain/themes.js";
import { designTools } from "../src/tools/design.js";
import type { BrandReader } from "../src/tools/shared.js";
import type { SurveyDesign } from "../src/types.js";

/**
 * Заказчик, 24.09: «переключаясь на Theme presets, он сбрасывает всё, что
 * делали по стилям». Кнопки Light и Dark писали палитру пресета поверх всех
 * цветов, и ручные правки пропадали безвозвратно.
 */

const merge = (design: Partial<SurveyDesign>, patch: Partial<SurveyDesign> | null) => ({ ...design, ...(patch ?? {}) });

describe("activeTheme", () => {
  it("пресеты узнаются по фону", () => {
    expect(activeTheme(PRESET_LIGHT_DESIGN)).toBe("light");
    expect(activeTheme(PRESET_DARK_DESIGN)).toBe("dark");
  });

  it("старый опрос без фона — светлый", () => {
    expect(activeTheme({})).toBe("light");
    expect(activeTheme(undefined)).toBe("light");
  });
});

describe("switchTheme", () => {
  it("Light → Dark → Light возвращает ручные цвета", () => {
    const mine = { ...PRESET_LIGHT_DESIGN, buttonColor: "#A4DE02", questionColor: "#222222" };

    const dark = merge(mine, switchTheme(mine, "dark"));
    expect(dark.backgroundColor).toBe(PRESET_DARK_DESIGN.backgroundColor);

    const back = merge(dark, switchTheme(dark, "light"));
    expect(back).toMatchObject({ buttonColor: "#A4DE02", questionColor: "#222222" });
  });

  it("правки тёмной темы тоже переживают переключение", () => {
    const light = { ...PRESET_LIGHT_DESIGN };
    const dark = { ...merge(light, switchTheme(light, "dark")), backgroundColor: "#1E1B4B" };

    const lightAgain = merge(dark, switchTheme(dark, "light"));
    const darkAgain = merge(lightAgain, switchTheme(lightAgain, "dark"));
    expect(darkAgain.backgroundColor).toBe("#1E1B4B");
  });

  it("клик по уже активной теме ничего не делает", () => {
    expect(switchTheme({ ...PRESET_LIGHT_DESIGN, buttonColor: "#A4DE02" }, "light")).toBeNull();
  });

  it("не трогает логотип, шрифт и раскладку", () => {
    const mine = { ...PRESET_LIGHT_DESIGN, logo: "https://x/logo.png", fontFamily: "Inter", questionLayout: "all" as const };
    const patch = switchTheme(mine, "dark")!;
    expect(patch).not.toHaveProperty("logo");
    expect(patch).not.toHaveProperty("fontFamily");
    expect(patch).not.toHaveProperty("questionLayout");
  });
});

describe("resetTheme", () => {
  it("возвращает пресет и забывает сохранённое", () => {
    const mine = { ...PRESET_LIGHT_DESIGN, buttonColor: "#A4DE02" };
    expect(isCustomised(mine)).toBe(true);

    const reset = merge(mine, resetTheme(mine, "light"));
    expect(reset.buttonColor).toBe(PRESET_LIGHT_DESIGN.buttonColor);
    expect(isCustomised(reset)).toBe(false);
  });
});

describe("buildBrandThemes", () => {
  it("строит обе темы из одного цвета, тёмный акцент виден на тёмном фоне", () => {
    const brand = buildBrandThemes({ brandColor: "#1E3A8A" });

    expect(brand.light.backgroundColor).toBe("#FFFFFF");
    expect(brand.dark.backgroundColor).toBe("#0A0A0A");
    expect(contrastRatio(brand.dark.answerColor!, brand.dark.backgroundColor!)).toBeGreaterThanOrEqual(3);
    expect(brand.notes.some((note) => note.startsWith("Dark theme:"))).toBe(true);
  });

  it("названный цвет остаётся точным в показанной теме", () => {
    const brand = buildBrandThemes({ brandColor: "#1E3A8A", keepAccentIn: "dark" });
    expect(brand.dark.answerColor).toBe("#1E3A8A");
  });

  it("применение не переключает тёмный опрос на светлый", () => {
    const brand = buildBrandThemes({ brandColor: "#7C3AED" });
    const patch = applyBrandThemes(PRESET_DARK_DESIGN, brand);
    expect(patch.backgroundColor).toBe(brand.dark.backgroundColor);
    expect(patch.themes).toEqual({ light: brand.light, dark: brand.dark });
  });
});

// ------------------------------------------------------------------ tools

const tool = (name: string) => designTools.find((entry) => entry.name === name)!;

function surveyStore(design: Record<string, unknown>, brand?: BrandReader) {
  const state = { design };
  const client = {
    getSurvey: async () => ({ id: "s1", name: "Test", design: state.design }),
    updateSurvey: async (_id: string, patch: { design: Record<string, unknown> }) => {
      state.design = patch.design;
      return { id: "s1", name: "Test", design: state.design };
    },
  };
  return {
    state,
    context: { client, config: { apiUrl: "http://x/api/v1", readOnly: false }, ...(brand ? { brand } : {}) } as never,
  };
}

describe("design_apply_preset", () => {
  it("light/dark переключают тему без сброса", async () => {
    const { state, context } = surveyStore({ ...PRESET_LIGHT_DESIGN, buttonColor: "#A4DE02", fontFamily: "Inter" });

    await tool("design_apply_preset").handler({ surveyId: "s1", preset: "dark" }, context);
    expect(state.design.backgroundColor).toBe(PRESET_DARK_DESIGN.backgroundColor);
    expect(state.design.fontFamily).toBe("Inter");

    await tool("design_apply_preset").handler({ surveyId: "s1", preset: "light" }, context);
    expect(state.design.buttonColor).toBe("#A4DE02");
  });

  it("reset возвращает тему к умолчанию только по просьбе", async () => {
    const { state, context } = surveyStore({ ...PRESET_LIGHT_DESIGN, buttonColor: "#A4DE02" });

    await tool("design_apply_preset").handler({ surveyId: "s1", preset: "light", reset: true }, context);
    expect(state.design.buttonColor).toBe(PRESET_LIGHT_DESIGN.buttonColor);
  });

  it("brand ложится в обе темы и не трогает шрифт", async () => {
    const { state, context } = surveyStore({ ...PRESET_LIGHT_DESIGN, fontFamily: "Manrope" });

    await tool("design_apply_preset").handler({ surveyId: "s1", preset: "brand", brandColor: "#A4DE02" }, context);

    const themes = state.design.themes as Record<string, Record<string, string>>;
    expect(themes.light.buttonColor).toBe("#A4DE02");
    expect(themes.dark.backgroundColor).toBe("#0A0A0A");
    expect(state.design.fontFamily).toBe("Manrope");
  });
});

describe("design_match_brand", () => {
  const reading = {
    source: "brand.example",
    primaryColor: "#7C3AED",
    colors: ["#7C3AED"],
    fontFamily: "Inter",
    logo: "https://brand.example/logo.png",
    injectionSuspected: false,
  };

  it("по ссылке: обе темы, шрифт и логотип, если его не было", async () => {
    const urls: string[] = [];
    const { state, context } = surveyStore(
      { ...PRESET_LIGHT_DESIGN },
      { readSite: async (url) => (urls.push(url), reading) },
    );

    await tool("design_match_brand").handler({ surveyId: "s1", url: "brand.example" }, context);

    expect(urls).toEqual(["brand.example"]);
    const themes = state.design.themes as Record<string, Record<string, string>>;
    expect(themes.light.answerColor).toBeDefined();
    expect(themes.dark.backgroundColor).toBe("#0A0A0A");
    expect(state.design).toMatchObject({ fontFamily: "Inter", logo: reading.logo });
  });

  it("чужой логотип не затирает уже стоящий", async () => {
    const { state, context } = surveyStore(
      { ...PRESET_LIGHT_DESIGN, logo: "https://mine/logo.png" },
      { readSite: async () => reading },
    );

    const result = await tool("design_match_brand").handler({ surveyId: "s1", url: "brand.example" }, context);

    expect(state.design.logo).toBe("https://mine/logo.png");
    expect(JSON.stringify(result)).toContain("already has a logo");
  });

  it("по картинке: цвет, прочитанный моделью, точный в показанной теме", async () => {
    const { state, context } = surveyStore({ ...PRESET_DARK_DESIGN });

    await tool("design_match_brand").handler({ surveyId: "s1", brandColor: "#1E3A8A", fontFamily: "Helvetica" }, context);

    expect(state.design.answerColor).toBe("#1E3A8A");
    expect(state.design.backgroundColor).toBe("#0A0A0A");
    expect(typeof state.design.fontFamily).toBe("string");
  });

  it("без нашего читателя сайтов (внешний MCP-клиент) отправляет модель прочитать сайт самой", async () => {
    const { state, context } = surveyStore({ ...PRESET_LIGHT_DESIGN });

    const result = await tool("design_match_brand").handler({ surveyId: "s1", url: "brand.example" }, context);

    expect(JSON.stringify(result)).toContain("brand_read_site");
    expect(state.design.themes).toBeUndefined();
  });

  it("роли, прочитанные моделью клиента с сайта, — цвета сайта: обе темы читаемы, логотип ставится", async () => {
    const { state, context } = surveyStore({ ...PRESET_DARK_DESIGN });

    const result = await tool("design_match_brand").handler(
      {
        surveyId: "s1",
        brandColor: "#1E3A8A",
        roles: { primaryAccent: "#1E3A8A", background: "#FFFFFF", text: "#111111" },
        logoUrl: "https://brand.example/logo.png",
      },
      context,
    );

    expect(JSON.stringify(result)).toContain("the brand's site");
    expect(state.design.logo).toBe("https://brand.example/logo.png");
    expect(state.design.themes).toBeDefined();
  });
});
