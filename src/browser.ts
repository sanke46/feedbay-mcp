/**
 * Что из этого пакета можно импортировать в КОД БРАУЗЕРА.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Корневой `index.ts` экспортирует, среди
 * прочего, `createServer` — а тот тянет инструменты, а те `node:fs/promises`.
 * Пока из пакета брали только типы, это сходило с рук: типы стираются при
 * сборке. Но блок Typography начал брать оттуда ЗНАЧЕНИЯ — список шрифтов, —
 * и весь MCP-сервер поехал в клиентский бандл. Turbopack на это отвечает
 * «the chunking context does not support external modules (request:
 * node:fs/promises)», и страница редактора отдаёт 500.
 *
 * Здесь собрано только то, что не зависит от Node: справочник шрифтов,
 * пресеты и функции работы с цветом. Клиентские компоненты импортируют
 * `@feedbay/mcp-server/browser`, серверные маршруты — корень пакета, как и
 * раньше.
 */

export {
  DEFAULT_SURVEY_FONT,
  SURVEY_FONTS,
  chooseFont,
  isSupportedFont,
  type FontChoice,
  type SurveyFont,
} from "./domain/fonts.js";

export {
  PRESET_DARK_DESIGN,
  PRESET_LIGHT_DESIGN,
  buildBrandDesign,
  contrastRatio,
  ensureContrast,
  presetDesign,
  readableTextOn,
  themeOfBackground,
  type BrandPaletteOptions,
  type BrandRoles,
  type ContrastCheck,
  type GeneratedDesign,
} from "./domain/design.js";

export {
  THEME_COLOR_FIELDS,
  activeTheme,
  applyBrandThemes,
  buildBrandThemes,
  isCustomised,
  pickPalette,
  presetPalette,
  resetTheme,
  switchTheme,
  type BrandThemes,
  type ThemeName,
  type ThemePalette,
} from "./domain/themes.js";

export type { SurveyDesign } from "./types.js";

export {
  EMAIL_DEGRADED_TYPES,
  SURVEY_CHANNELS,
  isEmailInteractive,
  type SurveyChannelName,
} from "./domain/channels.js";

export { CANONICAL_TYPES, findQuestionType, type CanonicalQuestionType } from "./domain/question-types.js";

export { normalizeContactFields } from "./domain/question-config.js";
