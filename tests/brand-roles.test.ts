import { describe, expect, it } from "vitest";
import { buildBrandDesign, contrastRatio, themeOfBackground } from "../src/domain/design.js";
import { buildBrandThemes } from "../src/domain/themes.js";

/**
 * Trello UoJ7SfQx (25.09): бренд подбирался «по четырём цветам», и поля опроса
 * получали цвета не по назначению. Правило тестировщика: сначала роль цвета на
 * сайте, потом поле опроса по роли; неизвестная роль — безопасный дефолт.
 */
const BRAND_SITE = {
  text: "#171717",
  background: "#FFFFFF",
  primaryAccent: "#B2DE01",
  secondaryAccent: "#2563EB",
  neutralSurface: "#F2F4F7",
};

describe("палитра по ролям", () => {
  it("пример сайта бренда из карточки: поле опроса — по роли цвета", () => {
    const { design } = buildBrandDesign({ brandColor: "#B2DE01", mode: "light", roles: BRAND_SITE });
    expect(design).toMatchObject({
      questionColor: "#171717",
      answerTextColor: "#171717",
      answerColor: "#B2DE01",
      buttonColor: "#B2DE01",
      progressColor: "#B2DE01",
      // Текст на лаймовой кнопке — цвет текста сайта, он читается.
      buttonTextColor: "#171717",
      // Невыбранный ответ — нейтральная поверхность, а не второй акцент.
      answerUnselectedColor: "#F2F4F7",
      answerUnselectedTextColor: "#171717",
      backgroundColor: "#FFFFFF",
      secondaryColor: "#2563EB",
    });
  });

  it("акцент сайта в его теме не затемняется ради фона", () => {
    const { design } = buildBrandDesign({ brandColor: "#B2DE01", mode: "light", roles: BRAND_SITE });
    expect(design.buttonColor).toBe("#B2DE01");
    expect(contrastRatio(design.buttonTextColor, design.buttonColor)).toBeGreaterThanOrEqual(3);
  });

  it("вторая тема берёт только акцент, нейтрали — свои", () => {
    const themes = buildBrandThemes({ brandColor: "#B2DE01", roles: BRAND_SITE });
    expect(themes.light.backgroundColor).toBe("#FFFFFF");
    expect(themes.dark.backgroundColor).toBe("#0A0A0A");
    expect(themes.dark.questionColor).toBe("#F5F5F5");
    expect(themes.dark.answerUnselectedColor).toBe("#404040");
    expect(themes.dark.buttonColor).toBe("#B2DE01");
  });

  it("неизвестная роль — безопасный дефолт темы, а не случайный цвет", () => {
    const { design } = buildBrandDesign({
      brandColor: "#7C3AED",
      mode: "light",
      roles: { text: null, background: null, primaryAccent: "#7C3AED", secondaryAccent: null, neutralSurface: null },
    });
    expect(design.questionColor).toBe("#171717");
    expect(design.answerUnselectedColor).toBe("#D1D5DB");
    expect(design.backgroundColor).toBe("#FFFFFF");
  });

  it("нечитаемый текст сайта подвигается до контраста и об этом сказано", () => {
    const result = buildBrandDesign({
      brandColor: "#0055FF",
      mode: "light",
      roles: { ...BRAND_SITE, text: "#BBBBBB" },
    });
    expect(contrastRatio(result.design.questionColor, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(result.notes.join(" ")).toContain("#BBBBBB");
  });

  it("тёмный сайт отдаёт роли тёмной теме, а светлая остаётся своей", () => {
    const dark = { text: "#EDEDED", background: "#101418", primaryAccent: "#FF5A1F", secondaryAccent: null, neutralSurface: "#1F262E" };
    expect(themeOfBackground(dark.background)).toBe("dark");
    const themes = buildBrandThemes({ brandColor: "#FF5A1F", roles: dark });
    expect(themes.dark).toMatchObject({ backgroundColor: "#101418", questionColor: "#EDEDED", answerUnselectedColor: "#1F262E" });
    expect(themes.light.backgroundColor).toBe("#FFFFFF");
  });

  // Прод, сайт бренда, 25.09: модель назвала «нейтральной поверхностью» красный.
  it("красный не принимается за нейтральную поверхность", () => {
    const result = buildBrandDesign({
      brandColor: "#A4DE02",
      mode: "light",
      roles: { ...BRAND_SITE, primaryAccent: "#A4DE02", neutralSurface: "#E4252D" },
    });
    expect(result.design.answerUnselectedColor).toBe("#D1D5DB");
    expect(result.notes.join(" ")).toContain("#E4252D is not a neutral colour");
  });

  it("без ролей — как раньше", () => {
    const before = buildBrandDesign({ brandColor: "#7C3AED", mode: "light" });
    expect(before.design.questionColor).toBe("#171717");
    expect(before.design.answerUnselectedColor).toBe("#D1D5DB");
  });
});
