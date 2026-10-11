/**
 * Что умеет и чего не умеет канал, в котором показывают опрос.
 *
 * ПОЧЕМУ ЭТО ЗНАНИЕ ВЫНЕСЕНО В ДОМЕН. Ассистент правит опрос, не видя, где
 * этот опрос живёт. Для ссылки и сайта разницы почти нет, а для письма она
 * решающая: в почте нет JavaScript, поэтому «интерактивным» там может быть
 * только то, что собирается ссылками с предзаполненным ответом. Матрица,
 * дата, форма контактов и длинный текст в письме превращаются в ссылку
 * «ответить на сайте» — то есть человек, собравший опрос для рассылки из
 * матриц, получит письмо, в котором отвечать нечем, и узнает об этом от
 * подписчиков.
 *
 * Список канонических типов здесь ДУБЛИРУЕТ бакеты почтового встраивания
 * (`frontend/src/lib/email-embed/render.ts`), и это осознанно: те бакеты
 * решают, каким шаблоном рисовать вопрос, и переписывать их ради общей
 * константы значит трогать код, чувствительный к Outlook. Вместо этого
 * расхождение сторожит тест совпадения — `email-channel-parity.test.ts`.
 */

import { findQuestionType, type CanonicalQuestionType } from "./question-types.js";

export const SURVEY_CHANNELS = ["LINK", "EMAIL", "WEBSITE"] as const;
export type SurveyChannelName = (typeof SURVEY_CHANNELS)[number];

/**
 * Типы, которые в письме остаются кликабельными: ответ уходит переходом по
 * ссылке с уже выбранным значением.
 */
const EMAIL_INTERACTIVE: ReadonlySet<CanonicalQuestionType> = new Set([
  "NPS",
  "CSAT",
  "CES",
  "RATING_SCALE",
  "SMILEY_SCALE",
  "YES_NO",
  "THUMB",
  "SINGLE_ANSWER",
  "MULTIPLE_ANSWER",
  "DROPDOWN",
]);

/** Остальные канонические типы — то, что в письме придётся дожимать на сайте. */
export const EMAIL_DEGRADED_TYPES: readonly CanonicalQuestionType[] = [
  "TEXT_ANSWER",
  "LONG_TEXT",
  "EMAIL",
  "DATE",
  "MATRIX",
  "CONTACT_FORM",
];

/**
 * Останется ли вопрос кликабельным в письме.
 *
 * <p>Принимает ЛЮБОЕ написание типа, а не только каноническое: сюда приходят
 * и `MULTIPLE_CHOICE` из старых опросов, и «single choice» из разбора
 * документа моделью.
 */
export function isEmailInteractive(type: string | undefined | null): boolean {
  if (!type) return false;
  const spec = findQuestionType(type);
  return spec ? EMAIL_INTERACTIVE.has(spec.type) : false;
}

/**
 * Строки для системного промпта — то, что ассистенту нужно знать про канал
 * открытого опроса.
 *
 * <p>Пусто для `LINK`: отдельная страница умеет всё, и лишний абзац в
 * промпте только разбавляет остальные правила.
 */
export function channelGuidance(channel: string | undefined | null): string[] {
  const name = (channel ?? "").toUpperCase();

  if (name === "EMAIL") {
    return [
      "",
      "This survey goes out by email. Email clients run no JavaScript, so only rating, NPS,",
      "CSAT, CES, smiley, yes/no, thumbs, choice and dropdown questions stay clickable in the",
      `message itself – ${EMAIL_DEGRADED_TYPES.join(", ")} turn into a "continue on the web" link.`,
      "Only the FIRST question is embedded in the email at all. Say this plainly when the person",
      "adds one of those types or expects the whole survey to be answerable inside the message.",
    ];
  }

  if (name === "WEBSITE") {
    return [
      "",
      "This survey runs as a widget on the customer's own site. It needs the install snippet",
      "(survey_install_snippet) on that site – a link alone shows nothing – and it must be",
      "published. targeting_update decides what makes it appear: immediately, after a delay, on",
      "scroll, on exit, on a click, or only when the page calls it.",
    ];
  }

  return [];
}
