/**
 * Streamable HTTP-приложение — то, как удалённый агент дотягивается до FeedBay.
 *
 * Сервер многопользовательский: он не знает заранее ни одного аккаунта и не
 * держит ничьего пароля. Личность приезжает в каждом рукопожатии — ключом
 * `fb_live_…`, который владелец аккаунта выпустил себе сам и может отозвать, не
 * трогая ни сервер, ни чужие сессии. Поэтому один и тот же адрес обслуживает
 * сколько угодно разных аккаунтов одновременно, и подключение выглядит так:
 *
 *   claude mcp add --transport http feedbay https://mcp.feedbay.io/mcp \
 *     --header "Authorization: Bearer fb_live_..."
 *
 * Два правила, на которых это держится:
 *
 *   • ключ проверяется в бэкенде на `initialize`, до того как клиент увидит
 *     список инструментов, — отозванный ключ получает внятный отказ сразу, а не
 *     после выбора инструмента;
 *   • ключ привязывается к идентификатору сессии, и каждый следующий запрос
 *     обязан предъявить тот же ключ. Иначе угаданного или подсмотренного
 *     session id хватило бы, чтобы работать от чужого имени.
 *
 * Общий гейт-токен, стоявший здесь раньше, убран намеренно: он был единственным
 * пропуском к единственному аккаунту, то есть ровно тем, что мешало кому-то
 * ещё подключить свой.
 *
 * Claude (веб, десктоп, телефон) и ChatGPT передать ключ в заголовке не умеют:
 * они подключаются по адресу и входят через OAuth. Когда заданы публичный
 * адрес и секрет бэкенда, здесь же работает сервер авторизации (SDK MCP +
 * src/oauth/provider.ts), а токен доступа `fb_oat_…` принимается наравне с
 * ключом. Правила те же, только привязка сессии — к согласию, а не к токену:
 * токен меняется каждый час, согласие — нет.
 *
 * Приложение собирается без `listen` и без таймеров — их держит bin/http.ts.
 * Так тест поднимает его на случайном порту и подменяет проверку ключа.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { describeApiKey, type ApiKeyIdentity } from "./client/api-key.js";
import type { TokenSource } from "./client/auth.js";
import { ApiError } from "./client/http.js";
import { ToolTextSource } from "./client/tool-text.js";
import type { ApiConfig, HttpTransportConfig } from "./config.js";
import { OAuthBackend } from "./oauth/backend.js";
import { FeedBayOAuthProvider, OAUTH_SCOPES } from "./oauth/provider.js";
import { createServer } from "./server.js";
import type { ToolTextCatalogue } from "./tools/text-overrides.js";

const SESSION_HEADER = "mcp-session-id";
/** API-ключ из кабинета и токен доступа приложения, подключённого по OAuth. */
const CREDENTIAL_PREFIXES = ["fb_live_", "fb_oat_"];



/**
 * Сессия без единого запроса дольше этого закрывается.
 *
 * Клиенты почти никогда не шлют DELETE: закрыл человек вкладку claude.ai или
 * терминал — сессия осталась. Без выселения каждая такая сессия держала бы
 * свой McpServer в памяти до перезапуска процесса.
 */
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

/**
 * Сколько сессий держит один ключ.
 *
 * Лишняя не отклоняется, а вытесняет самую давнюю: клиент, который
 * переподключается в цикле и не закрывает старые сессии, иначе запер бы сам
 * себя на полчаса, до выселения по простою.
 */
const DEFAULT_MAX_SESSIONS_PER_KEY = 10;

/** Каталог описаний перечитывается не чаще раза в минуту. */
const TOOL_TEXT_TTL_MS = 60_000;

/**
 * За сколько до конца срока токен уже считается истёкшим.
 *
 * Запрос, пропущенный за секунду до срока, дошёл бы до API после него, и
 * инструмент упал бы на отказе. С запасом клиент обновит токен чуть раньше.
 */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Токен сессии, который можно сменить на лету.
 *
 * Клиент OAuth раз в час приходит с новым токеном доступа в той же сессии;
 * инструменты должны ходить в API уже с ним, а не с истёкшим.
 */
class SessionTokenSource implements TokenSource {
  private rejected = false;

  constructor(
    private token: string,
    private expiresAt: number | null,
  ) {}

  set(token: string, expiresAt: number | null): void {
    this.token = token;
    this.expiresAt = expiresAt;
    this.rejected = false;
  }

  /** Вышел ли срок (с запасом): клиенту пора обновить токен. */
  expired(now: number): boolean {
    return this.expiresAt !== null && now >= this.expiresAt - EXPIRY_MARGIN_MS;
  }

  /** API уже отказал этому токену посреди сессии. */
  get wasRejected(): boolean {
    return this.rejected;
  }

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  invalidate(): void {
    // API ответил 401: токен отозван или истёк раньше, чем ждали. Следующий
    // запрос сессии сверит его с бэкендом и получит 401, а по нему клиент
    // обновит токен или попросит человека войти заново.
    this.rejected = true;
  }
}

/** Сессия и учётка, которой она открыта. */
interface Session {
  transport: StreamableHTTPServerTransport;
  /**
   * Учётка: id ключа или id согласия OAuth. Сессия принадлежит ей, а не
   * конкретному токену — иначе ежечасная смена токена рвала бы её.
   */
  credentialId: string;
  /** SHA-256 последнего предъявленного токена: быстрый путь без сверки. */
  keyFingerprint: string;
  keyPrefix: string;
  tokens: SessionTokenSource;
  lastSeen: number;
  /**
   * Переложить новый текст инструментов на этот живой сервер.
   *
   * Держится на сессии, а не на процессе, потому что серверов здесь столько же,
   * сколько подключённых аккаунтов, и каждому нужно своё `tools/list_changed`.
   */
  updateToolText: (catalogue: ToolTextCatalogue | null) => number;
}

export interface HttpAppOptions {
  api: ApiConfig;
  http: HttpTransportConfig;
  /** Проверка ключа в бэкенде. По умолчанию — `GET /account/api-keys/current`. */
  describeKey?: (apiKey: string) => Promise<ApiKeyIdentity>;
  /**
   * Откуда брать правленые описания инструментов. `null` — только описания из
   * кода (так работают тесты: им нечем ходить в бэкенд за каталогом).
   */
  toolText?: ToolTextSource | null;
  /**
   * Состояние OAuth в бэкенде. По умолчанию строится из `http.publicUrl` и
   * `http.internalSecret`; `null` — OAuth выключен, только API-ключи.
   */
  oauthBackend?: OAuthBackend | null;
  idleTtlMs?: number;
  maxSessionsPerKey?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface HttpApp {
  app: Express;
  sessionCount(): number;
  /** Закрыть сессии, простаивающие дольше `idleTtlMs`. Возвращает, сколько закрыто. */
  sweepIdle(): Promise<number>;
  /** Перечитать каталог описаний, если есть чем. Зовётся по таймеру. */
  refreshToolText(): Promise<void>;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Сравнение отпечатков за постоянное время.
 *
 * Здесь это не перестраховка: отпечаток сессии сравнивается с отпечатком
 * предъявленного ключа на каждом запросе, и обычный `!==` даёт измеримую
 * разницу по времени на длинном общем префиксе.
 */
function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function extractApiKey(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix)) ? value : null;
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { api, http } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[feedbay-mcp] ${message}`));
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxSessionsPerKey = options.maxSessionsPerKey ?? DEFAULT_MAX_SESSIONS_PER_KEY;
  /**
   * Проверка учётки бэкендом — без памяти, намеренно.
   *
   * Спрашивается он редко: раз на открытие сессии и раз на смену токена
   * (дальше сессия узнаёт токен по отпечатку). А память хотя бы на минуту
   * пускала бы отозванный токен открывать новые сессии всю эту минуту.
   */
  const describeKey =
    options.describeKey ?? ((apiKey: string) => describeApiKey(api.apiUrl, apiKey, api.requestTimeoutMs));
  /** У старого бэкенда нет id учётки — тогда учётка и есть ключ. */
  const credentialOf = (identity: ApiKeyIdentity, apiKey: string) => identity.id ?? fingerprint(apiKey);
  /**
   * Срок токена из ответа бэкенда, в миллисекундах.
   *
   * Бэкенд отдаёт время без пояса, в своём поясе; на проде и он, и этот
   * процесс в UTC. Если пояса разъедутся, только что принятый бэкендом токен
   * покажется истёкшим, и клиент обновлял бы его по кругу. Такой срок не
   * берётся: о смерти токена сессия тогда узнает по отказу API.
   */
  const expiryOf = (identity: ApiKeyIdentity): number | null => {
    const at = identity.expiresAt ? Date.parse(identity.expiresAt) : Number.NaN;
    return Number.isFinite(at) && at - EXPIRY_MARGIN_MS > now() ? at : null;
  };

  const oauthBackend =
    options.oauthBackend !== undefined
      ? options.oauthBackend
      : http.publicUrl && http.internalSecret
        ? new OAuthBackend(api.apiUrl, http.internalSecret, api.requestTimeoutMs)
        : null;
  const resourceUrl = http.publicUrl ? new URL(`${http.publicUrl}/mcp`) : null;
  const resourceMetadataUrl = resourceUrl ? getOAuthProtectedResourceMetadataUrl(resourceUrl) : null;

  const app = express();
  const sessions = new Map<string, Session>();

  /**
   * Ключ, которым этот процесс читает настройки.
   *
   * Своей учётки у многопользовательского транспорта нет и быть не должно —
   * зато есть ключ ПОСЛЕДНЕГО аккаунта, который только что успешно прошёл
   * проверку в бэкенде. Каталог описаний общий для всех, разграничения по
   * аккаунтам у него нет, поэтому одолжить проверенный ключ здесь честно:
   * ничего чужого им не читается.
   *
   * Пока ни одна сессия не открылась, ключа нет — и настройки не читаются
   * вовсе. Это правильный порядок: до первого клиента их всё равно некому
   * показывать.
   */
  let borrowedKey: string | null = null;

  /**
   * Каталог описаний — один на процесс, а не на сессию.
   *
   * Текст инструментов общий для всех: он не про аккаунт, а про продукт.
   * Кеш на минуту, и на смену ревизии — рассылка `tools/list_changed` уже
   * открытым сессиям, чтобы правка вступала в силу без переподключения.
   * Не доехало — сессии открываются на описаниях из кода.
   */
  const toolText =
    options.toolText === undefined
      ? new ToolTextSource({
          apiUrl: api.apiUrl,
          token: () => borrowedKey,
          ttlMs: TOOL_TEXT_TTL_MS,
          timeoutMs: 2_000,
          warn: (message) => console.warn(`[feedbay-mcp] ${message}`),
          onChange: (snapshot) => {
            let touched = 0;
            for (const session of sessions.values()) touched += session.updateToolText(snapshot.tools);
            log(
              `tool text revision ${snapshot.revision}` +
                `${snapshot.enabled ? "" : " (overrides off)"}; ` +
                `${touched} tool descriptions updated across ${sessions.size} live sessions`,
            );
          },
        })
      : options.toolText;

  // Снаружи сервер стоит за nginx-proxy-manager в той же docker-сети: без
  // доверия к частным адресам все клиенты были бы для лимитов одним IP прокси.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  if (oauthBackend && resourceUrl && http.publicUrl) {
    const provider = new FeedBayOAuthProvider({
      backend: oauthBackend,
      appUrl: http.appUrl ?? "https://feedbay.io",
      resourceUrl,
      describeToken: describeKey,
    });
    // Метаданные (RFC 8414, RFC 9728), регистрация (RFC 7591), /authorize,
    // /token, /revoke — всё из SDK, со своими лимитами и CORS.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(http.publicUrl),
        resourceServerUrl: resourceUrl,
        scopesSupported: [...OAUTH_SCOPES],
        resourceName: "FeedBay",
        serviceDocumentationUrl: new URL("https://github.com/sanke46/feedbay-mcp#readme"),
        // Секрет клиентам не выдаётся вовсе (см. provider.ts), истекать нечему.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }),
    );
    // SDK отдаёт метаданные ресурса только по адресу с путём
    // (/.well-known/oauth-protected-resource/mcp). Часть клиентов спрашивает
    // корень — отвечаем и там тем же.
    app.use(
      "/.well-known/oauth-protected-resource",
      metadataHandler({
        resource: resourceUrl.href,
        authorization_servers: [new URL(http.publicUrl).href],
        scopes_supported: [...OAUTH_SCOPES],
        resource_name: "FeedBay",
      }),
    );
  }

  app.use(express.json({ limit: "12mb" }));
  // Браузерные клиенты (MCP Inspector, веб-IDE) должны видеть id сессии и
  // подсказку, где входить. Куки здесь не ходят — только Bearer, поэтому
  // открытый CORS ничего не раскрывает.
  app.use(
    "/mcp",
    cors({ exposedHeaders: [SESSION_HEADER, "WWW-Authenticate"], allowedHeaders: undefined }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", apiUrl: api.apiUrl, multiTenant: true, sessions: sessions.size });
  });

  /**
   * Origin-проверка — это защита от DNS rebinding, а не контроль доступа:
   * она мешает странице в браузере оператора управлять сервером на его же
   * машине. Кого пускать, решает ключ в каждом запросе.
   */
  app.use("/mcp", (req, res, next) => {
    const origin = req.header("origin");
    if (origin && !http.allowedOrigins.includes("*") && !http.allowedOrigins.includes(origin)) {
      jsonRpcError(res, 403, -32001, `Origin ${origin} is not allowed.`);
      return;
    }
    next();
  });

  /**
   * Лимиты по ключу, а не по IP.
   *
   * Подключения из claude.ai и ChatGPT приходят с адресов их серверов — тысячи
   * людей за одним IP. Лимит по адресу душил бы их всех разом за одного
   * активного. Поэтому обычные запросы считаются по отпечатку ключа, а по IP —
   * только неудачные рукопожатия: это и есть перебор ключей, и каждое такое
   * рукопожатие стоит запроса в бэкенд.
   */
  const limited = (res: Response) =>
    jsonRpcError(res, 429, -32000, "Too many requests to the FeedBay MCP server. Wait a minute and retry.");

  app.use(
    "/mcp",
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: (req) => {
        const apiKey = extractApiKey(req);
        return apiKey ? `key:${fingerprint(apiKey)}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
      },
      handler: (_req, res) => limited(res),
    }),
  );

  app.post(
    "/mcp",
    rateLimit({
      windowMs: 10 * 60_000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      // Не всякий 401 — перебор. Запрос без токена (так клиент OAuth узнаёт,
      // где входить) и истёкший токен в живой сессии бэкенд не трогают и идут
      // от каждого честного клиента; с общего IP claude.ai их хватило бы,
      // чтобы запереть всех.
      requestWasSuccessful: (_req, res) => res.locals.credentialRejected !== true,
      keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "")}`,
      handler: (_req, res) => limited(res),
    }),
  );

  /**
   * 401 с подсказкой, где входить (RFC 9728): по ней Claude и ChatGPT находят
   * метаданные и открывают человеку вход в FeedBay.
   */
  const unauthorized = (res: Response, message: string, invalidToken: boolean): void => {
    if (resourceMetadataUrl) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer ${invalidToken ? 'error="invalid_token", ' : ""}resource_metadata="${resourceMetadataUrl}"`,
      );
    }
    jsonRpcError(res, 401, -32001, message);
  };

  const closeSession = async (id: string, reason: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    log(`session ${id} closed: ${reason} (${sessions.size} active)`);
    await session.transport.close().catch(() => undefined);
  };

  /** Не дать одной учётке копить сессии без счёта — вытеснить самую давнюю. */
  const makeRoomFor = async (credentialId: string): Promise<void> => {
    const own = [...sessions.entries()]
      .filter(([, session]) => session.credentialId === credentialId)
      .sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
    for (const [id] of own.slice(0, Math.max(0, own.length - maxSessionsPerKey + 1))) {
      await closeSession(id, "too many sessions for one key");
    }
  };

  /**
   * Тот же ли владелец у сессии и у предъявленного токена.
   *
   * Тот же токен — быстрый путь, без бэкенда. Но если его срок вышел — 401
   * `invalid_token` сразу: иначе клиент так и слал бы истёкший токен, каждый
   * инструмент падал бы на отказе API, и до ручного переподключения сессия
   * была бы мёртвой. Тот же токен, которому API уже отказал, сверяется заново.
   *
   * Новый токен (клиент OAuth обновил его) сверяется с бэкендом: он обязан
   * принадлежать той же учётке, и тогда сессия продолжает работать уже с ним.
   * Чужая учётка — 403: это либо подставленный чужой session id, либо клиент,
   * сменивший ключ на лету; в обоих случаях правильный ответ — новая сессия,
   * а не чужая.
   */
  const sameCredential = async (session: Session, apiKey: string, res: Response): Promise<boolean> => {
    const presented = fingerprint(apiKey);
    if (sameFingerprint(session.keyFingerprint, presented)) {
      if (session.tokens.expired(now())) {
        unauthorized(res, "The access token has expired. Refresh it and retry.", true);
        return false;
      }
      if (!session.tokens.wasRejected) return true;
    }

    let identity: ApiKeyIdentity;
    try {
      identity = await describeKey(apiKey);
    } catch (error) {
      res.locals.credentialRejected = true;
      unauthorized(res, error instanceof ApiError ? error.message : "The token could not be verified.", true);
      return false;
    }
    if (credentialOf(identity, apiKey) !== session.credentialId) {
      jsonRpcError(res, 403, -32001, "This session belongs to a different API key.");
      return false;
    }
    session.keyFingerprint = presented;
    session.tokens.set(apiKey, expiryOf(identity));
    borrowedKey = apiKey;
    return true;
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      unauthorized(
        res,
        oauthBackend
          ? "Sign in to FeedBay: connect this server from your AI app, or send 'Authorization: Bearer fb_live_...'."
          : "Missing FeedBay API key. Send 'Authorization: Bearer fb_live_...'; " +
              "create a key in FeedBay under Account → API keys.",
        false,
      );
      return;
    }

    const sessionId = req.header(SESSION_HEADER);
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      if (!(await sameCredential(existing, apiKey, res))) return;
      existing.lastSeen = now();
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      // Сессии живут в памяти процесса, а процесс перезапускается на каждом
      // деплое. 404 на незнакомый id — сигнал по спецификации MCP: клиент сам
      // открывает новую сессию. Прежний 400 клиенты читали как поломку
      // сервера, и подключение умирало до ручного переподключения.
      if (sessionId) {
        jsonRpcError(res, 404, -32001, "Session not found. Start a new session with an initialize request.");
      } else {
        jsonRpcError(res, 400, -32000, "No active session. Send an initialize request first.");
      }
      return;
    }

    let identity: ApiKeyIdentity;
    try {
      identity = await describeKey(apiKey);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : `Could not verify the API key against ${api.apiUrl}.`;
      res.locals.credentialRejected = true;
      unauthorized(res, message, true);
      return;
    }

    // Ключ только что проверен бэкендом — значит им можно прочитать и
    // настройки. Первая же открывшаяся сессия снабжает этим процесс целиком.
    borrowedKey = apiKey;

    // Первая сессия ждёт каталог (ждать — значит «отдавать нечего»), все
    // последующие получают снимок мгновенно, а обновление уходит в фон:
    // рукопожатие, встающее на секунду из-за эндпоинта настроек, — плохой
    // размен. Логика «ждать только когда нечего отдать» живёт в самом
    // ToolTextSource, здесь ей ничего не противоречит.
    const catalogue = toolText ? await toolText.get(2_000) : null;

    const keyFingerprint = fingerprint(apiKey);
    const credentialId = credentialOf(identity, apiKey);
    const tokens = new SessionTokenSource(apiKey, expiryOf(identity));
    await makeRoomFor(credentialId);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          credentialId,
          keyFingerprint,
          keyPrefix: identity.keyPrefix,
          tokens,
          lastSeen: now(),
          updateToolText,
        });
        log(
          `session ${id} opened for ${identity.keyPrefix}…` +
            `${identity.readOnly ? " (read-only key)" : ""} (${sessions.size} active)`,
        );
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        log(`session ${id} closed (${sessions.size} active)`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    // Права ключа берутся из самого ключа, а не из окружения процесса: на одном
    // сервере одновременно живут сессии с разными правами, и общий флаг был бы
    // неверен для половины из них.
    const { server, updateToolText } = createServer(
      {
        ...api,
        readOnly: identity.readOnly,
        downloadDir: http.downloadDir,
        // Диск здесь НАШ и общий на все сессии, в отличие от stdio у человека
        // на его машине: путь из аргументов запирается в каталог.
        filesystemOwner: "server",
      },
      tokens,
      catalogue,
    );
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  /** GET открывает SSE-поток уведомлений, DELETE закрывает сессию. */
  const bySession = async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    const sessionId = req.header(SESSION_HEADER);
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      jsonRpcError(res, 404, -32001, "Unknown session id.");
      return;
    }
    if (!apiKey) {
      unauthorized(res, "Missing credentials for this session.", false);
      return;
    }
    if (!(await sameCredential(session, apiKey, res))) return;
    session.lastSeen = now();
    await session.transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  return {
    app,
    sessionCount: () => sessions.size,
    sweepIdle: async () => {
      const cutoff = now() - idleTtlMs;
      const idle = [...sessions.entries()].filter(([, session]) => session.lastSeen < cutoff);
      for (const [id] of idle) await closeSession(id, "idle");
      return idle.length;
    },
    refreshToolText: async () => {
      // Ключа ещё нет — читать настройки нечем и незачем: сессий тоже нет.
      if (!toolText || !borrowedKey) return;
      await toolText.refresh();
    },
  };
}
