import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURVEY_FONT,
  SURVEY_FONTS,
  chooseFont,
  isSupportedFont,
} from "../src/domain/fonts.js";

/**
 * Восемь шрифтов и подмена ненайденного.
 *
 * Список закрыт не из вредности: файлы лежат у нас, потому что CSP разрешает
 * только `font-src 'self' data:`, и каждое семейство — это четыре начертания в
 * репозитории. А кириллица обязательна, потому что шрифт без неё молча съедает
 * русский текст на системный, и опрос выглядит по-разному у разных людей.
 */
describe("список шрифтов", () => {
  it("их ровно восемь, как договорились", () => {
    expect(SURVEY_FONTS).toHaveLength(8);
  });

  it("Inter по умолчанию — он же стоит в макете Typography", () => {
    expect(DEFAULT_SURVEY_FONT).toBe("Inter");
    expect(isSupportedFont("Inter")).toBe(true);
  });

  it("узнаёт своё, не придираясь к регистру и пробелам", () => {
    expect(isSupportedFont("open sans")).toBe(true);
    expect(isSupportedFont("OpenSans")).toBe(true);
    expect(isSupportedFont("PT Sans")).toBe(true);
    expect(isSupportedFont("Comic Sans MS")).toBe(false);
    expect(isSupportedFont(undefined)).toBe(false);
  });
});

describe("подмена шрифта, найденного на сайте", () => {
  it("своё применяет как есть и молча", () => {
    expect(chooseFont("Montserrat")).toEqual({ family: "Montserrat" });
    expect(chooseFont("open sans").family).toBe("Open Sans");
    expect(chooseFont("open sans").note).toBeUndefined();
  });

  // Ровно тот случай, что нарисован на макете 14663-142276: найденный шрифт
  // Red Hat Display не входит в восьмёрку.
  it("подставляет ближайшее и ГОВОРИТ об этом", () => {
    const choice = chooseFont("Red Hat Display");
    expect(choice.family).toBe("Montserrat");
    expect(choice.requested).toBe("Red Hat Display");
    expect(choice.note).toContain("Red Hat Display");
    expect(choice.note).toContain("Montserrat");
  });

  it("узнаёт частые шрифты сайтов", () => {
    expect(chooseFont("Helvetica Neue").family).toBe("Inter");
    expect(chooseFont("Poppins").family).toBe("Montserrat");
    expect(chooseFont("Circular").family).toBe("Manrope");
    expect(chooseFont("Quicksand").family).toBe("Nunito");
    expect(chooseFont("Lato").family).toBe("Open Sans");
  });

  it("незнакомое сводит к Inter, но не молчит об этом", () => {
    const choice = chooseFont("Wingdings Ultra");
    expect(choice.family).toBe("Inter");
    expect(choice.note).toBeTruthy();
  });

  // Ничего не нашли — это не подмена, и говорить не о чем.
  it("пустое значение не порождает объяснения", () => {
    expect(chooseFont(null)).toEqual({ family: "Inter" });
    expect(chooseFont("   ")).toEqual({ family: "Inter" });
  });

  it("подменяет только на своё — иначе кириллица бы не гарантировалась", () => {
    for (const probe of ["Red Hat Display", "Gilroy", "что-то неведомое", "Futura"]) {
      expect(isSupportedFont(chooseFont(probe).family)).toBe(true);
    }
  });
});
