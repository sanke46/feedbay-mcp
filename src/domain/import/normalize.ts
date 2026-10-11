/**
 * Из того, что вернула модель, — в вопросы, неотличимые от сделанных руками.
 *
 * Здесь нет собственного построителя вопроса: всё идёт через тот же
 * `buildQuestion`, которым пользуется ассистент и MCP. Поэтому импортированный
 * опрос по форме совпадает с любым другим — это не обещание в документации, а
 * следствие того, что путь один.
 */

import type { Question } from "../../types.js";
import { buildQuestion, renumber } from "../questions.js";
import { findQuestionType } from "../question-types.js";
import { resolveImportedType } from "./vocabulary.js";
import { IMPORT_LIMITS, type ImportedQuestion, type ImportedSurvey } from "./schema.js";

export type ImportWarningCode =
  /** Вопросов было больше потолка — лишние отброшены. */
  | "TRUNCATED"
  /** Тип не опознан, вопрос стал текстовым. */
  | "TYPE_FALLBACK"
  /** Выбор без вариантов — подставлены заглушки. */
  | "OPTIONS_MISSING"
  /** Модель сама пометила, что не уверена. */
  | "LOW_CONFIDENCE"
  /** Страница без текстового слоя: скан, который нечем прочитать. */
  | "PAGE_UNREADABLE"
  /** В книге больше одного листа, взят первый. */
  | "SHEETS_IGNORED"
  /** Таблица оказалась выгрузкой ответов, типы выведены из значений. */
  | "INFERRED_FROM_RESPONSES";

/**
 * Предупреждение разбора.
 *
 * <p>`detail` ПИШЕТСЯ ПО-АНГЛИЙСКИ, в отличие от комментариев вокруг: эту
 * строку видит не разработчик, а человек на экране review, и весь остальной
 * интерфейс продукта английский. Здесь они были русскими — нашлось при съёмке
 * кадра, где на английском экране висело «Тип «SLIDER» неизвестен».
 */
export interface ImportWarning {
  code: ImportWarningCode;
  detail: string;
  /** Позиция вопроса в итоговом списке, если предупреждение про конкретный. */
  questionIndex?: number;
}

export interface NormalizedImport {
  title: string | null;
  questions: Question[];
  warnings: ImportWarning[];
  ignored: Array<{ text: string; reason: string }>;
}

/** Минимум вариантов, при котором выбор вообще имеет смысл. */
const MIN_OPTIONS = 2;

function configFor(
  question: ImportedQuestion,
  type: string,
  index: number,
  warnings: ImportWarning[],
): Record<string, unknown> {
  const spec = findQuestionType(type);
  const config: Record<string, unknown> = {};

  // `configFields.options`, а не `category === "choice"`. У «да/нет» и
  // «пальцев» категория тоже choice, но вариантов они не принимают — их два
  // и они заданы самим типом. Пока условие смотрело на категорию, КАЖДЫЙ
  // вопрос «да/нет» рождал предупреждение «вариантов не нашлось»: постоянный
  // шум на экране review, из-за которого настоящие предупреждения перестают
  // читать. Признак берётся из таблицы типов, поэтому новый бинарный тип
  // получит правильное поведение сам, без правки здесь.
  if (spec && "options" in spec.configFields) {
    const options = (question.options ?? []).filter((option) => option.length > 0);
    if (options.length >= MIN_OPTIONS) {
      config.options = options;
    } else {
      // Тип сохраняем: «выбор из одного варианта» — это почти наверняка
      // недочитанный документ, а не намерение автора. Варианты придут из
      // дефолтов типа, а человек увидит предупреждение и поправит в проверке.
      warnings.push({
        code: "OPTIONS_MISSING",
        detail: `“${question.title}” – no answer options were found in the document`,
        questionIndex: index,
      });
    }
  }

  if (spec?.category === "rating" && typeof question.scale === "number") {
    config.scale = question.scale;
  }

  return config;
}

/**
 * @param parsed   что вернула модель, уже прошедшее схему
 * @param carried  предупреждения, накопленные раньше самой моделью: обрезанные
 *                 страницы, пропущенные листы книги, выведенные из ответов типы
 */
export function normalizeImported(
  parsed: ImportedSurvey,
  carried: readonly ImportWarning[] = [],
): NormalizedImport {
  const warnings: ImportWarning[] = [...carried];

  let incoming = parsed.questions;
  if (incoming.length > IMPORT_LIMITS.questions) {
    warnings.push({
      code: "TRUNCATED",
      detail: `The document has ${incoming.length} questions – the first ${IMPORT_LIMITS.questions} were kept`,
    });
    incoming = incoming.slice(0, IMPORT_LIMITS.questions);
  }

  const questions = incoming
    .filter((question) => question.title.length > 0)
    .map((question, index) => {
      // `resolveImportedType`, а не `canonicalizeQuestionType`: у документа
      // свой словарь. «Paragraph», «Linear scale», «Checkboxes» — это слова
      // Google Forms, и понимать их обязан импорт, а не контракт хранения
      // (см. шапку `vocabulary.ts`).
      let type = resolveImportedType(question.type);
      if (!type) {
        // Неизвестное написание не должно ронять весь импорт: человек скорее
        // поправит один тип в проверке, чем загрузит файл заново.
        type = "TEXT_ANSWER";
        warnings.push({
          code: "TYPE_FALLBACK",
          detail: `Type “${question.type}” isn't supported – imported as a text question`,
          questionIndex: index,
        });
      }

      if (question.confidence === "low") {
        warnings.push({
          code: "LOW_CONFIDENCE",
          detail: `“${question.title}” – read with low confidence, check the wording`,
          questionIndex: index,
        });
      }

      return buildQuestion(
        {
          type,
          title: question.title,
          ...(question.description ? { description: question.description } : {}),
          required: question.required ?? false,
          config: configFor(question, type, index, warnings),
        },
        index,
      );
    });

  return {
    title: parsed.title && parsed.title.length > 0 ? parsed.title : null,
    questions: renumber(questions),
    warnings,
    ignored: (parsed.ignored ?? []).filter((entry) => entry.text.length > 0),
  };
}
