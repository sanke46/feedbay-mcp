/**
 * OAuth-провайдер для SDK MCP: вход в FeedBay из Claude, ChatGPT и прочих
 * клиентов, которые подключаются по адресу и передать ключ в заголовке не
 * умеют.
 *
 * SDK отвечает за протокол — метаданные (RFC 8414, RFC 9728), регистрацию
 * клиентов (RFC 7591), разбор `/authorize` и `/token`, формат ошибок. Провайдер
 * лишь переводит его вызовы в бэкенд, где живёт состояние, и отправляет
 * человека на страницу согласия в дашборде.
 */

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ApiKeyIdentity } from "../client/api-key.js";
import type { BackendTokens, OAuthBackend } from "./backend.js";

/** Права, которые клиент может попросить. Без просьбы — выбирает человек. */
export const OAUTH_SCOPES = ["feedbay:read", "feedbay:write"] as const;

/** Описание клиента читается на каждом `/authorize` и `/token` — кешируется на минуту. */
const CLIENT_CACHE_MS = 60_000;

export interface FeedBayOAuthOptions {
  backend: OAuthBackend;
  /** Дашборд: согласие даётся на `${appUrl}/connect/authorize`. */
  appUrl: string;
  /** Адрес ресурса, для которого выдаются токены: `${publicUrl}/mcp`. */
  resourceUrl: URL;
  /** Проверка токена бэкендом — та же, что для API-ключа. */
  describeToken: (token: string) => Promise<ApiKeyIdentity>;
}

function sameResource(requested: URL | undefined, ours: URL): boolean {
  if (!requested) return true;
  const strip = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return strip(requested) === strip(ours);
}

function toOAuthTokens(tokens: BackendTokens): OAuthTokens {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  };
}

export class FeedBayOAuthProvider implements OAuthServerProvider {
  /**
   * PKCE сверяет бэкенд — в одной транзакции с погашением кода. Сверка здесь
   * потребовала бы отдать наружу challenge и оставила бы окно между
   * проверкой и обменом, в которое код можно предъявить второй раз.
   */
  readonly skipLocalPkceValidation = true;

  private readonly clients = new Map<string, { client: OAuthClientInformationFull; at: number }>();

  constructor(private readonly options: FeedBayOAuthOptions) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const cached = this.clients.get(clientId);
        if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) return cached.client;
        const client = await this.options.backend.getClient(clientId);
        if (client) this.clients.set(clientId, { client, at: Date.now() });
        return client;
      },

      /**
       * Каждый клиент регистрируется публичным: без секрета, только PKCE.
       *
       * SDK сверяет секрет с хранимым в открытом виде, а держать в базе
       * чужие секреты в открытом виде мы не станем. Публичный клиент с PKCE
       * — штатный путь OAuth 2.1 для MCP; клиент, который всё равно пришлёт
       * секрет, пройдёт: секрета в записи нет, сверять нечего.
       */
      registerClient: async (client) => {
        const { client_secret: _secret, client_secret_expires_at: _expiry, ...rest } = client;
        const registered = await this.options.backend.registerClient({
          ...rest,
          client_id: (client as OAuthClientInformationFull).client_id,
          token_endpoint_auth_method: "none",
        } as OAuthClientInformationFull);
        this.clients.set(registered.client_id, { client: registered, at: Date.now() });
        return registered;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Токен выдаётся для одного ресурса — этого сервера. Клиент, просящий
    // токен «для другого адреса», получил бы пропуск, который мы не
    // проверяем как свой (RFC 8707).
    if (!sameResource(params.resource, this.options.resourceUrl)) {
      throw new InvalidTargetError(`This server issues tokens for ${this.options.resourceUrl.href} only`);
    }
    const requestId = await this.options.backend.startAuthorization({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scope: params.scopes && params.scopes.length > 0 ? params.scopes.join(" ") : undefined,
      resource: params.resource?.href ?? this.options.resourceUrl.href,
    });
    res.redirect(302, `${this.options.appUrl}/connect/authorize?request=${encodeURIComponent(requestId)}`);
  }

  async challengeForAuthorizationCode(): Promise<string> {
    // Не вызывается: skipLocalPkceValidation. Бросок — на случай, если SDK
    // однажды начнёт звать его всё равно: молча вернуть пустую строку значило
    // бы пропустить любой verifier.
    throw new Error("PKCE is verified by the FeedBay backend");
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!sameResource(resource, this.options.resourceUrl)) {
      throw new InvalidTargetError(`This server issues tokens for ${this.options.resourceUrl.href} only`);
    }
    return toOAuthTokens(
      await this.options.backend.token({
        grantType: "authorization_code",
        clientId: client.client_id,
        code,
        codeVerifier,
        redirectUri,
        resource: resource?.href,
      }),
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!sameResource(resource, this.options.resourceUrl)) {
      throw new InvalidTargetError(`This server issues tokens for ${this.options.resourceUrl.href} only`);
    }
    return toOAuthTokens(
      await this.options.backend.token({ grantType: "refresh_token", clientId: client.client_id, refreshToken }),
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const identity = await this.options.describeToken(token);
      return {
        token,
        clientId: identity.name,
        scopes: identity.readOnly ? ["feedbay:read"] : [...OAUTH_SCOPES],
        expiresAt: identity.expiresAt ? Math.floor(Date.parse(identity.expiresAt) / 1000) : undefined,
        resource: this.options.resourceUrl,
      };
    } catch (error) {
      throw new InvalidTokenError((error as Error).message);
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.options.backend.revoke(client.client_id, request.token);
  }
}
