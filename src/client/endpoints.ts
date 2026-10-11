/**
 * Typed wrapper over every FeedBay endpoint this server touches.
 *
 * Tools call these methods and never build URLs themselves, so the auth header,
 * the envelope, and the 401-retry live in exactly one place.
 */

import type { ApiConfig } from "../config.js";
import type {
  Folder,
  Page,
  QuestionTypeCategory,
  ResponseLimit,
  ResultsOverview,
  ShareInfo,
  Survey,
  SurveyListItem,
  SurveyResponseItem,
  SurveyStats,
  SurveyTemplate,
  UserProfile,
} from "../types.js";
import type { TokenSource } from "./auth.js";
import { ApiError, rawRequest, unwrap, type RawRequest } from "./http.js";

export interface SurveyListParams {
  folderId?: string;
  status?: string;
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  size?: number;
}

export interface ResponseListParams {
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  size?: number;
  search?: string;
}

export interface SurveyWritePayload {
  name?: string;
  description?: string | null;
  channel?: string;
  displayMode?: string;
  questionType?: string;
  folderId?: string | null;
  config?: Record<string, unknown>;
  design?: Record<string, unknown>;
  targeting?: Record<string, unknown>;
}

export class FeedBayClient {
  constructor(
    private readonly config: ApiConfig,
    private readonly tokens: TokenSource,
  ) {}

  // ---------------------------------------------------------------- internals

  /**
   * Authenticated JSON call. A 401 means the cached token died early (password
   * change, server restart with a new secret) — drop it and retry exactly once.
   */
  private async call<T>(
    context: string,
    request: Omit<RawRequest, "timeoutMs" | "headers">,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.tokens.getAccessToken();
    const response = await rawRequest(this.config.apiUrl, {
      ...request,
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (response.status === 401 && retryOn401) {
      this.tokens.invalidate();
      return this.call<T>(context, request, false);
    }
    return unwrap<T>(response.json, context, response.status);
  }

  /** Unauthenticated call, for the public survey endpoints. */
  private async callPublic<T>(context: string, request: Omit<RawRequest, "timeoutMs" | "headers">): Promise<T> {
    const response = await rawRequest(this.config.apiUrl, {
      ...request,
      timeoutMs: this.config.requestTimeoutMs,
    });
    return unwrap<T>(response.json, context, response.status);
  }

  /** Authenticated call returning raw bytes (QR code, CSV/XLSX export). */
  private async callBinary(
    context: string,
    request: Omit<RawRequest, "timeoutMs" | "headers">,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const token = await this.tokens.getAccessToken();
    const response = await rawRequest(
      this.config.apiUrl,
      { ...request, headers: { Authorization: `Bearer ${token}` }, timeoutMs: this.config.requestTimeoutMs },
      true,
    );
    if (!response.bytes) {
      // Not binary after all — the backend answered with an error envelope.
      unwrap<never>(response.json, context, response.status);
      throw new ApiError("MALFORMED_RESPONSE", `${context}: expected binary content`, response.status);
    }
    return {
      bytes: response.bytes,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  // -------------------------------------------------------------- account

  getProfile(): Promise<UserProfile> {
    return this.call<UserProfile>("read the account profile", { method: "GET", path: "/auth/profile" });
  }

  getResponseLimit(): Promise<ResponseLimit> {
    return this.call<ResponseLimit>("read the response quota", { method: "GET", path: "/account/response-limit" });
  }

  // -------------------------------------------------------------- templates

  getTemplates(): Promise<{ templates: SurveyTemplate[]; total: number }> {
    return this.callPublic("list survey templates", { method: "GET", path: "/templates" });
  }

  getTemplate(id: string): Promise<SurveyTemplate> {
    return this.callPublic(`read template "${id}"`, { method: "GET", path: `/templates/${id}` });
  }

  getQuestionTypeCatalog(): Promise<QuestionTypeCategory[]> {
    return this.callPublic("list question types", { method: "GET", path: "/templates/question-types" });
  }

  // -------------------------------------------------------------- surveys

  listSurveys(params: SurveyListParams): Promise<Page<SurveyListItem>> {
    return this.call<Page<SurveyListItem>>("list surveys", { method: "GET", path: "/surveys", query: { ...params } });
  }

  getSurveyStats(folderId?: string): Promise<SurveyStats> {
    return this.call<SurveyStats>("read survey stats", { method: "GET", path: "/surveys/stats", query: { folderId } });
  }

  getSurvey(id: string): Promise<Survey> {
    return this.call<Survey>(`read survey ${id}`, { method: "GET", path: `/surveys/${id}` });
  }

  createSurvey(payload: SurveyWritePayload): Promise<Survey> {
    return this.call<Survey>("create the survey", { method: "POST", path: "/surveys", body: payload });
  }

  updateSurvey(id: string, payload: SurveyWritePayload): Promise<Survey> {
    return this.call<Survey>(`update survey ${id}`, { method: "PUT", path: `/surveys/${id}`, body: payload });
  }

  deleteSurvey(id: string): Promise<void> {
    return this.call<void>(`delete survey ${id}`, { method: "DELETE", path: `/surveys/${id}` });
  }

  permanentlyDeleteSurvey(id: string): Promise<void> {
    return this.call<void>(`permanently delete survey ${id}`, { method: "DELETE", path: `/surveys/${id}/permanent` });
  }

  surveyAction(id: string, action: "publish" | "unpublish" | "archive" | "unarchive"): Promise<Survey> {
    return this.call<Survey>(`${action} survey ${id}`, { method: "POST", path: `/surveys/${id}/${action}` });
  }

  duplicateSurvey(id: string): Promise<Survey> {
    return this.call<Survey>(`duplicate survey ${id}`, { method: "POST", path: `/surveys/${id}/duplicate` });
  }

  moveSurvey(id: string, folderId: string | null): Promise<Survey> {
    return this.call<Survey>(`move survey ${id}`, { method: "POST", path: `/surveys/${id}/move`, body: { folderId } });
  }

  getShareInfo(id: string): Promise<ShareInfo> {
    return this.call<ShareInfo>(`read share info for survey ${id}`, { method: "GET", path: `/surveys/${id}/share-info` });
  }

  /**
   * Конфиг, который виджет реально получит на чужой странице.
   *
   * Эндпоинт публичный и по publicId, а не по UUID: это то же самое, что
   * запросит браузер посетителя. Нужен, чтобы проверить установку глазами
   * виджета, а не дашборда — режим показа и триггер собираются здесь из
   * `targeting` отдельным кодом, и разойтись они могут молча.
   */
  getWidgetConfig(publicId: string): Promise<unknown> {
    return this.call<unknown>(`read the widget config for ${publicId}`, {
      method: "GET",
      path: `/public/widget/config/${publicId}`,
    });
  }

  getQrCode(id: string, size: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.callBinary(`render the QR code for survey ${id}`, {
      method: "GET",
      path: `/surveys/${id}/qr-code`,
      query: { size },
    });
  }

  // -------------------------------------------------------------- folders

  listFolders(archived: boolean): Promise<Folder[]> {
    return this.call<Folder[]>("list folders", { method: "GET", path: "/folders", query: { archived } });
  }

  createFolder(payload: Record<string, unknown>): Promise<Folder> {
    return this.call<Folder>("create the folder", { method: "POST", path: "/folders", body: payload });
  }

  updateFolder(id: string, payload: Record<string, unknown>): Promise<Folder> {
    return this.call<Folder>(`update folder ${id}`, { method: "PUT", path: `/folders/${id}`, body: payload });
  }

  folderAction(id: string, action: "archive" | "unarchive"): Promise<Folder> {
    return this.call<Folder>(`${action} folder ${id}`, { method: "POST", path: `/folders/${id}/${action}` });
  }

  permanentlyDeleteFolder(id: string): Promise<void> {
    return this.call<void>(`permanently delete folder ${id}`, { method: "DELETE", path: `/folders/${id}/permanent` });
  }

  // -------------------------------------------------------------- responses

  listResponses(surveyId: string, params: ResponseListParams): Promise<Page<SurveyResponseItem>> {
    return this.call<Page<SurveyResponseItem>>(`list responses for survey ${surveyId}`, {
      method: "GET",
      path: `/surveys/${surveyId}/responses`,
      query: { ...params },
    });
  }

  getResponse(surveyId: string, responseId: string): Promise<SurveyResponseItem> {
    return this.call<SurveyResponseItem>(`read response ${responseId}`, {
      method: "GET",
      path: `/surveys/${surveyId}/responses/${responseId}`,
    });
  }

  deleteResponse(surveyId: string, responseId: string): Promise<void> {
    return this.call<void>(`delete response ${responseId}`, {
      method: "DELETE",
      path: `/surveys/${surveyId}/responses/${responseId}`,
    });
  }

  getResultsOverview(surveyId: string): Promise<ResultsOverview> {
    return this.call<ResultsOverview>(`read results for survey ${surveyId}`, {
      method: "GET",
      path: `/surveys/${surveyId}/results/overview`,
    });
  }

  exportResponses(surveyId: string, format: "csv" | "excel"): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.callBinary(`export responses of survey ${surveyId} as ${format}`, {
      method: "GET",
      path: `/surveys/${surveyId}/export/${format}`,
    });
  }

  // -------------------------------------------------------------- uploads

  /**
   * Image upload is the one endpoint that breaks the `ApiResponse` convention:
   * it answers with a bare `{ url }` map, and errors as `{ error }`.
   * @see backend/src/main/java/com/feedbay/controller/UploadController.java
   */
  async uploadImage(bytes: Uint8Array, filename: string, mimeType: string, prefix: string): Promise<string> {
    const token = await this.tokens.getAccessToken();
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("prefix", prefix);

    const response = await fetch(`${this.config.apiUrl}/api/v1/uploads/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    const payload = (await response.json().catch(() => undefined)) as { url?: string; error?: string } | undefined;
    if (!response.ok || !payload?.url) {
      throw new ApiError(
        "UPLOAD_FAILED",
        `upload image "${filename}": ${payload?.error ?? `HTTP ${response.status}`}`,
        response.status,
      );
    }
    return payload.url;
  }

  // -------------------------------------------------------------- public API

  submitPublicResponse(publicId: string, body: Record<string, unknown>): Promise<SurveyResponseItem> {
    return this.callPublic<SurveyResponseItem>(`submit a response to survey ${publicId}`, {
      method: "POST",
      path: `/public/surveys/${publicId}/responses`,
      body,
    });
  }
}
