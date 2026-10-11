/**
 * Runtime configuration, read once at startup.
 *
 * Everything the server needs to reach a FeedBay instance arrives through the
 * environment: MCP clients launch stdio servers with an env block, and the HTTP
 * transport runs as a container with the same variables.
 */

/**
 * What `FeedBayClient` needs to reach the API. Deliberately smaller than
 * `FeedBayConfig`: the in-product assistant has no service account, it carries
 * the caller's own token, so requiring credentials here would be a lie.
 */
export interface ApiConfig {
  /** Origin of the FeedBay API, without the /api/v1 prefix. */
  apiUrl: string;
  /** Per-request timeout for API calls, ms. */
  requestTimeoutMs: number;
}

/**
 * What a tool handler may read off the config. The in-product assistant has no
 * service account but still runs the same handlers, so this is the slice both
 * callers can honestly provide.
 */
export interface ToolRuntimeConfig extends ApiConfig {
  /** When true only read-only tools are available. */
  readOnly: boolean;
  /** Directory that `responses_export` writes files into. */
  downloadDir: string;
  /**
   * Чья файловая система под сервером.
   *
   * ЭТО НЕ ФЛАГ «СТРОГИЙ РЕЖИМ», а ответ на вопрос, от которого зависит смысл
   * пути в аргументах инструмента. Два инструмента берут путь из аргументов —
   * `design_upload_image` его читает, `responses_export` в него пишет, — и
   * сочиняет этот путь МОДЕЛЬ.
   *
   * `"caller"` — stdio у человека на его машине (Claude Desktop и подобные).
   * Файлы его собственные, доступ к ним у него и так есть, а «загрузи
   * ~/Downloads/logo.png» — обычный сценарий, ради которого локальный MCP и
   * существует. Запирать в каталог здесь значит сломать рабочее и ничего не
   * защитить.
   *
   * `"server"` — HTTP-транспорт и встроенный ассистент. Файловая система НАША
   * и общая на всех, а `design_upload_image` вдобавок публикует прочитанное в
   * открытый медиастор. Там произвольный путь — это раскрытие файлов сервера
   * по выбору модели, на которую влияет чужой текст.
   */
  filesystemOwner: "caller" | "server";
}

/**
 * How the stdio server proves who it is.
 *
 * A key is the normal case: it belongs to one person, it is revocable from the
 * dashboard, and it never puts a password into an agent's config. Email and
 * password remain for self-hosted deployments that predate keys.
 */
export type Credentials =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "password"; email: string; password: string };

export interface FeedBayConfig extends ToolRuntimeConfig {
  credentials: Credentials;
}

export interface HttpTransportConfig {
  port: number;
  /**
   * Куда `responses_export` кладёт файлы.
   *
   * Общий на все сессии: это диск процесса, а не данные аккаунта. Сам экспорт
   * ходит в API под ключом сессии, поэтому чужую выгрузку так не получить.
   */
  downloadDir: string;
  /**
   * Origins accepted on the Origin header; `*` disables the check.
   *
   * This is not access control — it is the DNS-rebinding guard, which stops a
   * page in someone's browser from driving a server running on their own
   * machine. Who may use the server is decided by the API key on each request.
   */
  allowedOrigins: string[];
  /**
   * Публичный адрес сервера, например `https://mcp.feedbay.io`.
   *
   * Вместе с {@link internalSecret} включает OAuth: метаданные, регистрацию
   * клиентов и вход через FeedBay. Так подключаются Claude (веб, десктоп,
   * телефон) и ChatGPT: заголовок с ключом они передать не умеют. Без этих
   * двух значений сервер принимает только API-ключи.
   */
  publicUrl?: string;
  /** Общий секрет с бэкендом для его внутренних эндпоинтов OAuth. */
  internalSecret?: string;
  /** Дашборд, где человек даёт согласие: `${appUrl}/connect/authorize`. */
  appUrl?: string;
}

class ConfigError extends Error {}

/**
 * Reads the credentials, preferring a key.
 *
 * Both present is not an error worth failing on: the key wins, because it is
 * the narrower grant of the two and picking the broader one on a tie would be
 * the wrong default.
 */
function loadCredentials(): Credentials {
  const apiKey = (process.env.FEEDBAY_API_KEY ?? "").trim();
  if (apiKey) {
    return { kind: "apiKey", apiKey };
  }

  const email = (process.env.FEEDBAY_EMAIL ?? "").trim();
  const password = process.env.FEEDBAY_PASSWORD ?? "";
  if (email && password) {
    return { kind: "password", email, password };
  }

  throw new ConfigError(
    "FEEDBAY_API_KEY is not set. Create a key in FeedBay under Account → API keys and export it:\n" +
      "  export FEEDBAY_API_KEY='fb_live_...'\n" +
      "(A self-hosted service account may use FEEDBAY_EMAIL + FEEDBAY_PASSWORD instead. " +
      "See docs/guides/MCP_SERVER.md.)",
  );
}

/**
 * Путь из окружения, если он там действительно есть.
 *
 * Установщик Claude Desktop подставляет настройки в окружение сам, и пустая
 * настройка приезжает пустой строкой, а не отсутствием переменной. Пустая
 * строка как каталог — это «текущий каталог хоста», который у Claude Desktop
 * может оказаться корнем диска. Неподставленный `${...}` — то же самое.
 */
function pathFromEnv(name: string): string | undefined {
  const value = (process.env[name] ?? "").trim();
  return value && !value.includes("${") ? value : undefined;
}

function boolFlag(name: string): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function intOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): FeedBayConfig {
  return {
    ...loadApiConfig(),
    credentials: loadCredentials(),
    readOnly: boolFlag("FEEDBAY_MCP_READONLY"),
    downloadDir: pathFromEnv("FEEDBAY_MCP_DOWNLOAD_DIR") ?? process.cwd(),
    // stdio запускает сам человек у себя — файлы его.
    filesystemOwner: "caller",
  };
}

/** The parts every caller needs, with no credentials attached. */
export function loadApiConfig(): ApiConfig {
  return {
    apiUrl: (process.env.FEEDBAY_API_URL ?? "https://feedbay.io").replace(/\/+$/, ""),
    requestTimeoutMs: intOr("FEEDBAY_MCP_TIMEOUT_MS", 30_000),
  };
}

export function loadHttpConfig(): HttpTransportConfig {
  const origins = (process.env.FEEDBAY_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const optional = (name: string) => {
    const value = (process.env[name] ?? "").trim();
    return value ? value.replace(/\/+$/, "") : undefined;
  };
  return {
    port: intOr("FEEDBAY_MCP_PORT", 3333),
    downloadDir: pathFromEnv("FEEDBAY_MCP_DOWNLOAD_DIR") ?? process.cwd(),
    allowedOrigins: origins.length > 0 ? origins : ["*"],
    publicUrl: optional("FEEDBAY_MCP_PUBLIC_URL"),
    internalSecret: (process.env.FEEDBAY_MCP_INTERNAL_SECRET ?? "").trim() || undefined,
    appUrl: optional("FEEDBAY_APP_URL") ?? "https://feedbay.io",
  };
}

export { ConfigError };
