/**
 * Shapes the FeedBay API actually returns.
 *
 * Mirrors `frontend/src/lib/api/types.ts` — that file is the live contract the
 * dashboard runs against, and the backend stores `config`/`design`/`targeting`
 * as unvalidated jsonb, so the frontend's reading of them is the only source of
 * truth there is.
 */

export type SurveyStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type SurveyChannel = "WEBSITE" | "EMAIL" | "LINK";
export type DisplayMode =
  | "STANDARD"
  | "EMBED"
  | "POPUP_CENTER"
  | "POPUP_TOP"
  | "POPUP_BOTTOM"
  | "SLIDE_IN_LEFT"
  | "SLIDE_IN_RIGHT"
  | "SIDE_TAB"
  | "POPOVER";

/** One entry of `Survey.config.questions[]`. */
export interface Question {
  id: string;
  type: string;
  title: string;
  description?: string;
  required: boolean;
  order: number;
  config: Record<string, unknown>;
}

export interface SurveyDesign {
  logo?: string;
  backgroundImage?: string;
  questionColor: string;
  answerColor: string;
  answerTextColor: string;
  answerUnselectedColor?: string;
  answerUnselectedTextColor?: string;
  answerBackgroundColor?: string;
  /** 0-100. */
  answerBackgroundOpacity?: number;
  progressColor: string;
  buttonColor: string;
  buttonTextColor: string;
  backgroundColor: string;
  showBranding: boolean;
  /**
   * Applied by the renderer as CSS variables but absent from the design tab in
   * the dashboard — reachable only through the API.
   * @see packages/survey-renderer/src/applyDesign.ts
   */
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  borderRadius?: number;
  /** One question per screen, or all of them on one page. Default "one". */
  questionLayout?: "one" | "all";
  /**
   * Each theme's colours as the person left them. The top level is always the
   * theme on screen; this keeps the other one. See domain/themes.ts.
   */
  themes?: Partial<Record<ThemeName, ThemePalette>>;
}

export type ThemeName = "light" | "dark";

/** The colour fields of one theme — see THEME_COLOR_FIELDS in domain/themes.ts. */
export interface ThemePalette {
  questionColor?: string;
  answerColor?: string;
  answerTextColor?: string;
  answerUnselectedColor?: string;
  answerUnselectedTextColor?: string;
  answerBackgroundColor?: string;
  progressColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  backgroundColor?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

export interface Survey {
  id: string;
  publicId: string;
  name: string;
  description: string | null;
  status: SurveyStatus;
  channel: SurveyChannel;
  displayMode: DisplayMode | null;
  questionType: string | null;
  config: Record<string, unknown>;
  design: Record<string, unknown>;
  targeting: Record<string, unknown>;
  responseCount: number;
  folderId: string | null;
  folderName: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  purgeAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SurveyListItem {
  id: string;
  publicId: string;
  name: string;
  status: SurveyStatus;
  channel: SurveyChannel;
  responseCount: number;
  folderId: string | null;
  updatedAt: string;
  design?: Record<string, unknown>;
}

export interface SurveyStats {
  total: number;
  published: number;
  draft: number;
  archived: number;
}

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
  first: boolean;
  last: boolean;
  empty: boolean;
}

export interface Folder {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isDefault: boolean;
  sortOrder: number;
  surveyCount: number;
  responseCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SurveyResponseItem {
  id: string;
  surveyId: string;
  responseNumber: number | null;
  visitorId: string | null;
  sessionId: string | null;
  answers: Record<string, unknown>;
  metadata: Record<string, unknown>;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  referrer: string | null;
  /** Response-level channel: `web` | `qr` | `widget`. Not `Survey.channel`. */
  channel: string | null;
  createdAt: string;
  countryCode: string | null;
  countryName: string | null;
  device: "MOBILE" | "DESKTOP" | null;
  durationSeconds: number | null;
  durationFormatted: string | null;
}

export interface ResultsOverview {
  surveyId: string;
  surveyName: string;
  totalResponses: number;
  completedResponses: number;
  completionRate: number;
  /**
   * Ступени воронки. Необязательные: бэкенд без миграции V21 их не пришлёт,
   * а соврать агенту нулями хуже, чем не ответить вовсе.
   */
  viewedCount?: number;
  startedCount?: number;
  viewToStartRate?: number;
  startToCompleteRate?: number;
  averageCompletionTimeSeconds: number;
  questionStats: unknown[];
}

export interface ShareInfo {
  publicId: string;
  publicUrl: string;
  qrCodeUrl: string;
  embedCode: string;
}

export interface ResponseLimit {
  used: number;
  total: number;
  remaining: number;
  resetDate: string | null;
  /**
   * Безлимит. При нём `total` и `remaining` равны 1 000 000 000 — страховка
   * бэкенда на потребителя, не знающего про флаг. Мы знаем: сообщать модели
   * «999,999,900 left» значит врать ей правдоподобным числом.
   */
  unlimited?: boolean;
  /** Остановлен ли сбор. Считает сервер, чтобы правило жило в одном месте. */
  exhausted?: boolean;
  /**
   * Может ли аккаунт публиковать (PublishAccessService на бэкенде). Нет поля —
   * старый бэкенд, который этого не сообщает.
   */
  canPublish?: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  provider: "LOCAL" | "GOOGLE";
}

export interface TemplateQuestion {
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  options: string[] | null;
  config: Record<string, unknown> | null;
}

export interface SurveyTemplate {
  id: string;
  name: string;
  description: string;
  color: string;
  category: string;
  questions: TemplateQuestion[];
}

export interface QuestionTypeCategory {
  id: string;
  name: string;
  questions: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    iconColor: string;
  }>;
}
