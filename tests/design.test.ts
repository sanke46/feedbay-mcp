import { describe, expect, it } from "vitest";
import {
  buildBrandDesign,
  contrastRatio,
  ensureContrast,
  parseHex,
  presetDesign,
  readableTextOn,
  shiftLightness,
  toHex,
} from "../src/domain/design.js";

describe("colour maths", () => {
  it("accepts short and long hex, with or without the hash", () => {
    expect(toHex(parseHex("#fff"))).toBe("#FFFFFF");
    expect(toHex(parseHex("7c3aed"))).toBe("#7C3AED");
  });

  it("rejects anything that is not a colour", () => {
    expect(() => parseHex("purple")).toThrow(/not a hex colour/);
    expect(() => parseHex("#12345")).toThrow(/not a hex colour/);
  });

  it("computes the WCAG reference contrast ratios", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("picks the readable text colour for a background", () => {
    expect(readableTextOn("#FFFFFF")).toBe("#0A0A0A");
    expect(readableTextOn("#0A0A0A")).toBe("#FFFFFF");
  });

  it("keeps a colour that already passes untouched", () => {
    expect(ensureContrast("#000000", "#FFFFFF", 4.5)).toBe("#000000");
  });

  it("lightens a colour that is too dark for a dark background", () => {
    const adjusted = ensureContrast("#101010", "#0A0A0A", 3);
    expect(contrastRatio(adjusted, "#0A0A0A")).toBeGreaterThanOrEqual(3);
  });

  it("clamps lightness at the ends of the range", () => {
    expect(shiftLightness("#FFFFFF", 0.5)).toBe("#FFFFFF");
    expect(shiftLightness("#000000", -0.5)).toBe("#000000");
  });
});

describe("brand palette", () => {
  it("is deterministic — the same brand always yields the same design", () => {
    const first = buildBrandDesign({ brandColor: "#7C3AED" });
    const second = buildBrandDesign({ brandColor: "#7c3aed" });
    expect(first.design).toEqual(second.design);
  });

  it("puts readable text on the button for both a dark and a light accent", () => {
    for (const brandColor of ["#7C3AED", "#FDE047", "#0F172A", "#10B981"]) {
      const { design } = buildBrandDesign({ brandColor });
      expect(contrastRatio(design.buttonTextColor, design.buttonColor), brandColor).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the question text readable on the surface in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const { design } = buildBrandDesign({ brandColor: "#7C3AED", mode });
      expect(contrastRatio(design.questionColor, design.backgroundColor), mode).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("lifts an accent that would vanish against a dark surface, and says so", () => {
    const { design, notes } = buildBrandDesign({ brandColor: "#111111", mode: "dark" });
    expect(design.answerColor).not.toBe("#111111");
    expect(contrastRatio(design.answerColor, design.backgroundColor)).toBeGreaterThanOrEqual(3);
    expect(notes.join(" ")).toMatch(/lightened/);
  });

  it("carries the logo, background image and branding flag through untouched", () => {
    const { design } = buildBrandDesign({
      brandColor: "#7C3AED",
      base: { logo: "https://cdn/logo.png", backgroundImage: "https://cdn/bg.jpg", showBranding: false },
    });
    expect(design.logo).toBe("https://cdn/logo.png");
    expect(design.backgroundImage).toBe("https://cdn/bg.jpg");
    expect(design.showBranding).toBe(false);
  });

  it("reports contrast for every pair it generates", () => {
    const { contrastReport } = buildBrandDesign({ brandColor: "#3B82F6" });
    expect(contrastReport).toHaveLength(4);
    for (const entry of contrastReport) expect(entry.ratio).toBeGreaterThan(1);
  });
});

describe("presets", () => {
  it("returns a fresh object each time so callers cannot mutate the shared preset", () => {
    const first = presetDesign("dark");
    first.buttonColor = "#FF0000";
    expect(presetDesign("dark").buttonColor).toBe("#60A5FA");
  });
});
