/**
 * Reading and writing `Survey.config.questions[]`.
 *
 * The backend stores `config` as unvalidated jsonb and never looks inside it —
 * the dashboard is what defines the shape, and it saves the whole array on every
 * edit (`frontend/src/app/surveys/[id]/edit/page.tsx`). So every mutation here
 * is read-modify-write against a freshly fetched survey, and everything else in
 * `config` is preserved untouched.
 */

import type { Question, Survey } from "../types.js";
import { generateQuestionId, getDefaultConfig, getDefaultTitle } from "./question-defaults.js";
import { applyMediaPatch } from "./question-media.js";
import { normalizeQuestionConfig } from "./question-config.js";
import { resolveImportedType } from "./import/vocabulary.js";
import { canonicalizeQuestionType, isScreenType, type CanonicalQuestionType } from "./question-types.js";

export interface QuestionInput {
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  config?: Record<string, unknown>;
  /** Preserved when editing an existing question. */
  id?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge `patch` into `base` recursively. Arrays replace wholesale — a caller
 * sending `options: ["a"]` means "these are the options now", not "append".
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

/**
 * The type the caller meant, in its canonical spelling.
 *
 * Found by the tester (Trello c7lL3VJR): the assistant asked for `rating`,
 * survey_create failed with "Unknown question type", the model then read the
 * catalogue and retried. The survey came out right, but the person watched a
 * red error line for a product mistake, not theirs. The strict alias list is
 * the contract with the renderer (what may be STORED); the words a model says
 * are a wider set, and the import dictionary already maps them — "rating",
 * "stars", "paragraph", "checkboxes". Whatever comes out is canonical, so the
 * renderer contract is untouched. Unknown words still fail with the list.
 */
function resolveQuestionType(raw: string): CanonicalQuestionType {
  return resolveImportedType(raw) ?? canonicalizeQuestionType(raw);
}

/**
 * «2 questions (+2 screens)» — одна формула счёта на все инструменты. Раньше
 * survey_get считал экраны отдельно, а question_list — вместе с вопросами, и
 * модели спрашивали, какой из ответов верный (прогон «после-2», S5).
 */
export function countLine(questions: readonly Question[]): string {
  const screens = questions.filter((question) => isScreenType(question.type)).length;
  const asked = questions.length - screens;
  return screens > 0 ? `${asked} questions (+${screens} screens)` : `${asked} questions`;
}

/** The questions stored on a survey, or an empty list for a fresh one. */
export function readQuestions(survey: Survey): Question[] {
  const raw = (survey.config as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject).map((entry, index) => ({
    id: typeof entry.id === "string" ? entry.id : generateQuestionId(),
    type: typeof entry.type === "string" ? entry.type : "TEXT_ANSWER",
    title: typeof entry.title === "string" ? entry.title : "",
    description: typeof entry.description === "string" ? entry.description : undefined,
    required: entry.required === true,
    order: typeof entry.order === "number" ? entry.order : index,
    config: isPlainObject(entry.config) ? entry.config : {},
  }));
}

/**
 * Turn a caller's sketch of a question into the full stored shape: canonical
 * type, defaults for anything omitted, and the caller's config layered on top.
 */
/**
 * Заголовок экрана благодарности без явного title — его текст, а не
 * «New question» по умолчанию редактора (прогон 12.10: так назывался экран
 * в списке вопросов, и модели принимали это за ошибку).
 */
function screenTitle(type: CanonicalQuestionType, config: Record<string, unknown>): string | null {
  if (type !== "THANK_YOU") return null;
  return typeof config.message === "string" && config.message.trim() ? config.message.trim() : null;
}

export function buildQuestion(input: QuestionInput, order: number): Question {
  const type = resolveQuestionType(input.type);
  const config = normalizeQuestionConfig(
    type,
    applyMediaPatch(deepMerge(getDefaultConfig(type), input.config ?? {}), input.config),
    input.config ?? {},
  );
  return {
    id: input.id ?? generateQuestionId(),
    type,
    title: input.title?.trim() || screenTitle(type, config) || getDefaultTitle(type),
    ...(input.description ? { description: input.description } : {}),
    // Welcome and thank-you screens collect no answer, so requiring them is
    // meaningless — the editor hides the checkbox for exactly this reason.
    required: isScreenType(type) ? false : (input.required ?? false),
    order,
    config,
  };
}

/** Reassign `order` to match array position, as the editor does after any edit. */
export function renumber(questions: readonly Question[]): Question[] {
  return questions.map((question, index) => ({ ...question, order: index }));
}

/** A partial edit to an existing question; every field is optional. */
export type QuestionPatch = Partial<Omit<QuestionInput, "id">>;

/** Merge a partial edit into an existing question, keeping its id. */
export function patchQuestion(question: Question, patch: QuestionPatch): Question {
  // Only a patch that names a type can be canonicalised: questions already
  // stored may carry legacy spellings the vocabulary no longer lists, and
  // rejecting those would make an unrelated title edit impossible.
  const requestedType = patch.type ? resolveQuestionType(patch.type) : null;
  const type = requestedType ?? question.type;
  // Changing the type brings in that type's defaults; without them a rating
  // question turned into a choice question would have no options at all.
  const baseConfig =
    requestedType && requestedType !== question.type
      ? deepMerge(getDefaultConfig(requestedType), question.config)
      : question.config;

  const mergedConfig = normalizeQuestionConfig(
    type,
    patch.config ? applyMediaPatch(deepMerge(baseConfig, patch.config), patch.config) : baseConfig,
    patch.config ?? {},
  );

  return {
    ...question,
    type,
    title: patch.title?.trim() || question.title,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    required: isScreenType(type) ? false : (patch.required ?? question.required),
    config: withoutStaleTitleMarkup(mergedConfig, patch),
  };
}

/**
 * Снять разметку заголовка, если правят сам заголовок и не трогают разметку.
 *
 * <p>ПОЧЕМУ ЭТО ЯВНАЯ СТРОКА, А НЕ НАДЕЖДА НА СТОРОЖА. Разметка заголовка
 * лежит в `config.titleRich` парой `{html, text}`, и рендерер показывает её,
 * только если текст совпадает с `title`. То есть ассистент, поменявший
 * заголовок, ничего не сломает: респондент увидит новый текст без
 * оформления. Но в базе останется запись, которая уже никогда не совпадёт, —
 * мусор, который однажды кто-нибудь примет за правду. Дешевле убрать сразу.
 */
function withoutStaleTitleMarkup(
  config: Record<string, unknown>,
  patch: QuestionPatch,
): Record<string, unknown> {
  const titleChanged = typeof patch.title === "string" && patch.title.trim() !== "";
  const marksUpTitle =
    patch.config !== undefined &&
    Object.prototype.hasOwnProperty.call(patch.config, "titleRich");
  if (!titleChanged || marksUpTitle || config.titleRich === undefined) return config;

  const next = { ...config };
  delete next.titleRich;
  return next;
}

/** The `config` object to PUT: existing keys preserved, questions replaced. */
export function configWithQuestions(survey: Survey, questions: readonly Question[]): Record<string, unknown> {
  return { ...(survey.config ?? {}), questions: renumber(questions) };
}
