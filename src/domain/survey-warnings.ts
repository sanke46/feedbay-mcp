/**
 * Что в опросе сломается или удивит человека, хотя API всё принял.
 *
 * Прогон 12.10.2026 (screenshots/mcp-llm-matrix): кнопки русского опроса
 * остаются английскими, длинный опрос теряет людей — сервер знал это и
 * молчал. Предупреждения едут в первой строке результата — её читает любой
 * клиент, даже тот, что не разбирает JSON.
 *
 * Звёзд CSAT и матрицы на телефоне здесь больше нет: ссылка рисует CSAT/CES
 * выбранным стилем, а матрица на узком экране перестраивается в строки
 * (frontend question-type-mapper, renderer.css @container). Ложное
 * предупреждение хуже молчания: в прогоне «после» модели меняли CSAT на
 * шкалу и теряли метрику CSAT.
 */

import type { Question } from "../types.js";
import { isScreenType } from "./question-types.js";

/** «0–10», «0 to 10», «del 0 al 10», «von 0 bis 10», «de 0 à 10», «de 0 a 10», «от 0 до 10». */
const ZERO_TO_TEN = /(^|[^\d])0\s*(?:[-–—]|to|al|a|à|bis|até|до)\s*10(?!\d)/iu;

/** После скольких вопросов заметно падает доля дошедших до конца. */
const COMFORTABLE_QUESTIONS = 5;

/** Буква не латиницей или латиница с диакритикой: текст, скорее всего, не английский. */
function looksNonEnglish(text: string): boolean {
  return /(?=\p{L})\P{Script=Latin}/u.test(text) || /\p{M}/u.test(text.normalize("NFD"));
}

function looksCyrillic(text: string): boolean {
  return /\p{Script=Cyrillic}/u.test(text);
}

function textOf(question: Question): string[] {
  const options = Array.isArray(question.config?.options) ? (question.config.options as unknown[]).map(String) : [];
  return [question.title ?? "", question.description ?? "", ...options];
}

export function surveyWarnings(questions: readonly Question[], locale?: string): string[] {
  const warnings: string[] = [];
  const asked = questions.filter((question) => !isScreenType(question.type));

  if (asked.length > COMFORTABLE_QUESTIONS) {
    warnings.push(
      `${asked.length} questions: completion drops sharply after about five, so keep them all only if the person ` +
        "asked for every one.",
    );
  }

  // NPS в FeedBay – шкала 1–10 (решение по продукту 24.07.2026), а модели по
  // привычке пишут «от 0 до 10»: так в коротком прогоне матрицы все три
  // испанских опроса спрашивали «Del 0 al 10» над кнопками 1–10.
  const npsSaysZero = questions.some(
    (question) => question.type === "NPS" && ZERO_TO_TEN.test(`${question.title ?? ""} ${question.description ?? ""}`),
  );
  if (npsSaysZero) {
    warnings.push(
      'The NPS question text names a 0-10 range, but FeedBay shows 1-10 with no 0: change it to "1 to 10" in ' +
        "the person's language, or drop the range.",
    );
  }

  // Кнопки и подсказки опроса – на языке `design.locale`. Предупреждаем, только
  // если текст не английский, а язык не выставлен под него: русский текст
  // получает совет про ru, остальные – про es/de/fr/pt.
  const text = questions.flatMap(textOf);
  const unset = locale === undefined || locale === "en";
  if (locale !== "ru" && text.some(looksCyrillic)) {
    warnings.push(
      'The questions are in Russian but the buttons and hints (Next, Back, Other, placeholders) are English: ' +
        'set the survey language with design_update locale "ru".',
    );
  } else if (unset && text.some(looksNonEnglish)) {
    warnings.push(
      "The text looks non-English but the buttons and hints (Next, Back, Other) are English: if the survey " +
        'is in Spanish, German, French or Portuguese, set design_update locale "es", "de", "fr" or "pt". ' +
        "Other languages keep English buttons; tell the person.",
    );
  }

  return warnings;
}

/** Строка для первой строки результата: пусто, если сказать нечего. */
export function warningLine(warnings: readonly string[]): string {
  return warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : "";
}
