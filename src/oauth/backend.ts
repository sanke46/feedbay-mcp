/**
 * Внутренние эндпоинты OAuth бэкенда: `/internal/oauth/**`.
 *
 * Протокол OAuth здесь, в MCP-сервере (SDK MCP), а состояние — в бэкенде:
 * клиенты, согласия, коды и токены должны пережить перезапуск этого процесса,
 * а токены проверяются бэкендом на каждом запросе к API. Путь вне `/api` и
 * наружу не проксируется; общий секрет — второй замок.
 */

import {
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  OAuthError,
  ServerError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const SECRET_HEADER = "X-FeedBay-Internal";

export interface BackendTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

/** Ошибка бэкенда → ошибка OAuth, которую SDK отдаст клиенту по стандарту. */
function toOAuthError(code: string | undefined, message: string): OAuthError {
  switch (code) {
    case "INVALID_GRANT":
      return new InvalidGrantError(message);
    case "INVALID_CLIENT":
      return new InvalidClientError(message);
    case "INVALID_CLIENT_METADATA":
      return new InvalidClientMetadataError(message);
    case "UNSUPPORTED_GRANT_TYPE":
      return new UnsupportedGrantTypeError(message);
    case "INVALID_REQUEST":
      return new InvalidRequestError(message);
    default:
      return new ServerError(message);
  }
}

export class OAuthBackend {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/internal/oauth${path}`, {
        method,
        headers: {
          Accept: "application/json",
          [SECRET_HEADER]: this.secret,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ServerError(`FeedBay is not reachable: ${(error as Error).message}`);
    }

    const payload = (await response.json().catch(() => undefined)) as
      | { success?: boolean; data?: T; error?: { code?: string; message?: string } }
      | undefined;
    if (response.ok && payload?.success !== false) return payload?.data;
    if (response.status === 404 && method === "GET") return undefined;
    throw toOAuthError(payload?.error?.code, payload?.error?.message ?? `FeedBay answered ${response.status}`);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.call<OAuthClientInformationFull>("GET", `/clients/${encodeURIComponent(clientId)}`);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const saved = await this.call<OAuthClientInformationFull>("POST", "/clients", client);
    if (!saved) throw new ServerError("FeedBay did not confirm the client registration");
    return saved;
  }

  async startAuthorization(request: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scope?: string;
    resource?: string;
  }): Promise<string> {
    const started = await this.call<{ requestId: string }>("POST", "/authorizations", request);
    if (!started?.requestId) throw new ServerError("FeedBay did not open an authorization request");
    return started.requestId;
  }

  async token(request: {
    grantType: "authorization_code" | "refresh_token";
    clientId: string;
    code?: string;
    codeVerifier?: string;
    redirectUri?: string;
    resource?: string;
    refreshToken?: string;
  }): Promise<BackendTokens> {
    const tokens = await this.call<BackendTokens>("POST", "/token", request);
    if (!tokens) throw new ServerError("FeedBay did not issue tokens");
    return tokens;
  }

  async revoke(clientId: string, token: string): Promise<void> {
    await this.call("POST", "/revoke", { clientId, token });
  }
}
