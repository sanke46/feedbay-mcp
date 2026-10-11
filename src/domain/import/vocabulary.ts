/**
 * Как чужие слова про тип вопроса превращаются в наши.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНО ОТ `question-types.ts`, А НЕ ЕГО РАСШИРЕНИЕ. Список
 * `aliases` там — не свободный словарь, а КОНТРАКТ С РЕНДЕРЕРОМ: это набор
 * написаний, которые разрешено ХРАНИТЬ, и `tests/contract.test.ts` сторожит,
 * что `normalizeQuestionType()` в survey-renderer умеет нарисовать каждое.
 * Положить туда «Paragraph» и «Linear scale» значит разрешить записать их в
 * базу — и получить вопрос, который рендерер молча уронит.
 *
 * Здесь задача обратная и стоит перед хранением: понять, что́ имел в виду
 * ЧУЖОЙ продукт или модель, и отдать наш канонический тип. На выходе всегда
 * `CanonicalQuestionType`, поэтому контракт с рендерером не затрагивается
 * вовсе.
 *
 * ЗАЧЕМ ВООБЩЕ. Схема ответа модели в `/ai/import` просит назвать тип
 * обычными словами и обещает, что написание неважно. Замер до этого файла: из
 * 27 реалистичных формулировок распознавались 8 — ровно те шесть, что
 * перечислены примерами в самой инструкции, плюс две. «Short answer»,
 * «Paragraph», «Checkboxes», «Linear scale» — дословные ярлыки Google Forms —
 * не распознавался ни один, и каждый такой вопрос молча становился текстовым
 * полем. Тот же класс, что уже стрелял с `LONG_TEXT`.
 *
 * ПОРЯДОК РАЗБОРА. Сначала спрашивается `findQuestionType` — наши собственные
 * написания главнее; потом этот словарь. Не наоборот: словарь описывает чужой
 * мир, и он не должен переопределять свой.
 */

import { findQuestionType, type CanonicalQuestionType } from "../question-types.js";

/** Приведение к виду ключа: регистр и разделители. */
function key(raw: string): string {
  return (
    raw
      .trim()
      .toUpperCase()
      // Знаки правовой охраны приезжают прямо в названии типа: Typeform
      // пишет «Net Promoter Score®», и без этой строки он не распознавался
      // вовсе. Найдено образцом-выгрузкой, а не чтением словаря.
      .replace(/[®™©]/g, "")
      // Скобки — разделитель, а не часть слова. «Opinion Scale (0-10)»
      // превращался в «OPINION_SCALE_(0_10)», и снятие диапазона ниже об эту
      // закрывающую скобку спотыкалось: диапазон оставался, тип терялся.
      .replace(/[()[\]{}]+/g, " ")
      .replace(/[\s/\\.\-_,;:]+/g, "_")
      .replace(/^_|_$/g, "")
  );
}

/**
 * Снять числовой диапазон с хвоста: «scale 1-10», «NPS 0-10», «rating 1 to 5».
 *
 * Сам размер шкалы приходит отдельным полем `scale`, поэтому из НАЗВАНИЯ типа
 * числа можно убрать без потери: «SCALE_1_10» — это «SCALE», и ничего больше
 * оно не значит.
 */
function withoutRange(k: string): string {
  return k.replace(/(?:_(?:\d+|TO|OF|FROM))+$/g, "");
}

/**
 * Единственное число — ПОСЕГМЕНТНО, а не у всего ключа целиком.
 *
 * Держать обе формы каждого слова значит гарантированно забыть одну:
 * «Checkboxes» у Google, «checkbox» в разметке, «check boxes» от модели —
 * одно и то же. Но резать `S` в конце всей строки нельзя, и это не гипотеза:
 * первая версия делала именно так и превращала `EMAIL_ADDRESS` в
 * `EMAIL_ADDRES`, а множественное число в середине (`THUMBS_UP_DOWN`) не
 * видела вовсе.
 *
 * `SS` на конце сегмента не трогаем — это `ADDRESS`, а не множественное.
 */
function singular(k: string): string {
  return k
    .split("_")
    .map((part) => {
      if (part.length < 4 || part.endsWith("SS")) return part;
      if (part.endsWith("IES")) return `${part.slice(0, -3)}Y`;
      if (/(?:CH|SH|S|X|Z)ES$/.test(part)) return part.slice(0, -2);
      if (part.endsWith("S")) return part.slice(0, -1);
      return part;
    })
    .join("_");
}

/**
 * Чужое слово → наш тип.
 *
 * Ключи записаны уже приведёнными (`key`), поэтому «Short answer», «short
 * answer» и «SHORT-ANSWER» попадают в одну запись.
 *
 * Источники в комментариях — не украшение: когда ярлык в чужом продукте
 * переименуют, по ним видно, что перепроверять.
 */
const FOREIGN: Readonly<Record<string, CanonicalQuestionType>> = {
  // — Текст —
  // Google Forms: «Short answer» / «Paragraph». Typeform: «Short text» / «Long text».
  SHORT_ANSWER: "TEXT_ANSWER",
  SHORT_RESPONSE: "TEXT_ANSWER",
  TEXT: "TEXT_ANSWER",
  STRING: "TEXT_ANSWER",
  INPUT: "TEXT_ANSWER",
  TEXT_FIELD: "TEXT_ANSWER",
  TEXT_INPUT: "TEXT_ANSWER",
  SINGLE_LINE: "TEXT_ANSWER",
  SINGLE_LINE_TEXT: "TEXT_ANSWER",
  ONE_LINE: "TEXT_ANSWER",
  OPEN_TEXT: "TEXT_ANSWER",
  FREE_TEXT: "TEXT_ANSWER",
  // Числового типа у продукта нет; текстовое поле — ближайшее, что не теряет
  // сам вопрос. Человек увидит его в проверке и решит сам.
  NUMBER: "TEXT_ANSWER",
  NUMERIC: "TEXT_ANSWER",
  INTEGER: "TEXT_ANSWER",

  PARAGRAPH: "LONG_TEXT",
  PARAGRAPH_TEXT: "LONG_TEXT",
  TEXTAREA: "LONG_TEXT",
  MULTILINE: "LONG_TEXT",
  MULTILINE_TEXT: "LONG_TEXT",
  ESSAY: "LONG_TEXT",
  COMMENT: "LONG_TEXT",
  COMMENT_BOX: "LONG_TEXT",
  OPEN_ENDED: "LONG_TEXT",
  OPEN_QUESTION: "LONG_TEXT",
  LONG_ANSWER: "LONG_TEXT",
  LONG_RESPONSE: "LONG_TEXT",

  // — Выбор —
  // ЛОВУШКА: Google Forms зовёт выбор ОДНОГО варианта «Multiple choice» —
  // прямо противоположно нашему MULTIPLE_ANSWER. Разрешаем в пользу общего
  // смысла (так говорит и модель, и большинство людей), а гугловский случай
  // ловится через разметку: «radio».
  RADIO: "SINGLE_ANSWER",
  RADIO_BUTTON: "SINGLE_ANSWER",
  RADIO_GROUP: "SINGLE_ANSWER",
  ONE_CHOICE: "SINGLE_ANSWER",
  CHOICE: "SINGLE_ANSWER",
  PICK_ONE: "SINGLE_ANSWER",
  SELECT_ONE: "SINGLE_ANSWER",
  CHOOSE_ONE: "SINGLE_ANSWER",
  OPTION_LIST: "SINGLE_ANSWER",

  CHECK_BOX: "MULTIPLE_ANSWER",
  MULTI_CHOICE: "MULTIPLE_ANSWER",
  MULTISELECT: "MULTIPLE_ANSWER",
  MULTI_SELECT: "MULTIPLE_ANSWER",
  MULTIPLE_SELECT: "MULTIPLE_ANSWER",
  MULTIPLE_SELECTION: "MULTIPLE_ANSWER",
  SELECT_MANY: "MULTIPLE_ANSWER",
  PICK_MANY: "MULTIPLE_ANSWER",
  SELECT_ALL: "MULTIPLE_ANSWER",
  SELECT_ALL_THAT_APPLY: "MULTIPLE_ANSWER",

  DROP_DOWN: "DROPDOWN",
  DROPDOWN_LIST: "DROPDOWN",
  COMBOBOX: "DROPDOWN",
  PICKLIST: "DROPDOWN",
  LIST: "DROPDOWN",

  // — Шкалы —
  // Google Forms: «Linear scale». Typeform: «Opinion scale», «Rating».
  // SurveyMonkey: «Star rating», «Likert scale». MS Forms: «Rating».
  LINEAR_SCALE: "RATING_SCALE",
  OPINION_SCALE: "RATING_SCALE",
  RATING: "RATING_SCALE",
  STAR: "RATING_SCALE",
  LIKERT: "RATING_SCALE",
  LIKERT_SCALE: "RATING_SCALE",
  NUMERIC_SCALE: "RATING_SCALE",
  NUMBER_SCALE: "RATING_SCALE",
  SLIDER: "RATING_SCALE",
  RANGE: "RATING_SCALE",
  SCORE: "RATING_SCALE",

  SMILEY: "SMILEY_SCALE",
  EMOJI: "SMILEY_SCALE",
  EMOJI_SCALE: "SMILEY_SCALE",
  FACE: "SMILEY_SCALE",

  THUMB_UP_DOWN: "THUMB",
  THUMB_UP_OR_DOWN: "THUMB",
  LIKE_DISLIKE: "THUMB",

  NET_PROMOTER_SCORE: "NPS",
  NET_PROMOTER: "NPS",
  RECOMMENDATION_SCORE: "NPS",
  CUSTOMER_SATISFACTION: "CSAT",
  SATISFACTION_SCORE: "CSAT",
  CUSTOMER_EFFORT_SCORE: "CES",
  EFFORT_SCORE: "CES",

  // — Да/нет —
  // Typeform зовёт согласие с условиями «Legal» — это тот же да/нет.
  YESNO: "YES_NO",
  BOOLEAN: "YES_NO",
  // Так тип называет САМА МОДЕЛЬ, когда описывает его своими словами —
  // увидено в ответе на боевом импорте. Записи явные, потому что усечение
  // крайнего слова здесь ошибается: оно сначала отбрасывает голову, и
  // «boolean choice» превращается в «choice», то есть в одиночный выбор.
  // Голова тут и есть смысл, а «choice» — общее слово.
  BOOLEAN_CHOICE: "YES_NO",
  BOOLEAN_QUESTION: "YES_NO",
  BOOLEAN_FIELD: "YES_NO",
  BOOLEAN_ANSWER: "YES_NO",
  TRUE_FALSE: "YES_NO",
  BINARY: "YES_NO",
  LEGAL: "YES_NO",
  CONSENT: "YES_NO",
  AGREEMENT: "YES_NO",

  // — Контакты —
  EMAIL_ADDRESS: "EMAIL",
  E_MAIL: "EMAIL",
  MAIL: "EMAIL",

  PHONE: "CONTACT_FORM",
  PHONE_NUMBER: "CONTACT_FORM",
  TEL: "CONTACT_FORM",
  TELEPHONE: "CONTACT_FORM",
  CONTACT: "CONTACT_FORM",
  CONTACT_DETAIL: "CONTACT_FORM",
  CONTACT_INFORMATION: "CONTACT_FORM",
  NAME: "CONTACT_FORM",
  FULL_NAME: "CONTACT_FORM",
  ADDRESS: "CONTACT_FORM",

  // — Дата —
  DATE_PICKER: "DATE",
  DATETIME: "DATE",
  DATE_TIME: "DATE",
  DAY: "DATE",
  CALENDAR: "DATE",
  TIME: "DATE",

  // — Сетки —
  // Google Forms: «Multiple choice grid», «Checkbox grid».
  GRID: "MATRIX",
  MULTIPLE_CHOICE_GRID: "MATRIX",
  CHECKBOX_GRID: "MATRIX",
  MATRIX_GRID: "MATRIX",
  RANK: "MATRIX",
  RANK_ORDER: "MATRIX",
  ORDERING: "MATRIX",

  // — Экраны —
  INTRO: "WELCOME",
  COVER: "WELCOME",
  START_SCREEN: "WELCOME",
  THANK: "THANK_YOU",
  THANK_YOU_SCREEN: "THANK_YOU",
  END_SCREEN: "THANK_YOU",
  ENDING: "THANK_YOU",
  OUTRO: "THANK_YOU",
  CLOSING: "THANK_YOU",
};

/**
 * Опознать тип по тому, как его назвал документ, модель или чужой продукт.
 *
 * Возвращает `undefined`, когда не понял, — и это важнее, чем кажется: экран
 * review держится на том, что непонятое ПОМЕЧАЕТСЯ предупреждением, а не
 * угадывается. Словарь, который распознаёт что угодно, хуже узкого.
 */
/**
 * Отбросить крайнее слово — последняя попытка, когда всё точное не сошлось.
 *
 * <p>НАЙДЕНО НА ПРОДЕ. Модель описывает тип своими словами, и её слова
 * длиннее наших: «numeric rating scale» вместо «rating scale», «boolean
 * choice» вместо «boolean». Каждое из коротких в словаре ЕСТЬ, и всё равно
 * оба типа уезжали в текстовое поле — шкала оценки превращалась в строку
 * ввода, а человек видел «Type … isn't supported» и не понимал, чем плох его
 * документ.
 *
 * <p>СПИСКА СЛОВ-ПАРАЗИТОВ ЗДЕСЬ НЕТ НАМЕРЕННО. Он бы устаревал ровно так
 * же, как устарел словарь: модель завтра скажет «simple boolean field», и
 * список опять окажется неполным. Отбрасывание крайних слов не знает, какие
 * слова лишние, — оно просто пробует более короткую форму.
 *
 * <p>Работает ТОЛЬКО как запасной путь, после всех точных совпадений:
 * «multiple choice» находится целиком и до сюда не доходит, а дойди —
 * усечение до «choice» дало бы одиночный выбор вместо множественного.
 */
function withoutEdgeWord(k: string): string[] {
  const parts = k.split("_").filter(Boolean);
  if (parts.length < 2) return [];
  return [parts.slice(1).join("_"), parts.slice(0, -1).join("_")];
}

export function resolveImportedType(raw: string): CanonicalQuestionType | undefined {
  // Свои написания главнее: словарь описывает чужой мир и не должен
  // переопределять собственный контракт с рендерером.
  const own = findQuestionType(raw);
  if (own) return own.type;

  const k = key(raw);
  const foreign = FOREIGN[k];
  if (foreign) return foreign;

  // Единственное число и числовой диапазон пробуем ПОСЛЕ точного совпадения,
  // а не вместо: слово, записанное в словаре во множественном, не должно
  // ломаться о собственную же нормализацию.
  for (const candidate of [singular(k), withoutRange(k), singular(withoutRange(k))]) {
    if (candidate === k || candidate.length === 0) continue;
    const hit = findQuestionType(candidate)?.type ?? FOREIGN[candidate];
    if (hit) return hit;
  }

  // Последняя попытка: слова модели длиннее наших. Отбрасываем крайнее слово
  // и пробуем ещё раз — см. заметку у `withoutEdgeWord`.
  for (const shorter of withoutEdgeWord(k)) {
    if (shorter.length === 0) continue;
    const hit =
      findQuestionType(shorter)?.type ??
      FOREIGN[shorter] ??
      FOREIGN[singular(shorter)] ??
      FOREIGN[withoutRange(shorter)];
    if (hit) return hit;
  }
  return undefined;
}

/** Для тестов: сколько чужих написаний словарь знает. */
export const FOREIGN_SPELLINGS: readonly string[] = Object.keys(FOREIGN);
