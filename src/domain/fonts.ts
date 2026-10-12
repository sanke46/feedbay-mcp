/**
 * Шрифты, которые опрос может использовать.
 *
 * ВОСЕМЬ СЕМЕЙСТВ, И У КАЖДОГО ЕСТЬ КИРИЛЛИЦА — это решение заказчика и это
 * ограничение, а не вкусовщина. Шрифт без кириллицы молча съедает русский
 * текст на запасной системный, и опрос выглядит по-разному на разных машинах:
 * у одного респондента вопрос набран выбранным шрифтом, у другого — чем
 * придётся.
 *
 * СПИСОК ЗАКРЫТ НАМЕРЕННО. Файлы лежат у нас (CSP разрешает только
 * `font-src 'self' data:`), и каждое семейство — это четыре начертания,
 * которые надо положить в репозиторий. Открытый список означал бы либо
 * сторонний CDN, который политика не пустит, либо подкачку по требованию с
 * непредсказуемым весом.
 */

export interface SurveyFont {
  /** То, что уезжает в `design.fontFamily` и в CSS. */
  family: string;
  /** Как называется в выпадающем списке. */
  label: string;
  /** Грубая классификация — по ней подбирается замена ненайденному шрифту. */
  feel: "neutral" | "geometric" | "humanist" | "rounded" | "condensed";
}

export const SURVEY_FONTS: readonly SurveyFont[] = [
  { family: "Inter", label: "Inter", feel: "neutral" },
  { family: "Roboto", label: "Roboto", feel: "neutral" },
  { family: "Open Sans", label: "Open Sans", feel: "humanist" },
  { family: "Montserrat", label: "Montserrat", feel: "geometric" },
  { family: "Nunito", label: "Nunito", feel: "rounded" },
  { family: "PT Sans", label: "PT Sans", feel: "humanist" },
  { family: "Rubik", label: "Rubik", feel: "rounded" },
  { family: "Manrope", label: "Manrope", feel: "geometric" },
] as const;

export const DEFAULT_SURVEY_FONT = "Inter";

/** Есть ли такое семейство у нас. Сравнение без учёта регистра и пробелов. */
export function isSupportedFont(family: string | undefined | null): boolean {
  if (!family) return false;
  return SURVEY_FONTS.some((f) => sameName(f.family, family));
}

function sameName(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
}

/**
 * Ближайшее из восьми к тому, что нашлось на сайте.
 *
 * <p>Таблица, а не догадка по имени: у шрифта нет метаданных, по которым можно
 * было бы сопоставлять программно, зато самых частых на сайтах — десятки, и
 * назвать их руками честнее, чем притворяться, что мы умеем сравнивать
 * начертания.
 */
const NEAREST: Readonly<Record<string, string>> = {
  // Гротески без характера — ближе всего к Inter.
  helvetica: "Inter",
  helveticaneue: "Inter",
  arial: "Inter",
  sfpro: "Inter",
  sfprotext: "Inter",
  sfprodisplay: "Inter",
  segoeui: "Inter",
  system: "Inter",
  graphik: "Inter",
  suisse: "Inter",
  neuehaasgrotesk: "Inter",
  aktivgrotesk: "Inter",
  // Роботоподобные.
  robotocondensed: "Roboto",
  notosans: "Roboto",
  ibmplexsans: "Roboto",
  // Гуманистические.
  lato: "Open Sans",
  sourcesanspro: "Open Sans",
  sourcesans3: "Open Sans",
  ptsanscaption: "PT Sans",
  fira: "Open Sans",
  firasans: "Open Sans",
  // Геометрические.
  redhatdisplay: "Montserrat",
  redhattext: "Montserrat",
  poppins: "Montserrat",
  futura: "Montserrat",
  avenir: "Montserrat",
  avenirnext: "Montserrat",
  circular: "Manrope",
  gilroy: "Manrope",
  sofiapro: "Manrope",
  brandon: "Montserrat",
  spacegrotesk: "Manrope",
  // Скруглённые.
  quicksand: "Nunito",
  varelaround: "Nunito",
  comfortaa: "Nunito",
  dmsans: "Rubik",
  workSans: "Rubik",
};

export interface FontChoice {
  /** Что применяем. Всегда одно из восьми. */
  family: string;
  /** Что нашли на сайте, если это не то же самое. */
  requested?: string;
  /** Человеческое объяснение подмены — показывается прямо в строке Font. */
  note?: string;
}

/**
 * Выбрать шрифт по тому, что нашлось.
 *
 * <p>ПОДМЕНА ВСЕГДА ОБЪЯВЛЯЕТСЯ. Молчаливая подмена хуже отказа: человек видит
 * в карточке «Red Hat Display», жмёт Apply и получает Montserrat, не понимая,
 * что произошло и почему опрос не похож на сайт.
 */
export function chooseFont(detected: string | undefined | null): FontChoice {
  if (!detected || !detected.trim()) {
    return { family: DEFAULT_SURVEY_FONT };
  }
  const requested = detected.trim();
  if (isSupportedFont(requested)) {
    const exact = SURVEY_FONTS.find((f) => sameName(f.family, requested))!;
    return { family: exact.family };
  }
  const key = requested.replace(/\s+/g, "").toLowerCase();
  const nearest = NEAREST[key] ?? DEFAULT_SURVEY_FONT;
  return {
    family: nearest,
    requested,
    note: `${requested} isn't available – using ${nearest}, the closest of the fonts with Cyrillic support.`,
  };
}

/**
 * Системный шрифт с засечками. Среди восьми шрифтов FeedBay засечек нет, а
 * грузить свой нельзя (CSP пускает шрифты только с нашего домена). Georgia и
 * Times есть почти на всех устройствах и с кириллицей; на Android — serif.
 */
export const SYSTEM_SERIF_STACK = "Georgia, 'Times New Roman', serif";

const SERIF_NAMES =
  /serif|georgia|times|playfair|merriweather|lora|garamond|baskerville|crimson|cormorant|bodoni|didot|caslon|spectral|antiqua/i;

/**
 * Просят ли шрифт с засечками. chooseFont такой запрос заменил бы на Inter и
 * назвал «ближайшим» (прогон 12.10) — без засечек, то есть просьба не выполнена.
 */
export function wantsSerif(requested: string): boolean {
  return SERIF_NAMES.test(requested) && !/sans/i.test(requested);
}

/** Нарисует ли рендерер этот стек: один из восьми шрифтов или общий запасной в конце. */
export function isRenderableFont(stack: string): boolean {
  const families = stack.split(",").map((family) => family.trim().replace(/^['"]|['"]$/g, ""));
  const generic = /^(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif)$/i;
  return families.some((family) => isSupportedFont(family) || generic.test(family));
}
