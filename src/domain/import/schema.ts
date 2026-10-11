/**
 * Что модель обязана вернуть, разбирая присланный файл.
 *
 * Схема закрытая и с жёсткими потолками не из аккуратности: документ приносит
 * посторонний человек, и всё, что модель из него вычитает, — это данные под
 * контролем автора документа. Ограничение длин и количества здесь — такая же
 * мера против инъекции, как и отсутствие инструментов у самого вызова.
 *
 * ПОЛЯ `order` НЕТ НАМЕРЕННО. Порядок — это позиция в массиве, и его всё равно
 * проставляет `renumber()` перед записью. Поле, в котором модель может
 * ошибиться, — это поле, которое потом придётся чинить.
 *
 * ПРЕДУПРЕЖДЕНИЙ МОДЕЛЬ ТОЖЕ НЕ ВОЗВРАЩАЕТ. Их выводит `normalizeImported` из
 * того, что реально произошло при разборе: сказать «всё хорошо» модель может и
 * тогда, когда хорошо не всё.
 */

import { z } from "zod";

export const IMPORT_LIMITS = {
  /** Больше полусотни вопросов — это уже не опрос, а анкета на выброс. */
  questions: 50,
  title: 200,
  description: 500,
  option: 200,
  options: 20,
  ignoredEntry: 300,
} as const;

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

/**
 * Теги и управляющие символы вырезаются здесь, а не при показе.
 *
 * Живого XSS нет — рендерер ставит заголовки текстом, — но `<script>` в
 * заголовке вопроса выглядит сломанным уже в редакторе, а бэкенд внутрь
 * `config` не смотрит вообще: `htmlSanitizer` чистит только имя опроса.
 *
 * Управляющие символы перебираются по кодам, а не регуляркой: диапазон
 * пришлось бы писать литералом, а литерал из управляющих символов в исходнике
 * — это то, что потом никто не сможет ни прочитать, ни отредактировать.
 */
export function sanitizeImportedText(raw: string): string {
  const withoutTags = raw.replace(/<[^>]*>/g, " ");

  let out = "";
  for (const char of withoutTags) {
    const code = char.codePointAt(0) ?? 0;
    // Перевод строки и табуляция — это разделители слов, а не мусор.
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) {
      out += " ";
      continue;
    }
    if (code < SPACE || code === DELETE) continue;
    out += char;
  }

  return out.replace(/\s+/g, " ").trim();
}

const text = (max: number) => z.string().transform((value) => sanitizeImportedText(value).slice(0, max));

export const importedQuestionSchema = z.object({
  title: text(IMPORT_LIMITS.title),
  description: text(IMPORT_LIMITS.description).nullish(),
  /**
   * Свободная строка, а не enum: модель регулярно пишет `CHECKBOX` или
   * `single choice`, и это те же самые типы. Складывание в канонический
   * происходит при нормализации, где неизвестное написание становится
   * текстовым вопросом с предупреждением, а не рушит весь импорт.
   */
  type: z.string(),
  required: z.boolean().nullish(),
  options: z.array(text(IMPORT_LIMITS.option)).max(IMPORT_LIMITS.options).nullish(),
  scale: z.number().int().min(2).max(11).nullish(),
  /** Модель сама помечает то, в чём не уверена, — это попадает в предупреждения. */
  confidence: z.enum(["high", "low"]).nullish(),
});

export const importedSurveySchema = z.object({
  title: text(IMPORT_LIMITS.title).nullish(),
  questions: z.array(importedQuestionSchema),
  /**
   * Что в документе было, но вопросом не является: согласия, колонтитулы,
   * номера страниц, заметки про фирменные цвета. Показывается человеку
   * отдельным блоком — это и делает «импортируем только содержание и
   * структуру» проверяемым обещанием, а не строчкой в промпте.
   */
  ignored: z
    .array(
      z.object({
        text: text(IMPORT_LIMITS.ignoredEntry),
        reason: text(IMPORT_LIMITS.title),
      }),
    )
    .nullish(),
});

export type ImportedQuestion = z.infer<typeof importedQuestionSchema>;
export type ImportedSurvey = z.infer<typeof importedSurveySchema>;
