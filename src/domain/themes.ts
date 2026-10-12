/**
 * Light and dark themes of one survey, each with its own palette.
 *
 * WHY THIS EXISTS. The Light / Dark buttons in the design tab used to write a
 * fixed preset palette over every colour field. Everything the person had set
 * by hand, or taken from Match your brand, vanished on the first click and
 * could not be brought back by clicking the other button again.
 *
 * THE MODEL. The top level of `design` stays the palette of the ACTIVE theme —
 * the renderer, the widget, the public page and the email embed read nothing
 * new. `design.themes` keeps each theme's palette as it was when the person
 * left it. Switching parks the current colours under the current theme and
 * brings the target theme's colours up; only a theme never visited falls back
 * to the preset.
 *
 * THE ACTIVE THEME IS NOT STORED. It is read from the background's lightness.
 * A stored flag would go stale the moment anything else wrote the colours — the
 * assistant's `design_update`, an older client, a hand-edited API call — and the
 * buttons would then light up one theme while the survey shows the other.
 *
 * Shared by the dashboard (through `browser.ts`) and the assistant's tools, so
 * both switch themes the same way.
 */

import type { SurveyDesign, ThemeName, ThemePalette } from "../types.js";
import {
  PRESET_DARK_DESIGN,
  PRESET_LIGHT_DESIGN,
  buildBrandDesign,
  normalizeColor,
  readableTextOn,
  type BrandRoles,
  type ContrastCheck,
} from "./design.js";

export type { ThemeName, ThemePalette } from "../types.js";

/**
 * The colour fields that belong to a theme. Everything else in `design` — logo,
 * background image, its opacity, font, layout, the branding flag — belongs to
 * the survey and survives any theme switch untouched.
 *
 * `primaryColor` / `secondaryColor` are here because the brand builder writes
 * them from the accent: left on the top level, a dark brand accent would keep
 * colouring a light theme after the switch.
 */
export const THEME_COLOR_FIELDS = [
  "questionColor",
  "answerColor",
  "answerTextColor",
  "answerUnselectedColor",
  "answerUnselectedTextColor",
  "answerBackgroundColor",
  "progressColor",
  "buttonColor",
  "buttonTextColor",
  "backgroundColor",
  "primaryColor",
  "secondaryColor",
] as const satisfies ReadonlyArray<keyof ThemePalette>;

const PRESETS: Record<ThemeName, SurveyDesign> = {
  light: PRESET_LIGHT_DESIGN,
  dark: PRESET_DARK_DESIGN,
};

/** The theme's colours only, without the fields that are left undefined. */
export function pickPalette(design: Partial<SurveyDesign>): ThemePalette {
  const palette: ThemePalette = {};
  for (const field of THEME_COLOR_FIELDS) {
    const value = design[field];
    if (typeof value === "string" && value) palette[field] = value;
  }
  return palette;
}

/** The preset palette of a theme — what a theme never visited starts from. */
export function presetPalette(theme: ThemeName): ThemePalette {
  return pickPalette(PRESETS[theme]);
}

/**
 * Which theme the survey is showing now, read from its background.
 *
 * Dark means white text reads better on it than black — the same test the
 * palette builder uses for button labels, so a background the builder calls
 * dark is dark here too. Anything that is not a readable colour counts as
 * light: that is the default survey, and a missing background renders white.
 */
export function activeTheme(design: Partial<SurveyDesign> | undefined): ThemeName {
  const background = design?.backgroundColor ? normalizeColor(design.backgroundColor) : null;
  if (!background) return "light";
  return readableTextOn(background) === "#FFFFFF" ? "dark" : "light";
}

/**
 * A patch that shows the palette as the top level, clearing theme fields the
 * palette does not have. Without the clearing, a brand theme's `primaryColor`
 * would outlive a switch to a preset theme that has none.
 */
function paletteAsTopLevel(palette: ThemePalette): Partial<SurveyDesign> {
  const patch: Record<string, string | undefined> = {};
  for (const field of THEME_COLOR_FIELDS) patch[field] = palette[field];
  return patch as Partial<SurveyDesign>;
}

/**
 * Switch the survey to `target`, keeping what the person did to both themes.
 *
 * Returns the patch to merge over the current design, or `null` when `target`
 * is already showing: clicking the lit button must not reset it either.
 */
export function switchTheme(design: Partial<SurveyDesign>, target: ThemeName): Partial<SurveyDesign> | null {
  const current = activeTheme(design);
  if (current === target) return null;

  const themes = { ...(design.themes ?? {}), [current]: pickPalette(design) };
  const next = themes[target] ?? presetPalette(target);
  return { ...paletteAsTopLevel(next), themes };
}

/**
 * Put `theme` back to its preset palette and forget what was saved for it.
 *
 * The only way left to throw a theme's colours away — deliberately, from the
 * Reset link, rather than by clicking a theme button.
 */
export function resetTheme(design: Partial<SurveyDesign>, theme: ThemeName): Partial<SurveyDesign> {
  const themes = { ...(design.themes ?? {}) };
  delete themes[theme];
  const patch: Partial<SurveyDesign> = { themes };
  // Resetting the theme on screen changes what is on screen; resetting the
  // other one only clears its saved colours.
  return activeTheme(design) === theme ? { ...paletteAsTopLevel(presetPalette(theme)), ...patch } : patch;
}

/** Что сделал {@link applyDesignChanges}: какую тему правили и какая теперь на экране. */
export interface DesignEdit {
  design: Partial<SurveyDesign>;
  /** Тема, чьи цвета изменились. */
  edited: ThemeName;
  /** Тема на экране после правки. */
  shown: ThemeName;
  /** Была на экране до правки, если правка её сменила (например, тёмным фоном). */
  replaced?: ThemeName;
}

/**
 * Правка дизайна, которая не теряет вторую тему.
 *
 * Раньше `design_update` писал цвета только на верхний уровень. Тёмный фон
 * переключал опрос в тёмную тему, а светлая палитра человека пропадала:
 * кнопка Light в кабинете возвращала пресет. А цвета тёмной темы, не
 * показывая её, задать было нельзя вовсе.
 *
 * - `theme` не задана или равна теме на экране — цвета ложатся на верхний
 *   уровень, как раньше. Если от этого сменилась тема (фон стал тёмным или
 *   светлым), прежняя палитра откладывается в `themes`, как при нажатии
 *   кнопки.
 * - `theme` — другая тема: её цвета правятся в `themes`, на экране ничего не
 *   меняется. Поля не про цвет (шрифт, логотип, раскладка) — всегда сверху:
 *   они принадлежат опросу, а не теме.
 */
export function applyDesignChanges(
  design: Partial<SurveyDesign>,
  changes: Record<string, unknown>,
  theme?: ThemeName,
): DesignEdit {
  const shownBefore = activeTheme(design);
  const colourFields = new Set<string>(THEME_COLOR_FIELDS);

  if (theme && theme !== shownBefore) {
    const colours: ThemePalette = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (colourFields.has(key)) (colours as Record<string, unknown>)[key] = value;
      else rest[key] = value;
    }
    const saved = design.themes?.[theme] ?? presetPalette(theme);
    return {
      design: { ...design, ...rest, themes: { ...(design.themes ?? {}), [theme]: { ...saved, ...colours } } },
      edited: theme,
      shown: shownBefore,
    };
  }

  const next: Partial<SurveyDesign> = { ...design, ...changes };
  const shownAfter = activeTheme(next);
  // Сохранённая копия темы на экране обновляется вместе с ней: устаревшая
  // `themes.light` рядом с новыми цветами сверху путала модель — что из
  // этого правда (прогон «после-2», S4). Копии нет — не заводим.
  const themes: Partial<Record<ThemeName, ThemePalette>> = { ...(design.themes ?? {}) };
  if (themes[shownAfter]) themes[shownAfter] = pickPalette(next);
  if (shownAfter === shownBefore) {
    return {
      design: design.themes ? { ...next, themes } : next,
      edited: shownBefore,
      shown: shownBefore,
    };
  }
  themes[shownBefore] = pickPalette(design);
  return { design: { ...next, themes }, edited: shownAfter, shown: shownAfter, replaced: shownBefore };
}

/** True when the theme on screen has colours of its own rather than the preset's. */
export function isCustomised(design: Partial<SurveyDesign>): boolean {
  const theme = activeTheme(design);
  const preset = presetPalette(theme);
  const current = pickPalette(design);
  return THEME_COLOR_FIELDS.some((field) => (current[field] ?? "").toUpperCase() !== (preset[field] ?? "").toUpperCase());
}

export interface BrandThemes {
  light: ThemePalette;
  dark: ThemePalette;
  notes: string[];
  contrastReport: { light: ContrastCheck[]; dark: ContrastCheck[] };
}

/**
 * The brand palette for both themes from one accent colour.
 *
 * One reading of the brand, two surfaces. `keepAccentIn` names the theme where
 * the accent must stay exactly as given — the one a person is looking at when
 * they name a colour ("make it #A4DE02" means that green, not a darker one).
 * The other theme is derived, nobody chose its accent, so a deep brand colour
 * is lifted there until it is visible on the dark background (or darkened on
 * the light one). Notes say which theme each note is about.
 */
export function buildBrandThemes({
  brandColor,
  keepAccentIn,
  roles,
}: {
  brandColor: string;
  keepAccentIn?: ThemeName;
  /** The site's colours by role – see BrandRoles; each theme takes what applies to it. */
  roles?: BrandRoles;
}): BrandThemes {
  const light = buildBrandDesign({ brandColor, mode: "light", keepAccent: keepAccentIn === "light", roles });
  const dark = buildBrandDesign({ brandColor, mode: "dark", keepAccent: keepAccentIn === "dark", roles });
  return {
    light: pickPalette(light.design),
    dark: pickPalette(dark.design),
    notes: [...light.notes.map((note) => `Light theme: ${note}`), ...dark.notes.map((note) => `Dark theme: ${note}`)],
    contrastReport: { light: light.contrastReport, dark: dark.contrastReport },
  };
}

/**
 * The patch that puts a brand into both themes and shows one of them — by
 * default the theme already on screen, so matching a brand never flips a dark
 * survey to light behind the person's back.
 */
export function applyBrandThemes(
  design: Partial<SurveyDesign>,
  brand: Pick<BrandThemes, "light" | "dark">,
  show: ThemeName = activeTheme(design),
): Partial<SurveyDesign> {
  return {
    ...paletteAsTopLevel(brand[show]),
    themes: { light: brand.light, dark: brand.dark },
  };
}
