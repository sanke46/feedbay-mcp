/**
 * Что в опросе сломается или удивит человека, хотя API всё принял.
 *
 * Прогон 12.10.2026 (screenshots/mcp-llm-matrix): все три модели пообещали
 * человеку звёзды у CSAT — сервер принял `style: "stars"`, а ссылка рисует
 * цифры; матрица на пять столбцов уезжает на телефоне вбок; кнопки русского
 * опроса остаются английскими. Сервер знал это и молчал. Предупреждения едут
 * в первой строке результата — её читает любой клиент, даже тот, что не
 * разбирает JSON.
 */

import type { Question } from "../types.js";
import { isScreenType } from "./question-types.js";

/** После скольких вопросов заметно падает доля дошедших до конца. */
const COMFORTABLE_QUESTIONS = 5;
/** Сколько столбцов матрицы помещается на экране телефона. */
const MATRIX_COLUMNS_ON_PHONE = 3;

/** Буква не латиницей или латиница с диакритикой: текст, скорее всего, не английский. */
function looksNonEnglish(text: string): boolean {
  return /(?=\p{L})\P{Script=Latin}/u.test(text) || /\p{M}/u.test(text.normalize("NFD"));
}

function textOf(question: Question): string[] {
  const options = Array.isArray(question.config?.options) ? (question.config.options as unknown[]).map(String) : [];
  return [question.title ?? "", question.description ?? "", ...options];
}

export function surveyWarnings(questions: readonly Question[]): string[] {
  const warnings: string[] = [];
  const asked = questions.filter((question) => !isScreenType(question.type));

  if (asked.length > COMFORTABLE_QUESTIONS) {
    warnings.push(
      `${asked.length} questions: completion drops sharply after about five, so keep them all only if the person ` +
        "asked for every one.",
    );
  }

  for (const question of asked) {
    const style = question.config?.style;
    if ((question.type === "CSAT" || question.type === "CES") && typeof style === "string") {
      warnings.push(
        `"${question.title}": the survey link page draws ${question.type} as numbers – the ${style} style shows ` +
          `only in the website widget. For ${style} everywhere use RATING_SCALE with style "${style}".`,
      );
    }
    if (question.type === "MATRIX") {
      const columns = Array.isArray(question.config?.columns) ? (question.config.columns as unknown[]).length : 0;
      if (columns > MATRIX_COLUMNS_ON_PHONE) {
        warnings.push(
          `"${question.title}": ${columns} columns do not fit a phone screen – the table scrolls sideways. ` +
            `${MATRIX_COLUMNS_ON_PHONE} columns or fewer fit.`,
        );
      }
    }
  }

  if (questions.some((question) => textOf(question).some(looksNonEnglish))) {
    warnings.push(
      "The survey's own buttons and hints (Next, Back, Submit, Other, \"Type your answer...\") stay in English – " +
        "FeedBay has no survey language setting yet. Tell the person; the start button and the thank-you text " +
        "can be written in their language.",
    );
  }

  return warnings;
}

/** Строка для первой строки результата: пусто, если сказать нечего. */
export function warningLine(warnings: readonly string[]): string {
  return warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : "";
}
