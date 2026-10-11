/**
 * Что на самом деле лежит по ссылке, которую человек дал ассистенту для
 * медиа вопроса.
 *
 * НАЙДЕНО ТЕСТИРОВЩИКОМ (Trello QXZI4KJu, 25.09): ей нужна была фотография со
 * Unsplash, она дала ссылку на СТРАНИЦУ фотографии, и ассистент поставил в
 * вопрос какую-то другую картинку — адрес не проверял никто, а модель
 * «догадалась». Здесь ссылка проверяется сервером до того, как попасть в
 * опрос:
 *  - картинка — скачивается (с потолком) и перекладывается в наше хранилище:
 *    чужой хотлинк однажды протухнет, а у нас ещё и честный размер вместо «0 B»;
 *  - видео и аудио — не качаются (они большие), но тип и размер берутся из
 *    ответа сервера;
 *  - страница — берётся её `og:image`, та же картинка, которую показывают
 *    соцсети при расшаривании этой ссылки;
 *  - всё прочее — понятный отказ, а не молчаливая подмена.
 *
 * SSRF-защита общая с подбором бренда: `assertPublicHttps` на КАЖДОМ переходе.
 */

import { assertPublicHttps, UnsafeUrlError, type Resolver } from './fetch-site.js';
import { extractSignals } from './signals.js';

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** Потолок картинки — тот же, что у загрузки картинки на бэкенде (10 МБ). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;

export type ResolvedMedia =
  | { kind: 'image'; url: string; name: string; mimeType: string; bytes: Uint8Array }
  | { kind: 'video' | 'audio'; url: string; name: string; mimeType: string; sizeBytes: number };

function nameFrom(url: URL, fallback: string): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return last && last.length <= 120 ? last : fallback;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new UnsafeUrlError('That file is too large to use here (the limit is 10 MB).', 'TOO_LARGE');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** GET с проверкой каждого перехода; тело не читается — это решает вызывающий. */
async function fetchChecked(raw: string, resolve?: Resolver): Promise<{ response: Response; url: URL }> {
  let url = await assertPublicHttps(raw, ...(resolve ? ([resolve] as const) : ([] as const)));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/*,video/*,audio/*,text/html;q=0.8',
          'User-Agent': 'FeedBay-MediaBot/1.0 (+https://feedbay.io)',
        },
      });
    } catch {
      clearTimeout(timer);
      throw new UnsafeUrlError('That address did not answer in time.', 'SITE_UNREACHABLE');
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => {});
      if (!location) throw new UnsafeUrlError('That address answered with an incomplete redirect.', 'BAD_REDIRECT');
      url = await assertPublicHttps(new URL(location, url).toString(), ...(resolve ? ([resolve] as const) : ([] as const)));
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new UnsafeUrlError(`That address answered ${response.status}.`, 'SITE_ERROR');
    }
    return { response, url };
  }
  throw new UnsafeUrlError('That address redirects too many times.', 'TOO_MANY_REDIRECTS');
}

/**
 * @param depth страница может сослаться на картинку один раз — дальше не идём,
 *              чтобы цепочка страниц не водила сервер по чужим сайтам.
 */
export async function resolveMediaUrl(raw: string, resolve?: Resolver, depth = 0): Promise<ResolvedMedia> {
  const { response, url } = await fetchChecked(raw.trim(), resolve);
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

  if (mimeType.startsWith('image/')) {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new UnsafeUrlError('That image is too large to use here (the limit is 10 MB).', 'TOO_LARGE');
    }
    const bytes = await readCapped(response, MAX_IMAGE_BYTES);
    return { kind: 'image', url: url.toString(), name: nameFrom(url, 'image'), mimeType, bytes };
  }

  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    void response.body?.cancel().catch(() => {});
    return {
      kind: mimeType.startsWith('video/') ? 'video' : 'audio',
      url: url.toString(),
      name: nameFrom(url, mimeType.startsWith('video/') ? 'video' : 'audio'),
      mimeType,
      sizeBytes: Number(response.headers.get('content-length') ?? '0') || 0,
    };
  }

  if (mimeType.includes('html') && depth === 0) {
    const html = new TextDecoder('utf-8').decode(await readCappedPage(response));
    const image = extractSignals(html, url.toString()).ogImage;
    if (!image) {
      throw new UnsafeUrlError(
        'That link is a web page, not a picture, and the page has no preview image. Open the picture itself and copy its address, or attach the file.',
        'NOT_MEDIA',
      );
    }
    return resolveMediaUrl(new URL(decodeHtmlAttribute(image), url).toString(), resolve, depth + 1);
  }

  void response.body?.cancel().catch(() => {});
  throw new UnsafeUrlError(
    'That link is not an image, video or audio file. Copy the address of the file itself, or attach it.',
    'NOT_MEDIA',
  );
}

/**
 * Атрибут из HTML как есть: у Unsplash `og:image` — `…?w=1200&amp;q=60`, и без
 * декодирования параметры картинки уезжали бы в запрос с `amp;` в имени.
 */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'");
}

/** Страница читается до мегабайта: og:image всегда в <head>. */
async function readCappedPage(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
  }
  return merged;
}
