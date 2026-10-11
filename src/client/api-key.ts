/**
 * Проверка API-ключа перед тем, как открыть под него сессию MCP.
 *
 * HTTP-транспорт обслуживает не один аккаунт, а любого, кто предъявил свой
 * ключ, — значит личность нужно установить в момент рукопожатия, а не при
 * первом же вызове инструмента. Иначе клиент с отозванным ключом увидит список
 * из 40 инструментов, выберет один и только тогда получит 401: сообщение
 * приедет не туда и не тем, кому адресовано.
 *
 * Заодно отсюда берётся признак «только для чтения» — по нему сессия решает,
 * показывать ли изменяющие инструменты вообще.
 */

import { rawRequest, unwrap } from "./http.js";

export interface ApiKeyIdentity {
  /**
   * Учётка, которой открыта сессия: id ключа, а у OAuth — id согласия.
   * Согласие переживает ежечасную смену токена, поэтому сессия привязывается
   * к нему, а не к самому токену.
   */
  id?: string;
  /** `api_key` или `oauth`. */
  kind?: "api_key" | "oauth";
  /** Имя, которое владелец дал ключу (или имя подключённого приложения). Годится только для логов. */
  name: string;
  /** Видимое начало ключа — по нему владелец опознаёт его в дашборде. */
  keyPrefix: string;
  readOnly: boolean;
  /** Когда истекает предъявленный токен; у бессрочного ключа нет. */
  expiresAt?: string | null;
}

/**
 * @returns описание ключа, если он годен
 * @throws ApiError если ключ отозван, просрочен, неверен или API недоступен
 */
export async function describeApiKey(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<ApiKeyIdentity> {
  const response = await rawRequest(baseUrl, {
    method: "GET",
    path: "/account/api-keys/current",
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
  });

  // 404 здесь означает «авторизовано, но не ключом» — практически это JWT
  // дашборда. Бэкенд отдаёт его с телом, поэтому unwrap донесёт его текст,
  // а не превратит в безымянный HTTP_ERROR.
  return unwrap<ApiKeyIdentity>(response.json, "describing the API key", response.status);
}
