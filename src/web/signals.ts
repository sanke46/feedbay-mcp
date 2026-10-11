/**
 * Что сайт объявил о себе сам.
 *
 * ГРАНИЦА ЭТОГО ПОДХОДА НАЗВАНА ПРЯМО, и её надо понимать до того, как читать
 * код: снимка страницы у нас нет и взять его нечем — ни headless-браузера, ни
 * сервиса скриншотов в проекте не существует. Значит мы читаем НЕ ТО, КАК САЙТ
 * ВЫГЛЯДИТ, а то, что он о себе НАПИСАЛ: цвет темы, социальную картинку,
 * иконку, объявленные шрифты и цвета из инлайновых стилей.
 *
 * На сайтах, где всё собрано сборщиком в отдельный файл стилей, сигналов будет
 * мало — и тогда честнее сказать человеку «нашли немного, попробуйте
 * картинкой», чем выдумать палитру. Источник «brand image» точнее всегда,
 * потому что картинку модель видит по-настоящему.
 *
 * Разбор регулярками, а не разметки целиком: cheerio и jsdom в проекте нет, а
 * тянуть их ради пяти тегов — лишняя зависимость в образе фронтенда. Для
 * `<meta>` и `<link>` этого достаточно, и ничего сложнее мы не ищем.
 */

export interface SiteSignals {
  title: string | null;
  themeColor: string | null;
  ogImage: string | null;
  icon: string | null;
  fonts: string[];
  colors: string[];
  /**
   * Цвета по месту на странице — сырьё для ролей (Trello UoJ7SfQx): фон
   * страницы, текст, кнопки, ссылки, поверхности, CSS-переменные. Модель
   * решает роль по тому, ГДЕ цвет стоит, а не по тому, что он встретился.
   */
  colorGroups: Record<ColorPlace, string[]>;
  /** Подключённые файлы стилей (https, первые несколько) — для второго прохода. */
  stylesheets: string[];
}

export type ColorPlace = 'page background' | 'text' | 'buttons' | 'links' | 'surfaces' | 'variables';

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
/** Сколько файлов стилей забирать: больше — дольше, а цвета бренда в первых. */
const MAX_STYLESHEETS = 3;
const PER_GROUP = 5;

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** `#abc`, `#aabbcc`, `rgb(…)`, `rgba(…)`, `hsl(…)` → `#aabbcc`; прозрачное и прочее — null. */
export function colorToHex(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})\b/);
  if (hex) {
    const digits = hex[1]!;
    const h = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
    return `#${h}`;
  }
  const fn = value.match(/^(rgba?|hsla?)\(([^)]*)\)/);
  if (!fn) return null;
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts[3] !== undefined ? parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1) : 1;
  if (alpha < 0.5) return null; // полупрозрачное — тень или наложение, не цвет бренда
  if (fn[1]!.startsWith('rgb')) {
    // Не меньше трёх частей проверено выше.
    const [r, g, b] = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p))) as [
      number,
      number,
      number,
    ];
    if ([r, g, b].some(Number.isNaN)) return null;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const h = (((parseFloat(parts[0]!) % 360) + 360) % 360) / 360;
  const sat = parseFloat(parts[1]!) / 100;
  const l = parseFloat(parts[2]!) / 100;
  if ([h, sat, l].some(Number.isNaN)) return null;
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return `#${hex2(channel(h + 1 / 3) * 255)}${hex2(channel(h) * 255)}${hex2(channel(h - 1 / 3) * 255)}`;
}

const COLOR_VALUE = /#[0-9a-fA-F]{3,6}\b|(?:rgba?|hsla?)\([^)]*\)/g;

/** Куда отнести объявление по селектору и свойству. null — не говорит о бренде. */
function placeOf(selector: string, property: string): ColorPlace | null {
  const sel = selector.toLowerCase();
  const isBackground = property.startsWith('background');
  if (/(^|[\s,>])(button|\.btn|\.button|\[type=["']?submit|\.wp-block-button|\.cta)/.test(sel) || /btn|button|cta/.test(sel)) {
    return 'buttons';
  }
  if (/(^|[\s,])(html|body|:root|main)(\b|$)/.test(sel)) return isBackground ? 'page background' : 'text';
  if (/(^|[\s,>])a(\b|:|\.|$)/.test(sel)) return 'links';
  if (/(^|[\s,>])(h[1-6]|p|li|span)(\b|$)/.test(sel)) return isBackground ? null : 'text';
  if (isBackground && /card|panel|section|field|input|box|tile|surface/.test(sel)) return 'surfaces';
  if (property === 'border-color' && /card|input|field/.test(sel)) return 'surfaces';
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1]!.trim() : null;
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function extractSignals(html: string, base: string, extraCss = ''): SiteSignals {
  const head = html.slice(0, 200_000);

  const title = head.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim() ?? null;

  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  let themeColor: string | null = null;
  let ogImage: string | null = null;
  for (const tag of metas) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (!content) continue;
    if (name === 'theme-color' && !themeColor) themeColor = content;
    if ((name === 'og:image' || name === 'twitter:image') && !ogImage) ogImage = content;
  }

  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  let icon: string | null = null;
  const stylesheets: string[] = [];
  const fonts = new Set<string>();
  for (const tag of links) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    if (!icon && /\b(apple-touch-icon|icon)\b/.test(rel)) icon = href;
    if (/\bstylesheet\b/.test(rel) && !href.includes('fonts.googleapis.com') && stylesheets.length < MAX_STYLESHEETS) {
      const sheet = absolute(href, base);
      if (sheet) stylesheets.push(sheet);
    }
    // Подключение Google Fonts — самый надёжный сигнал о шрифте, какой вообще
    // бывает: там имя семейства стоит прямо в адресе.
    if (href.includes('fonts.googleapis.com')) {
      for (const m of href.matchAll(/family=([^&:]+)/g)) {
        fonts.add(decodeURIComponent(m[1]!).replace(/\+/g, ' ').trim());
      }
    }
  }

  // Инлайновые стили: объявления шрифтов и цвета.
  const styles = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi)?.join('\n') ?? '';
  const inlineStyleAttrs = (html.match(/style\s*=\s*["'][^"']*["']/gi) ?? []).join('\n');
  const css = `${styles}\n${inlineStyleAttrs}\n${extraCss}`.slice(0, 600_000);

  for (const m of css.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
    const first = m[1]!.split(',')[0]!.replace(/["']/g, '').trim();
    // Родовые имена — не бренд, а запасной вариант.
    if (first && !/^(sans-serif|serif|monospace|system-ui|inherit|initial|-apple-system)$/i.test(first)) {
      fonts.add(first);
    }
  }
  for (const m of css.matchAll(/@font-face[\s\S]{0,400}?font-family\s*:\s*["']?([^;"'}]+)/gi)) {
    const name = m[1]!.trim();
    if (name) fonts.add(name);
  }

  // Все цвета — по частоте. Чёрный и белый больше не выбрасываются: у многих
  // сайтов это и есть текст и фон, а роль решает модель по месту (UoJ7SfQx).
  const frequency = new Map<string, number>();
  for (const m of css.matchAll(COLOR_VALUE)) {
    const value = colorToHex(m[0]);
    if (value) frequency.set(value, (frequency.get(value) ?? 0) + 1);
  }
  const colors = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([value]) => value);

  const groups: Record<ColorPlace, Map<string, number>> = {
    'page background': new Map(),
    text: new Map(),
    buttons: new Map(),
    links: new Map(),
    surfaces: new Map(),
    variables: new Map(),
  };
  const add = (place: ColorPlace, value: string) => groups[place].set(value, (groups[place].get(value) ?? 0) + 1);
  for (const rule of css.matchAll(/([^{}@;]{1,300})\{([^{}]{0,4000})\}/g)) {
    const selector = rule[1]!.trim();
    for (const decl of rule[2]!.matchAll(/(--[\w-]+|color|background(?:-color)?|border-color|fill)\s*:\s*([^;]+)/gi)) {
      const property = decl[1]!.toLowerCase();
      const found = decl[2]!.match(COLOR_VALUE);
      const value = found ? colorToHex(found[0]) : null;
      if (!value) continue;
      if (property.startsWith('--')) {
        // Имя переменной — подсказка роли: --primary, --accent, --text, --bg.
        if (/(primary|accent|brand|main|text|foreground|background|bg|base|surface|contrast|secondary)/.test(property)) {
          add('variables', `${property}: ${value}`);
        }
        continue;
      }
      const place = placeOf(selector, property);
      if (place) add(place, value);
    }
  }
  const colorGroups = Object.fromEntries(
    Object.entries(groups).map(([place, map]) => [
      place,
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, PER_GROUP).map(([value]) => value),
    ]),
  ) as Record<ColorPlace, string[]>;

  return {
    title,
    themeColor,
    ogImage: absolute(ogImage, base),
    icon: absolute(icon, base),
    fonts: [...fonts].slice(0, 8),
    colors,
    colorGroups,
    stylesheets,
  };
}

/** Сигналы одним куском текста — то, что уезжает модели. */
export function signalsAsText(signals: SiteSignals, url: string): string {
  const lines = [
    `Site: ${url}`,
    signals.title ? `Title: ${signals.title}` : null,
    signals.themeColor ? `Declared theme-color: ${signals.themeColor}` : null,
    signals.fonts.length ? `Declared font families: ${signals.fonts.join(', ')}` : null,
    signals.colors.length ? `Colours found in the CSS, most used first: ${signals.colors.join(', ')}` : null,
    ...Object.entries(signals.colorGroups)
      .filter(([, values]) => values.length > 0)
      .map(([place, values]) => `Colours used for ${place}: ${values.join(', ')}`),
    signals.icon ? `Icon: ${signals.icon}` : null,
    signals.ogImage ? `Social image: ${signals.ogImage}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}
