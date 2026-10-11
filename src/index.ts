/**
 * Public surface of the package.
 *
 * Two consumers: the MCP binaries in `src/bin/`, and the FeedBay dashboard.
 * The dashboard's in-product assistant lives in `@feedbay/assistant`, a private
 * package on top of this one: this package is published, the assistant is not.
 * Both drive the same tools through the same client.
 */

export { ApiKeyTokenSource, LoginTokenSource, StaticTokenSource, type TokenSource } from "./client/auth.js";
export { FeedBayClient } from "./client/endpoints.js";
export { ApiError } from "./client/http.js";
export { loadConfig, type ApiConfig, type FeedBayConfig, type ToolRuntimeConfig } from "./config.js";

export {
  IMPORT_LIMITS,
  importedQuestionSchema,
  importedSurveySchema,
  sanitizeImportedText,
  type ImportedQuestion,
  type ImportedSurvey,
} from "./domain/import/schema.js";
export {
  normalizeImported,
  type ImportWarning,
  type ImportWarningCode,
  type NormalizedImport,
} from "./domain/import/normalize.js";
export { readTable, type Row } from "./domain/import/tabular.js";

export { ALL_TOOLS, createServer, tokenSourceFor, type BuiltServer } from "./server.js";
export {
  CONFIRMATION_REQUIRED_META,
  type MediaFile,
  type MediaResolver,
  type ToolContext,
  type ToolDefinition,
  type ToolHandles,
} from "./tools/shared.js";

export {
  COLOUR_GUIDANCE,
  SURVEY_WORKFLOW_GUIDANCE,
  THEME_GUIDANCE,
  TYPOGRAPHY_GUIDANCE,
  limitationsGuidance,
} from "./domain/guidance.js";

// Текст инструментов, правимый из админки. Экспортируется целиком, потому что
// им пользуются трое: маршрут чата (накладывает каталог на ход), маршрут
// `/ai/tool-catalog` (отдаёт экрану дефолты из кода) и сам экран (показывает,
// что именно получит модель).
export {
  TOOL_TEXT_LIMITS,
  applyToolText,
  catalogueSize,
  renderDescription,
  renderTitle,
  type ToolTextCatalogue,
  type ToolTextOverride,
} from "./tools/text-overrides.js";
export {
  ToolTextSource,
  type ToolTextSnapshot,
  type ToolTextSourceOptions,
} from "./client/tool-text.js";

// Обращение с чужим текстом. Нужно и обработчикам Next: `/ai/import` метит им
// разобранный документ, `/ai/brand` — материал с чужого сайта, и метка едет в
// журнал вызовов. Одна реализация на оба слоя намеренно — вторая разошлась бы
// с первой на первой же правке.
export {
  ForeignTextTally,
  MAX_FOREIGN_CHARS,
  TOOLS_RETURNING_FOREIGN_TEXT,
  fenceForeignText,
  foreignSourceOf,
  scanForInjection,
  type FencedText,
} from "./tools/untrusted.js";

export {
  EMAIL_DEGRADED_TYPES,
  SURVEY_CHANNELS,
  channelGuidance,
  isEmailInteractive,
  type SurveyChannelName,
} from "./domain/channels.js";
export { PRODUCT_LIMITATIONS, limitationsSentence, type ProductLimitation } from "./domain/capabilities.js";

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

// Чтение чужих страниц с защитой от SSRF: разбор бренда сайта, проверка
// ссылок на медиа. Нужно и инструментам (`brand_read_site`, медиа по ссылке),
// и обработчикам Next (`/ai/brand`, медиа в чате) — одна реализация на всех.
export {
  UnsafeUrlError,
  assertPublicHttps,
  fetchSite,
  isPrivateAddress,
  normalizeSiteUrl,
  __testing as FETCH_SITE_LIMITS,
  type FetchedSite,
  type ResolvedAddress,
  type Resolver,
} from "./web/fetch-site.js";
export { colorToHex, extractSignals, signalsAsText, type ColorPlace, type SiteSignals } from "./web/signals.js";
export { MAX_IMAGE_BYTES, resolveMediaUrl, type ResolvedMedia } from "./web/resolve-media-url.js";
export { MEDIA_PREFIX, isOwnMediaUrl, mediaFileName, urlMediaResolver } from "./web/media-resolver.js";
