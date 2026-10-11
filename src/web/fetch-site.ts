import { lookup } from 'node:dns/promises';

/**
 * Забрать публичную страницу по адресу, который дал пользователь.
 *
 * ЭТО САМОЕ ОПАСНОЕ МЕСТО ВО ВСЁМ БЛОКЕ B, и опасность не теоретическая: адрес
 * вводит человек, а запрос уходит С НАШЕГО СЕРВЕРА — то есть изнутри сети, где
 * стоят Postgres, Redis, ClickHouse и MinIO, ни один из которых наружу не
 * смотрит. Поле «website URL» без проверок означает буквально «сходи вот на
 * этот внутренний адрес и покажи, что там».
 *
 * ЧЕСТНАЯ ОГОВОРКА ПРО ПРЕДЕЛ ЭТОЙ ЗАЩИТЫ. Имя проверяется до запроса, а
 * соединение устанавливает fetch — между проверкой и соединением имя может
 * разрешиться в другой адрес (DNS rebinding). Закрыть это полностью можно
 * только своим сокетом с прибитым адресом, чего undici из коробки не даёт.
 * Проверка снимает подавляющее большинство случаев, но airtight она не
 * является, и делать вид, что является, нельзя.
 */

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Диапазоны, в которые ходить нельзя. */
export function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const v6 = address.toLowerCase();
    // Отображённый IPv4 — проверяем как IPv4, иначе ::ffff:10.0.0.1 пройдёт.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!, 4);
    if (v6 === '::1' || v6 === '::') return true;
    // fc00::/7 — уникальные локальные, fe80::/10 — link-local.
    if (/^f[cd]/.test(v6)) return true;
    if (/^fe[89ab]/.test(v6)) return true;
    return false;
  }

  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // не разобрали — значит не пускаем
  }
  // Четыре октета проверены выше.
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, включая метаданные облака
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast и зарезервированное
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * Как разрешается имя.
 *
 * <p>Вынесено параметром, а не зовётся напрямую, ради тестируемости: подменять
 * модуль {@code node:dns/promises} целиком ради одной функции — способ,
 * который ломается о собственный учёт необработанных отказов в тестовом
 * прогоне. Явная зависимость честнее и короче.
 */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) => lookup(hostname, { all: true });

/** Разобрать адрес и отказать всему, что не публичный https. */
export async function assertPublicHttps(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a valid address.', 'INVALID_URL');
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only https addresses can be inspected.', 'NOT_HTTPS');
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await resolve(url.hostname);
  } catch {
    throw new UnsafeUrlError('That address does not resolve.', 'DNS_FAILED');
  }
  // ВСЕ адреса имени, а не первый: имя может отдавать и публичный, и частный,
  // и выбор между ними от нас не зависит.
  if (resolved.some((r) => isPrivateAddress(r.address, r.family))) {
    throw new UnsafeUrlError('That address points inside a private network.', 'PRIVATE_ADDRESS');
  }
  return url;
}

export interface FetchedSite {
  url: string;
  html: string;
  truncated: boolean;
}

/**
 * Забрать страницу, проверяя КАЖДЫЙ переход.
 *
 * <p>Автоматическое следование за переадресацией здесь выключено намеренно:
 * публичный адрес, переадресующий на `http://169.254.169.254/`, — это классика,
 * и проверка только первого адреса от неё не спасает.
 */
/**
 * Адрес сайта так, как его пишут люди: `company.com`, `www.company.com/about`,
 * `http://company.com`. Схема — всегда https (Trello MoggvCGt, 25.09: голый
 * домен падал с INVALID_URL и в блоке, и в чате). Всё, что уже со своей
 * схемой, кроме http, остаётся как есть — `ftp://` и `file://` по-прежнему
 * отвергнет assertPublicHttps.
 */
export function normalizeSiteUrl(raw: string): string {
  const value = raw.trim();
  if (/^http:\/\//i.test(value)) return `https://${value.slice(7)}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/:]+:\d+(\/|$)/.test(value)) return value;
  return `https://${value.replace(/^\/\//, '')}`;
}

export async function fetchSite(raw: string, resolve: Resolver = systemResolver): Promise<FetchedSite> {
  let url = await assertPublicHttps(normalizeSiteUrl(raw), resolve);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'FeedBay-BrandBot/1.0 (+https://feedbay.io)',
        },
      });
    } catch {
      clearTimeout(timer);
      throw new UnsafeUrlError('That site did not answer in time.', 'SITE_UNREACHABLE');
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new UnsafeUrlError('That site answered with an incomplete redirect.', 'BAD_REDIRECT');
      }
      url = await assertPublicHttps(new URL(location, url).toString(), resolve);
      continue;
    }

    if (!response.ok) {
      throw new UnsafeUrlError(`That site answered ${response.status}.`, 'SITE_ERROR');
    }

    const html = await readCapped(response);
    return { url: url.toString(), html: html.text, truncated: html.truncated };
  }

  throw new UnsafeUrlError('That site redirects too many times.', 'TOO_MANY_REDIRECTS');
}

/**
 * Читать с потолком.
 *
 * <p>Content-Length можно не прислать или соврать, поэтому считаются реально
 * прочитанные байты. Без этого один ответ на гигабайт кладёт процесс Next,
 * который обслуживает весь дашборд.
 */
async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_BYTES)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(merged), truncated };
}

export const __testing = { MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS };
