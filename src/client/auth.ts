/**
 * Where the bearer token for a FeedBay API call comes from.
 *
 * Three callers need different answers:
 *
 *   • an external agent presents a FeedBay API key (`fb_live_…`) issued by
 *     whoever owns the account — this is what lets anyone connect their own
 *     account from their own terminal;
 *   • the in-product assistant acts as whoever is logged into the dashboard and
 *     is handed that person's JWT — it must never be able to reach data the
 *     caller could not reach themselves;
 *   • a self-hosted deployment may still sign in with a service account's
 *     password, which is how this server worked before keys existed.
 *
 * All three go through `TokenSource`, so `FeedBayClient` and all 40 tools stay
 * identical between them.
 */

import { ApiError, rawRequest, unwrap } from "./http.js";

export interface TokenSource {
  /** A bearer token that is valid right now. */
  getAccessToken(): Promise<string>;
  /** Called after a 401, so the next attempt does not reuse the dead token. */
  invalidate(): void;
}

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  /** Seconds — `AuthService` divides the configured ms expiry by 1000. */
  expiresIn: number;
  user: unknown;
}

/**
 * A FeedBay API key, passed through unchanged.
 *
 * There is nothing to acquire and nothing to refresh: the backend's
 * `ApiKeyAuthFilter` accepts the key itself as the bearer token, which is the
 * whole point — no login round-trip, no rate limit shared between tenants, and
 * no password anywhere near an agent's config file.
 *
 * `invalidate()` deliberately does nothing. A 401 on a key means it was revoked
 * or expired; presenting it again cannot help, and clearing it would only turn
 * one honest failure into a confusing "no token" one.
 */
export class ApiKeyTokenSource implements TokenSource {
  constructor(private readonly apiKey: string) {}

  async getAccessToken(): Promise<string> {
    return this.apiKey;
  }

  invalidate(): void {
    // Nothing to invalidate — see the class comment.
  }
}

/** Renew this long before the token actually expires. */
const RENEW_MARGIN_MS = 60_000;

/**
 * Signs in with email and password and keeps the token alive.
 *
 * Logins are expensive here: `RateLimitFilter` allows 20 requests per 15
 * minutes against `/auth/**` per IP, and under the HTTP transport every chat
 * session shares one IP. So the token is cached for its whole 24h life,
 * refreshed ahead of expiry, and concurrent callers share one in-flight request.
 *
 * The backend's `JwtAuthFilter` prefers its HttpOnly cookie but falls back to
 * `Authorization: Bearer` for non-browser clients, and `/auth/login` returns the
 * JWT in the response body — so this needs no cookie jar at all.
 */
export class LoginTokenSource implements TokenSource {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly password: string,
    private readonly timeoutMs: number,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
      return this.accessToken;
    }
    this.inFlight ??= this.acquire().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Drop the cached token after a 401. The next call signs in again; callers
   * retry exactly once so a genuinely wrong password fails fast instead of
   * burning the login rate limit.
   */
  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async acquire(): Promise<string> {
    if (this.refreshToken) {
      try {
        return await this.exchange("/auth/refresh", { refreshToken: this.refreshToken });
      } catch {
        // A rotated-away or expired refresh token is normal; fall through to a
        // full login rather than surfacing it as the user's problem.
        this.refreshToken = null;
      }
    }
    return this.exchange("/auth/login", { email: this.email, password: this.password });
  }

  private async exchange(path: string, body: Record<string, string>): Promise<string> {
    const response = await rawRequest(this.baseUrl, {
      method: "POST",
      path,
      body,
      timeoutMs: this.timeoutMs,
    });
    const auth = unwrap<AuthResponse>(response.json, `sign in to FeedBay (${path})`, response.status);
    if (!auth?.accessToken) {
      throw new ApiError("AUTH_ERROR", `sign in to FeedBay (${path}): response carried no access token`, response.status);
    }
    this.accessToken = auth.accessToken;
    this.refreshToken = auth.refreshToken ?? null;
    this.expiresAt = Date.now() + (auth.expiresIn ?? 3600) * 1000;
    return auth.accessToken;
  }
}

/**
 * Wraps a token that was handed to us — the dashboard user's own JWT, read from
 * their `feedbay_access` cookie.
 *
 * It cannot refresh itself: the refresh cookie is scoped to
 * `/api/v1/auth/refresh` and never reaches an endpoint outside that path. So a
 * dead token is a dead end here, and the caller is told plainly to re-auth
 * rather than being left with a confusing 401 from somewhere deep in a tool.
 */
export class StaticTokenSource implements TokenSource {
  private expired = false;

  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    if (this.expired) {
      throw new ApiError(
        "SESSION_EXPIRED",
        "The signed-in session is no longer valid. Refresh the page and try again.",
        401,
      );
    }
    return this.token;
  }

  invalidate(): void {
    this.expired = true;
  }
}
