/**
 * Таблицы разбираются без модели.
 *
 * CSV и XLSX — единственные форматы, где структура уже есть: колонки названы,
 * строки разделены. Гонять их через модель значило бы платить деньгами и
 * временем за то, что и так однозначно, и получать в ответ фантазии там, где
 * возможен точный разбор. Поэтому тут детерминированный путь, и квота за него
 * не списывается.
 *
 * Два случая. Первый — сетка вопросов: в шапке есть колонка с текстом вопроса,
 * одна строка = один вопрос. Второй — выгрузка ответов из другого сервиса, где
 * вопросы стоят колонками, а строки это ответы людей; тип тогда выводится из
 * самих значений.
 */

import { importedSurveySchema, type ImportedSurvey } from "./schema.js";
import type { ImportWarning } from "./normalize.js";

export type Row = readonly string[];

const TITLE_HEADERS = ["question", "title", "prompt", "вопрос", "текст вопроса"];
const TYPE_HEADERS = ["type", "question type", "тип", "тип вопроса"];
const REQUIRED_HEADERS = ["required", "mandatory", "обязательный", "обязательно"];
const DESCRIPTION_HEADERS = ["description", "help", "hint", "описание", "подсказка"];
const OPTIONS_HEADERS = ["options", "answers", "choices", "варианты", "ответы"];

const TRUTHY = new Set(["1", "true", "yes", "y", "да", "истина", "required", "обязательный"]);

/** Меньше двух вариантов в строке — это не выбор, а случайно занятая ячейка. */
const MIN_GRID_OPTIONS = 2;

/** Сколько различных коротких значений ещё похоже на список вариантов. */
const MAX_INFERRED_OPTIONS = 8;
/** Длиннее этого значение читается как свободный текст, а не как вариант. */
const MAX_INFERRED_OPTION_LENGTH = 40;

const norm = (value: string): string => value.trim().toLowerCase();

function indexOfHeader(header: Row, names: readonly string[]): number {
  return header.findIndex((cell) => names.includes(norm(cell)));
}

/** `option 1`, `вариант 2`, `choice3` — пронумерованные колонки вариантов. */
function numberedOptionColumns(header: Row): number[] {
  const pattern = /^(option|choice|answer|вариант|ответ)\s*\d+$/;
  return header
    .map((cell, index) => (pattern.test(norm(cell)) ? index : -1))
    .filter((index) => index >= 0);
}

function splitOptions(cell: string): string[] {
  return cell
    .split(/[;|]|,(?=\s)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function dropEmptyRows(rows: readonly Row[]): Row[] {
  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

/**
 * Сетка вопросов: одна строка — один вопрос.
 * @returns `null`, если в шапке нет колонки с текстом вопроса
 */
function readQuestionGrid(rows: readonly Row[]): ImportedSurvey | null {
  const [header, ...body] = rows;
  if (!header) return null;

  const titleAt = indexOfHeader(header, TITLE_HEADERS);
  if (titleAt < 0) return null;

  const typeAt = indexOfHeader(header, TYPE_HEADERS);
  const requiredAt = indexOfHeader(header, REQUIRED_HEADERS);
  const descriptionAt = indexOfHeader(header, DESCRIPTION_HEADERS);
  const optionsAt = indexOfHeader(header, OPTIONS_HEADERS);
  const numbered = numberedOptionColumns(header);

  const questions = body
    .map((row) => {
      const title = (row[titleAt] ?? "").trim();
      if (!title) return null;

      const options = [
        ...(optionsAt >= 0 ? splitOptions(row[optionsAt] ?? "") : []),
        ...numbered.map((index) => (row[index] ?? "").trim()).filter((value) => value.length > 0),
      ];

      // Колонки с типом может не быть, но строка с вариантами ответа — это
      // заведомо выбор, а не свободный текст. Считать иначе значит разобрать
      // файл и молча выбросить из него варианты.
      const declaredType = typeAt >= 0 ? (row[typeAt] ?? "").trim() : "";
      const fallbackType = options.length >= MIN_GRID_OPTIONS ? "SINGLE_ANSWER" : "TEXT_ANSWER";

      return {
        title,
        type: declaredType || fallbackType,
        ...(descriptionAt >= 0 && (row[descriptionAt] ?? "").trim()
          ? { description: (row[descriptionAt] ?? "").trim() }
          : {}),
        required: requiredAt >= 0 ? TRUTHY.has(norm(row[requiredAt] ?? "")) : false,
        ...(options.length > 0 ? { options } : {}),
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null);

  if (questions.length === 0) return null;

  // `safeParse`, а не `parse`, и это не вкусовщина. `readTable` зовут из
  // маршрута ВНЕ try, а у обработчика нет внешнего catch, поэтому ZodError
  // отсюда вылетал наружу целиком: человек с двадцатью одним вариантом в
  // ячейке получал ответ без тела, а в журнале оставался голый 500.
  //
  // Отказ схемы значит ровно одно: таблицу мы не поняли. Это не ошибка
  // файла — дальше его разберёт модель, у которой свои потолки. Поэтому
  // `null`, а не исключение.
  const parsed = importedSurveySchema.safeParse({ questions });
  return parsed.success ? parsed.data : null;
}

/** Тип колонки по тому, что в ней лежит. */
function inferColumnType(values: readonly string[]): { type: string; options?: string[] } {
  const filled = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (filled.length === 0) return { type: "TEXT_ANSWER" };

  const numbers = filled.map((value) => Number(value));
  if (numbers.every((value) => Number.isInteger(value))) {
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    // ПОРЯДОК ЗДЕСЬ — ЭТО ВСЁ. Диапазон 1..5 удовлетворяет обеим проверкам
    // сразу, поэтому узкая обязана стоять первой. Пока первой стояла
    // «0..10 → NPS», вторая ветка была недостижима в принципе, и любая
    // колонка удовлетворённости 1–5 из чужой выгрузки приезжала как NPS со
    // шкалой 10 — то есть с пятью делениями, которых в данных нет.
    if (min >= 1 && max <= 5) return { type: "RATING_SCALE" };
    if (min >= 0 && max <= 10) return { type: "NPS" };
  }

  const distinct = [...new Set(filled)];
  if (
    distinct.length <= MAX_INFERRED_OPTIONS &&
    distinct.every((value) => value.length <= MAX_INFERRED_OPTION_LENGTH)
  ) {
    return { type: "SINGLE_ANSWER", options: distinct };
  }

  return { type: "TEXT_ANSWER" };
}

/** Похожа ли ячейка шапки на формулировку вопроса, а не на имя поля. */
function looksLikePrompt(cell: string): boolean {
  const value = cell.trim();
  return value.endsWith("?") || value.split(/\s+/).length >= 3;
}

/**
 * Выгрузка ответов: вопросы стоят колонками, строки — ответы людей.
 * @returns `null`, если на выгрузку не похоже
 */
function readResponsesTable(rows: readonly Row[]): { survey: ImportedSurvey; warnings: ImportWarning[] } | null {
  const [header, ...body] = rows;
  if (!header || body.length < 2) return null;

  const prompts = header.filter((cell) => looksLikePrompt(cell));
  if (prompts.length < 2 || prompts.length < header.length / 2) return null;

  const questions = header
    .map((cell, column) => {
      const title = cell.trim();
      if (!title || !looksLikePrompt(cell)) return null;
      const inferred = inferColumnType(body.map((row) => row[column] ?? ""));
      return {
        title,
        type: inferred.type,
        required: false,
        ...(inferred.options ? { options: inferred.options } : {}),
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null);

  if (questions.length === 0) return null;

  return {
    survey: importedSurveySchema.parse({ questions }),
    warnings: [
      {
        code: "INFERRED_FROM_RESPONSES",
        detail:
          "This looks like a responses export – questions came from the header row and types were guessed from the answers",
      },
    ],
  };
}

/**
 * Разобрать таблицу без обращения к модели.
 * @returns `null`, если таблица не похожа ни на сетку вопросов, ни на выгрузку
 *          ответов — тогда вызывающий уводит её на общий путь с моделью
 */
export function readTable(rows: readonly Row[]): { survey: ImportedSurvey; warnings: ImportWarning[] } | null {
  const meaningful = dropEmptyRows(rows);
  if (meaningful.length < 2) return null;

  const grid = readQuestionGrid(meaningful);
  if (grid) return { survey: grid, warnings: [] };

  return readResponsesTable(meaningful);
}
