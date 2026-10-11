/**
 * Low-level HTTP plumbing for the FeedBay API.
 *
 * Two things this layer owns and nothing above it repeats: unwrapping the
 * `ApiResponse<T>` envelope every controller returns, and surviving the
 * in-memory rate limiter (`RateLimitFilter`) that guards /auth, /export and
 * public submissions.
 */

export interface ApiErrorPayload {
  code?: string;
  message?: string;
  details?: Record<string, string>;
}

/** Envelope returned by every controller except /uploads/image. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorPayload;
}

/**
 * Hints for the error codes a caller can actually act on. Without these an LLM
 * client sees "ALREADY_PUBLISHED" and retries the same call forever.
 */
const ERROR_HINTS: Record<string, string> = {
  QUOTA_EXCEEDED:
    "The account's response quota is used up. Publishing and collecting responses stay blocked " +
    "until the quota resets or more responses are purchased. Check feedbay_whoami for the reset date.",
  // Бесплатный аккаунт публиковать не может (24.09.2026). Без подсказки модель
  // повторяла бы вызов или советовала «подождать сброса квоты».
  PLAN_REQUIRED:
    "Publishing needs a paid plan – the account is on the free plan. Do not retry. Tell the person they can " +
    "pick Core ($12/month, 500 responses) or Plus ($24/month, 1,500 responses) at feedbay.io/checkout-core or " +
    "feedbay.io/checkout-plus, or from the Publish dialog; the survey stays saved as a draft meanwhile.",
  NOT_ARCHIVED: "Permanent deletion only works on an archived item. Archive it first (survey_set_status / folder_set_status).",
  ALREADY_PUBLISHED: "The survey is already published – no action needed.",
  NOT_PUBLISHED: "The survey is not published, so it cannot be unpublished.",
  ALREADY_ARCHIVED: "The survey is already archived – no action needed.",
  FOLDER_ARCHIVED: "The destination folder is archived. Unarchive it first or pick another folder.",
  SURVEY_NOT_PUBLISHED: "The survey is not published, so it has no public page yet.",
  RATE_LIMIT_EXCEEDED: "The API rate limiter rejected this call. Wait for the window to pass and retry.",
  INVALID_CREDENTIALS:
    "The credentials do not match a FeedBay account. Check FEEDBAY_API_KEY " +
    "(Account \u2192 API keys), or FEEDBAY_EMAIL / FEEDBAY_PASSWORD for a service account.",
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(code: string, message: string, status: number, details?: Record<string, string>) {
    const hint = ERROR_HINTS[code];
    super(hint ? `${message} – ${hint}` : message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Pull `data` out of the envelope, or throw a typed error.
 *
 * `context` names the call so a failure reads as "publish survey failed: ..."
 * instead of a bare backend string.
 */
export function unwrap<T>(payload: unknown, context: string, status = 200): T {
  if (payload === null || typeof payload !== "object") {
    throw new ApiError("MALFORMED_RESPONSE", `${context}: API returned a non-object response`, status);
  }
  const envelope = payload as ApiResponse<T>;
  if (envelope.success === false || envelope.error) {
    const error = envelope.error ?? {};
    throw new ApiError(
      error.code ?? "UNKNOWN_ERROR",
      `${context}: ${error.message ?? "the API rejected the request"}`,
      status,
      error.details,
    );
  }
  if (!("success" in envelope)) {
    throw new ApiError("MALFORMED_RESPONSE", `${context}: response is not an ApiResponse envelope`, status);
  }
  return envelope.data as T;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number.parseInt(header, 10) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60) * 1000;
  return 2000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RawRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Extra headers; Authorization is added by the caller that owns the token. */
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON when the response was JSON, otherwise undefined. */
  json?: unknown;
  /** Raw bytes; populated for binary endpoints (QR code, exports). */
  bytes?: Uint8Array;
}

function buildUrl(baseUrl: string, path: string, query?: RawRequest["query"]): string {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Perform one API call, retrying only on 429 (the limiter tells us how long to
 * wait) and on transport failures, which are usually a restarting backend.
 */
export async function rawRequest(baseUrl: string, request: RawRequest, binary = false): Promise<RawResponse> {
  const url = buildUrl(baseUrl, request.path, request.query);
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          Accept: binary ? "*/*" : "application/json",
          ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...request.headers,
        },
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (cause) {
      if (attempt >= maxAttempts) {
        throw new ApiError(
          "NETWORK_ERROR",
          `${request.method} ${request.path} could not reach ${baseUrl}: ${(cause as Error).message}`,
          0,
        );
      }
      await sleep(500 * attempt);
      continue;
    }

    if (response.status === 429 && attempt < maxAttempts) {
      await sleep(retryAfterMs(response));
      continue;
    }

    if (binary && response.ok) {
      return {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    }

    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok && json === undefined) {
      throw new ApiError(
        "HTTP_ERROR",
        `${request.method} ${request.path} failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        response.status,
      );
    }

    return { status: response.status, headers: response.headers, json };
  }
}
