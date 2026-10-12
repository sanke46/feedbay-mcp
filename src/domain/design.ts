/**
 * Survey styling: the presets the dashboard ships, plus a palette generator.
 *
 * The design tab exposes eight colour pickers and two presets. A chat asked to
 * "make it match our brand" would otherwise have to invent eight hex values and
 * hope they stay readable. `buildBrandDesign()` derives the whole palette from a
 * single accent colour and adjusts it until the text on it clears WCAG AA — that
 * is the difference between generating a style and guessing one.
 *
 * Preset values mirror frontend/src/lib/design-defaults.ts.
 */

import type { SurveyDesign } from "../types.js";

export const SURVEY_BRAND_COLOR = "#3B82F6";
export const DEFAULT_SURVEY_BACKGROUND_OPACITY = 50;

export const DEFAULT_SURVEY_DESIGN: SurveyDesign = {
  questionColor: "#171717",
  answerColor: SURVEY_BRAND_COLOR,
  answerTextColor: "#171717",
  answerUnselectedColor: "#D1D5DB",
  answerUnselectedTextColor: "#374151",
  answerBackgroundColor: "#FFFFFF",
  answerBackgroundOpacity: DEFAULT_SURVEY_BACKGROUND_OPACITY,
  progressColor: SURVEY_BRAND_COLOR,
  buttonColor: SURVEY_BRAND_COLOR,
  buttonTextColor: "#FFFFFF",
  backgroundColor: "#FFFFFF",
  showBranding: true,
};

export const PRESET_LIGHT_DESIGN: SurveyDesign = {
  questionColor: "#171717",
  answerColor: "#3B82F6",
  answerTextColor: "#171717",
  answerUnselectedColor: "#D1D5DB",
  answerUnselectedTextColor: "#374151",
  answerBackgroundColor: "#FFFFFF",
  answerBackgroundOpacity: 100,
  progressColor: "#3B82F6",
  buttonColor: "#3B82F6",
  buttonTextColor: "#FFFFFF",
  backgroundColor: "#FFFFFF",
  showBranding: true,
};

export const PRESET_DARK_DESIGN: SurveyDesign = {
  questionColor: "#F5F5F5",
  answerColor: "#60A5FA",
  answerTextColor: "#FFFFFF",
  answerUnselectedColor: "#404040",
  answerUnselectedTextColor: "#D4D4D4",
  answerBackgroundColor: "#171717",
  answerBackgroundOpacity: 100,
  progressColor: "#60A5FA",
  buttonColor: "#60A5FA",
  buttonTextColor: "#0A0A0A",
  backgroundColor: "#0A0A0A",
  showBranding: true,
};

/**
 * Design keys the renderer honours but the dashboard has no form for. Reported
 * by `design_get` so a caller knows these are reachable only through the API.
 * @see packages/survey-renderer/src/applyDesign.ts
 */
export const DESIGN_FIELDS_WITHOUT_UI = [
  "primaryColor",
  "secondaryColor",
  // fontFamily отсюда УБРАН: у него появился блок Typography в дизайне
  // (ТЗ п. 7). Оставить его здесь значило бы, что ассистент продолжает
  // уверять человека, будто регулятора в интерфейсе нет.
  "borderRadius",
] as const;

// --------------------------------------------------------------- colour math

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(input: string): Rgb {
  const hex = input.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`"${input}" is not a hex colour. Use #RRGGBB, for example #7C3AED.`);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Any colour a person is likely to type, as the `#RRGGBB` the renderer expects.
 *
 * design_update used to store the string as sent: `A4DE02` without `#` became
 * an invalid CSS value and the colour silently did not apply, while `rgb(...)`
 * was refused outright. Returns null for anything else.
 */
export function normalizeColor(input: string): string | null {
  const value = input.trim();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(value);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return r <= 255 && g <= 255 && b <= 255 ? toHex({ r, g, b }) : null;
  }
  try {
    return toHex(parseHex(value));
  } catch {
    return null;
  }
}


export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(parseHex(a));
  const lumB = relativeLuminance(parseHex(b));
  const [light, dark] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (light + 0.05) / (dark + 0.05);
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
  else h = ((rn - gn) / delta + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (t: number) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  return { r: toChannel(h + 1 / 3) * 255, g: toChannel(h) * 255, b: toChannel(h - 1 / 3) * 255 };
}

/** Shift a colour's lightness by `delta` (-1..1), keeping hue and saturation. */
export function shiftLightness(hex: string, delta: number): string {
  const hsl = rgbToHsl(parseHex(hex));
  return toHex(hslToRgb({ ...hsl, l: clamp(hsl.l + delta, 0, 1) }));
}

/** Whichever of near-black / white reads better on `background`. */
export function readableTextOn(background: string): string {
  return contrastRatio("#FFFFFF", background) >= contrastRatio("#0A0A0A", background) ? "#FFFFFF" : "#0A0A0A";
}

/**
 * Nudge `color` away from `background` in lightness until it clears `minRatio`.
 * Returns the original colour when it already passes, and the best attempt when
 * even pure black or white cannot reach the target (very rare, but the caller
 * gets told about it through `contrastReport`).
 */
export function ensureContrast(color: string, background: string, minRatio: number): string {
  if (contrastRatio(color, background) >= minRatio) return color;

  const backgroundIsDark = relativeLuminance(parseHex(background)) < 0.5;
  const step = backgroundIsDark ? 0.04 : -0.04;
  let candidate = color;
  for (let i = 0; i < 25; i += 1) {
    candidate = shiftLightness(candidate, step);
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return candidate;
}

// ----------------------------------------------------------- palette builder

export type DesignPreset = "light" | "dark" | "brand";

/**
 * What each brand colour DOES on the site (Trello UoJ7SfQx, 25.09).
 *
 * The tester's point: "find four colours" is the wrong task. The survey field a
 * colour lands in must follow the job the colour does on the site – text stays
 * text, the button colour goes to buttons, a neutral grey goes to unselected
 * answers, not the secondary accent. Anything not known is null and falls back
 * to the theme's safe default rather than a random swatch from the palette.
 */
export interface BrandRoles {
  text?: string | null;
  background?: string | null;
  primaryAccent?: string | null;
  secondaryAccent?: string | null;
  neutralSurface?: string | null;
}

/**
 * A neutral surface is quiet: little saturation and the lightness of its
 * theme. Found on prod (a real brand site, 25.09): the model called the site's red
 * #E4252D "neutralSurface", and unselected answers would have turned red.
 */
function neutralOrNull(color: string | null, mode: "light" | "dark"): string | null {
  if (!color) return null;
  const { s, l } = rgbToHsl(parseHex(color));
  const quiet = s <= 0.3 || (l >= 0.92 || l <= 0.12);
  const fitsTheme = mode === "light" ? l >= 0.75 : l <= 0.35;
  return quiet && fitsTheme ? color : null;
}

/** Light or dark, judged by the site's background. */
export function themeOfBackground(background: string): "light" | "dark" {
  return relativeLuminance(parseHex(background)) < 0.4 ? "dark" : "light";
}

export interface BrandPaletteOptions {
  /** Accent colour the palette is built around. */
  brandColor: string;
  /**
   * The site's colours by role. Applied in full only to the theme the site
   * itself uses (its background decides); the other theme takes the accent and
   * keeps its own neutrals, because a site's white background says nothing
   * about how its dark version should look.
   */
  roles?: BrandRoles;
  /** Light or dark surface. Defaults to light. */
  mode?: "light" | "dark";
  /** Carried over rather than regenerated (logo, background image, branding). */
  base?: Partial<SurveyDesign>;
  /**
   * Use the accent exactly as given instead of shifting it until it clears
   * contrast. A person who names a colour means that colour: the tester asked
   * for #A4DE02 and got #77A202, a different green, with no say in it. Low
   * contrast is still reported in `notes`.
   */
  keepAccent?: boolean;
}

export interface ContrastCheck {
  pair: string;
  ratio: number;
  /**
   * WCAG AA target for this pair: 4.5 for text, 3 for large labels and
   * interface marks. Shown so "3.13 passesAA" does not read as a mistake.
   */
  target: number;
  passesAA: boolean;
}

export interface GeneratedDesign {
  design: SurveyDesign;
  contrastReport: ContrastCheck[];
  notes: string[];
}

const AA_NORMAL = 4.5;
/** AA for large / bold text, which is what button and answer labels are. */
const AA_LARGE = 3;

/**
 * Build a complete, readable palette from one accent colour.
 *
 * Deterministic: the same inputs always produce the same design, so a chat can
 * re-apply a brand without the survey drifting between runs.
 */
export function buildBrandDesign({
  brandColor,
  mode = "light",
  base,
  keepAccent = false,
  roles,
}: BrandPaletteOptions): GeneratedDesign {
  const notes: string[] = [];
  const valid = (value: string | null | undefined): string | null =>
    value && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? toHex(parseHex(value)) : null;
  // Roles speak for the site's own theme only.
  const siteBackground = valid(roles?.background);
  const ownTheme = roles && (!siteBackground || themeOfBackground(siteBackground) === mode);
  const role = {
    text: ownTheme ? valid(roles?.text) : null,
    background: ownTheme ? siteBackground : null,
    secondaryAccent: ownTheme ? valid(roles?.secondaryAccent) : null,
    neutralSurface: ownTheme ? neutralOrNull(valid(roles?.neutralSurface), mode) : null,
  };
  if (ownTheme && valid(roles?.neutralSurface) && !role.neutralSurface) {
    notes.push(
      `${valid(roles?.neutralSurface)} is not a neutral colour, so unselected answers keep the theme's grey.`,
    );
  }

  const surface = role.background ?? (mode === "dark" ? "#0A0A0A" : "#FFFFFF");
  const card = role.background ?? (mode === "dark" ? "#171717" : "#FFFFFF");

  const requested = toHex(parseHex(valid(roles?.primaryAccent) ?? brandColor));
  // On a dark surface a deep brand colour disappears; lift it until the accent
  // is visible against the background it sits on — unless asked not to.
  // The site's own button colour in the site's own theme is the brand – a lime
  // button on white is exactly what that brand site looks like. Readability is kept
  // by the label on it (buttonText below), not by darkening the brand.
  const keep = keepAccent || Boolean(ownTheme && valid(roles?.primaryAccent));
  const accent = keep ? requested : ensureContrast(requested, surface, AA_LARGE);
  if (accent !== requested) {
    const direction = relativeLuminance(parseHex(accent)) > relativeLuminance(parseHex(requested)) ? "lightened" : "darkened";
    notes.push(
      `Accent ${requested} was too close to the ${mode} background to stay visible, so it was ${direction} to ${accent}.`,
    );
  }

  // The site's text colour, kept only while it reads on the survey's surface.
  const text = role.text ? ensureContrast(role.text, surface, AA_NORMAL) : null;
  if (role.text && text !== role.text) {
    notes.push(`Text colour ${role.text} was hard to read on ${surface}, so it was adjusted to ${text}.`);
  }
  // Label on the button: the site's text colour when it reads on the accent
  // (the tester's brand-site case: dark text on lime green), else black/white.
  // "Reads" means AA for normal text, or at least as well as black/white:
  // with the old 3:1 bar a dark-text site on a violet or blue accent got a
  // near-black label at ~3.2:1 while white would have given ~5.5:1.
  const plainLabel = readableTextOn(accent);
  const buttonText =
    text &&
    (contrastRatio(text, accent) >= AA_NORMAL || contrastRatio(text, accent) >= contrastRatio(plainLabel, accent))
      ? text
      : plainLabel;
  // Unselected answers are a NEUTRAL surface, never the secondary accent.
  const unselected = role.neutralSurface ?? (mode === "dark" ? "#404040" : "#D1D5DB");

  const design: SurveyDesign = {
    ...DEFAULT_SURVEY_DESIGN,
    ...base,
    questionColor: text ?? (mode === "dark" ? "#F5F5F5" : "#171717"),
    answerColor: accent,
    answerTextColor: text ?? (mode === "dark" ? "#FFFFFF" : "#171717"),
    answerUnselectedColor: unselected,
    answerUnselectedTextColor: text ?? (mode === "dark" ? "#D4D4D4" : "#374151"),
    answerBackgroundColor: card,
    answerBackgroundOpacity: 100,
    progressColor: accent,
    buttonColor: accent,
    buttonTextColor: buttonText,
    backgroundColor: surface,
    showBranding: base?.showBranding ?? true,
    primaryColor: accent,
    secondaryColor: role.secondaryAccent ?? shiftLightness(accent, mode === "dark" ? -0.18 : 0.18),
  };

  const contrastReport: ContrastCheck[] = [
    check("question text on background", design.questionColor, design.backgroundColor, AA_NORMAL),
    check("button label on button", design.buttonTextColor, design.buttonColor, AA_LARGE),
    check("answer text on card", design.answerTextColor, card, AA_NORMAL),
    check("accent on background", design.answerColor, design.backgroundColor, AA_LARGE),
  ];

  for (const entry of contrastReport) {
    if (!entry.passesAA) {
      notes.push(`Contrast for ${entry.pair} is ${entry.ratio.toFixed(2)}:1, below the WCAG AA target.`);
    }
  }

  return { design, contrastReport, notes };
}

function check(pair: string, foreground: string, background: string, target: number): ContrastCheck {
  const ratio = contrastRatio(foreground, background);
  return { pair, ratio: Math.round(ratio * 100) / 100, target, passesAA: ratio >= target };
}

/**
 * The same contrast checks for any design, not only a generated brand palette.
 *
 * design_get and design_update had none (run of 12.10): a model that set colours
 * by hand could not tell whether the result was readable without a browser.
 * Unset fields fall back to the light theme defaults, as the renderer does.
 */
export function contrastReportFor(design: Partial<SurveyDesign>): ContrastCheck[] {
  const color = (value: unknown, fallback: string): string =>
    (typeof value === "string" ? normalizeColor(value) : null) ?? fallback;
  const background = color(design.backgroundColor, "#FFFFFF");
  const card = color(design.answerBackgroundColor, background);
  const accent = color(design.buttonColor ?? design.primaryColor ?? design.answerColor, "#2563EB");
  return [
    check("question text on background", color(design.questionColor, "#171717"), background, AA_NORMAL),
    check("button label on button", color(design.buttonTextColor, readableTextOn(accent)), accent, AA_LARGE),
    check("answer text on card", color(design.answerTextColor, "#171717"), card, AA_NORMAL),
    check("accent on background", color(design.answerColor ?? design.primaryColor, accent), background, AA_LARGE),
  ];
}

export function presetDesign(preset: "light" | "dark"): SurveyDesign {
  return preset === "dark" ? { ...PRESET_DARK_DESIGN } : { ...PRESET_LIGHT_DESIGN };
}
