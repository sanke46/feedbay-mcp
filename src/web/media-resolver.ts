/**
 * Медиа вопроса по ссылке — одинаково для чата и для внешних MCP-клиентов.
 *
 * Ссылка проверяется сервером до того, как попасть в опрос (см.
 * resolve-media-url.ts): картинка перекладывается в наше хранилище, у видео и
 * аудио берутся тип и размер, у страницы — её og:image. Без этого внешний
 * клиент ставил бы в опрос чужой хотлинк, который однажды протухнет, или
 * страницу вместо картинки.
 *
 * Вложения из чата сюда не входят: их байты есть только у дашборда, и
 * `fromAttachment` он добавляет сам (frontend/src/lib/ai/chat-media.ts).
 */

import type { FeedBayClient } from "../client/endpoints.js";
import type { MediaResolver } from "../tools/shared.js";
import { resolveMediaUrl } from "./resolve-media-url.js";
import { UnsafeUrlError } from "./fetch-site.js";

/** Папка медиа вопросов в хранилище — та же, куда кладёт редактор. */
export const MEDIA_PREFIX = "media";

/** Бакет хранилища; адреса вида https://feedbay.io/uploads/feedbay-uploads/... */
const OWN_BUCKET_PATH = "/feedbay-uploads/";

export function isOwnMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const ownHost =
      host === "feedbay.io" || host.endsWith(".feedbay.io") || host === "localhost" || host === "127.0.0.1";
    return ownHost && url.pathname.includes(OWN_BUCKET_PATH);
  } catch {
    return false;
  }
}

function extensionFor(mimeType: string): string {
  const sub = mimeType.split("/")[1] ?? "png";
  return sub === "jpeg" ? "jpg" : sub.replace(/\+xml$/, "");
}

/** Имя с расширением: бэкенд и превью редактора судят о типе по нему. */
export function mediaFileName(name: string, mimeType: string): string {
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extensionFor(mimeType)}`;
}

export function urlMediaResolver(client: FeedBayClient): MediaResolver {
  return {
    isOwnUrl: isOwnMediaUrl,

    async fromUrl(raw: string) {
      try {
        const found = await resolveMediaUrl(raw);
        if (found.kind === "image") {
          const name = mediaFileName(found.name, found.mimeType);
          const url = await client.uploadImage(found.bytes, name, found.mimeType, MEDIA_PREFIX);
          return { kind: "image" as const, item: { url, name, sizeBytes: found.bytes.byteLength } };
        }
        return { kind: found.kind, item: { url: found.url, name: found.name, sizeBytes: found.sizeBytes } };
      } catch (error) {
        // Текст отказа — для модели, она перескажет его человеку.
        if (error instanceof UnsafeUrlError) throw new Error(`${raw}: ${error.message}`);
        throw error;
      }
    },
  };
}
