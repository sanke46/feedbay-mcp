import { describe, expect, it } from "vitest";

import { CANONICAL_TYPES, type CanonicalQuestionType } from "../src/domain/question-types.js";
import { FOREIGN_SPELLINGS, resolveImportedType } from "../src/domain/import/vocabulary.js";

/**
 * Словарь названий типов: во что превращается то, что НАПИСАЛ ЧУЖОЙ ПРОДУКТ
 * или сказала модель.
 *
 * ПОЧЕМУ ЭТОТ ТЕСТ ВООБЩЕ ЕСТЬ. Схема ответа модели в `/ai/import` просит
 * назвать тип обычными словами и обещает, что написание неважно. Обещание
 * держит ровно эта таблица, и когда она отстаёт — вопрос молча становится
 * текстовым полем с предупреждением «тип не поддерживается» про тип, который
 * продукт поддерживает с первого дня. Так уже было с `LONG_TEXT`.
 *
 * Замер перед этой правкой: из 27 реалистичных формулировок распознавались
 * 8 — ровно те шесть, что перечислены примерами в самой инструкции модели,
 * плюс две. «Short answer», «Paragraph», «Checkboxes», «Linear scale» —
 * дословные ярлыки Google Forms — не распознавался ни один.
 *
 * ПОЧЕМУ ЭТО НЕ РАСШИРЕНИЕ `aliases` В `question-types.ts`. Тот список —
 * контракт с рендерером: набор написаний, которые разрешено ХРАНИТЬ, и
 * `contract.test.ts` сторожит, что `normalizeQuestionType()` умеет нарисовать
 * каждое. Первая попытка была именно такой, и контракт её отверг — 111
 * написаний, которых рендерер не знает. Здесь задача обратная и стоит ДО
 * хранения: понять чужое слово и отдать наш канонический тип.
 */

/**
 * Что пишут чужие конструкторы и что говорит модель.
 *
 * Список не выдуман: левая колонка — дословные ярлыки из интерфейсов и
 * выгрузок, либо формулировки, которыми модель отвечает на просьбу назвать
 * тип «обычными словами».
 */
const VOCABULARY: ReadonlyArray<readonly [string, CanonicalQuestionType, string]> = [
  // — Google Forms, дословно из его интерфейса —
  ["Short answer", "TEXT_ANSWER", "Google Forms"],
  ["Paragraph", "LONG_TEXT", "Google Forms"],
  ["Checkboxes", "MULTIPLE_ANSWER", "Google Forms"],
  ["Dropdown", "DROPDOWN", "Google Forms"],
  ["Linear scale", "RATING_SCALE", "Google Forms"],
  ["Multiple choice grid", "MATRIX", "Google Forms"],
  ["Checkbox grid", "MATRIX", "Google Forms"],
  ["Date", "DATE", "Google Forms"],
  ["Time", "DATE", "Google Forms"],

  // — Typeform —
  ["Long text", "LONG_TEXT", "Typeform"],
  ["Short text", "TEXT_ANSWER", "Typeform"],
  ["Opinion scale", "RATING_SCALE", "Typeform"],
  ["Rating", "RATING_SCALE", "Typeform"],
  ["Yes/No", "YES_NO", "Typeform"],
  ["Legal", "YES_NO", "Typeform"],
  ["Email", "EMAIL", "Typeform"],
  ["Phone number", "CONTACT_FORM", "Typeform"],
  ["Multiple selection", "MULTIPLE_ANSWER", "Typeform"],
  ["Ranking", "MATRIX", "Typeform"],
  ["Net Promoter Score", "NPS", "Typeform"],

  // — SurveyMonkey / MS Forms —
  ["Star rating", "RATING_SCALE", "SurveyMonkey"],
  ["Matrix", "MATRIX", "SurveyMonkey"],
  ["Comment box", "LONG_TEXT", "SurveyMonkey"],
  ["Contact information", "CONTACT_FORM", "SurveyMonkey"],
  ["Likert scale", "RATING_SCALE", "SurveyMonkey"],

  // — Разметка HTML-формы и заполняемого PDF —
  ["radio", "SINGLE_ANSWER", "HTML input[type=radio]"],
  ["checkbox", "MULTIPLE_ANSWER", "HTML input[type=checkbox]"],
  ["select", "DROPDOWN", "HTML select"],
  ["textarea", "LONG_TEXT", "HTML textarea"],
  ["text", "TEXT_ANSWER", "HTML input[type=text]"],
  ["tel", "CONTACT_FORM", "HTML input[type=tel]"],
  ["number", "TEXT_ANSWER", "HTML input[type=number]"],
  ["range", "RATING_SCALE", "HTML input[type=range]"],

  // — Как отвечает модель, когда её просят «обычными словами» —
  ["single choice", "SINGLE_ANSWER", "модель"],
  ["multiple choice", "MULTIPLE_ANSWER", "модель"],
  ["rating scale", "RATING_SCALE", "модель"],
  ["open-ended", "LONG_TEXT", "модель"],
  ["open text", "TEXT_ANSWER", "модель"],
  ["free text", "TEXT_ANSWER", "модель"],
  ["true/false", "YES_NO", "модель"],
  ["email address", "EMAIL", "модель"],
  ["thumbs up / down", "THUMB", "модель"],
  ["emoji rating", "SMILEY_SCALE", "модель"],
  ["customer effort score", "CES", "модель"],
  // Размер шкалы приходит отдельным полем, поэтому из названия типа числа
  // убираются: «SCALE_1_10» — это «SCALE», и ничего больше оно не значит.
  ["scale 1-10", "RATING_SCALE", "модель"],
  ["rating 1 to 5", "RATING_SCALE", "модель"],
  ["NPS 0-10", "NPS", "модель"],
];

describe("словарь названий типов", () => {
  it.each(VOCABULARY)("«%s» (%s) → %s", (said, expected) => {
    const type = resolveImportedType(said);
    expect(type, `«${said}» не опознано — вопрос станет текстовым полем`).toBeDefined();
    expect(type).toBe(expected);
  });

  /**
   * ЛОВУШКА, РАДИ КОТОРОЙ НАПИСАН ОТДЕЛЬНЫЙ ТЕСТ. Google Forms зовёт выбор
   * ОДНОГО варианта «Multiple choice» — прямо противоположно нашему
   * MULTIPLE_ANSWER. Разрешить эту коллизию в пользу Google нельзя: так же
   * говорит и модель, и большинство людей, имея в виду множественный выбор.
   * Поэтому гугловский смысл ловится через «radio», а сама коллизия
   * зафиксирована здесь, чтобы её не «починили» наоборот.
   */
  it("«multiple choice» остаётся множественным выбором, вопреки словарю Google Forms", () => {
    expect(resolveImportedType("multiple choice")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("radio")).toBe("SINGLE_ANSWER");
  });

  // ГЛАВНАЯ ЗАЩИТА ОТ «ВТОРОГО СПИСКА, КОТОРЫЙ ОТСТАЛ». Словарь живёт отдельно
  // от контракта с рендерером, и разойтись они могут только здесь: если цель
  // перестанет быть каноническим типом, `buildQuestion` бросит на записи.
  it("каждое чужое написание ведёт в тип, который продукт умеет хранить", () => {
    const strays = FOREIGN_SPELLINGS.map((spelling) => resolveImportedType(spelling)).filter(
      (type) => !type || !CANONICAL_TYPES.includes(type),
    );
    expect(strays).toEqual([]);
  });

  it("свои написания главнее чужих", () => {
    // Словарь описывает чужой мир и не должен переопределять собственный:
    // «SCALE» — наш алиас RATING_SCALE, и он обязан разрешаться через
    // findQuestionType, а не через запись в FOREIGN.
    expect(resolveImportedType("SCALE")).toBe("RATING_SCALE");
    expect(resolveImportedType("TEXT_ANSWER")).toBe("TEXT_ANSWER");
    expect(resolveImportedType("MULTIPLE_ANSWER")).toBe("MULTIPLE_ANSWER");
  });

  it("множественное число не требует отдельной записи", () => {
    // «Checkboxes» у Google, «checkbox» в разметке, «check boxes» от модели —
    // одно и то же. Держать три формы на каждое слово значит забыть одну.
    expect(resolveImportedType("checkbox")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("checkboxes")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("check boxes")).toBe("MULTIPLE_ANSWER");
  });

  it("неизвестное слово честно не опознаётся, а не притягивается к ближайшему", () => {
    // Обратное утверждение: словарь не должен разрастись до того, что
    // распознаёт что угодно. Запас прочности экрана review — в том, что
    // непонятое помечается предупреждением, а не угадывается.
    expect(resolveImportedType("сделайте фон синим")).toBeUndefined();
    expect(resolveImportedType("page 3 of 7")).toBeUndefined();
    expect(resolveImportedType("")).toBeUndefined();
  });
});

/**
 * Мусор в названии типа, который приезжает из настоящих выгрузок.
 *
 * НАЙДЕНО ОБРАЗЦАМИ, А НЕ ЧТЕНИЕМ СЛОВАРЯ. Оба случая всплыли, когда файлы
 * `tests/fixtures/sample-surveys/` впервые прогнали через конвейер: словарь
 * знал и «Net Promoter Score», и «Opinion Scale», но ни один из них не
 * распознавался в той форме, в какой их пишет Typeform.
 *
 * Цена была высокой и незаметной: нераспознанный тип уезжает в текстовое
 * поле, то есть шкала NPS превращается в строку ввода, и автор видит это уже
 * после импорта — если вообще заметит.
 */
describe("мусор в названии типа", () => {
  // Typeform пишет тип со знаком охраны — буквально «Net Promoter Score®».
  it("знак охраны не мешает распознаванию", () => {
    expect(resolveImportedType("Net Promoter Score®")).toBe("NPS");
    expect(resolveImportedType("Rating™")).toBe("RATING_SCALE");
  });

  // Диапазон в скобках: закрывающая скобка мешала снять хвост с числами, и
  // «OPINION_SCALE_(0_10)» не совпадал ни с чем.
  it("диапазон в скобках снимается вместе со скобками", () => {
    expect(resolveImportedType("Opinion Scale (0-10)")).toBe("RATING_SCALE");
    expect(resolveImportedType("Rating (1-5)")).toBe("RATING_SCALE");
    expect(resolveImportedType("NPS (0 to 10)")).toBe("NPS");
  });

  // Скобки стали разделителем — проверяем, что это не разрезало рабочие типы.
  it("не ломает типы, которые распознавались раньше", () => {
    expect(resolveImportedType("Email address")).toBe("EMAIL");
    expect(resolveImportedType("Thumbs up/down")).toBe("THUMB");
    expect(resolveImportedType("Checkboxes")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("Linear scale")).toBe("RATING_SCALE");
    expect(resolveImportedType("Long answer")).toBe("LONG_TEXT");
  });
});

/**
 * Слова, которыми тип называет САМА МОДЕЛЬ.
 *
 * НАЙДЕНО ЗАКАЗЧИКОМ НА ПРОДЕ. В диалоге импорта висели предупреждения
 * «Type “numeric rating scale” isn't supported — imported as a text
 * question» и то же про «boolean choice». То есть шкала оценки превращалась
 * в строку ввода, а вопрос «да/нет» — тоже в строку ввода.
 *
 * Обиднее всего, что короткие формы в словаре БЫЛИ: «rating scale» и
 * «boolean» находились. Мешало лишнее слово рядом — модель описывает тип
 * многословнее, чем мы.
 */
describe("многословные названия от модели", () => {
  it("лишнее слово не мешает найти шкалу", () => {
    expect(resolveImportedType("numeric rating scale")).toBe("RATING_SCALE");
    expect(resolveImportedType("numeric rating")).toBe("RATING_SCALE");
  });

  // Голова тут и есть смысл: усечение крайнего слова отбрасывает её первой и
  // превращает «boolean choice» в «choice», то есть в одиночный выбор.
  // Поэтому такие формы записаны в словаре явно.
  it("«boolean» остаётся вопросом да/нет, а не выбором", () => {
    expect(resolveImportedType("boolean choice")).toBe("YES_NO");
    expect(resolveImportedType("boolean question")).toBe("YES_NO");
    expect(resolveImportedType("simple boolean field")).toBe("YES_NO");
  });

  // Усечение работает ТОЛЬКО как запасной путь. Эти формы находятся целиком,
  // и до усечения дело не доходит — иначе «multiple choice» усохло бы до
  // «choice» и стало одиночным выбором.
  it("не ломает то, что находилось целиком", () => {
    expect(resolveImportedType("multiple choice")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("single choice")).toBe("SINGLE_ANSWER");
    expect(resolveImportedType("checkboxes")).toBe("MULTIPLE_ANSWER");
    expect(resolveImportedType("long text")).toBe("LONG_TEXT");
    expect(resolveImportedType("short answer")).toBe("TEXT_ANSWER");
  });

  // Незнакомое слово обязано остаться незнакомым: усечение не должно
  // превращать «погода за окном» в какой-нибудь тип по одному общему слову.
  it("не выдумывает тип для чепухи", () => {
    expect(resolveImportedType("погода за окном")).toBeUndefined();
    expect(resolveImportedType("lorem ipsum dolor")).toBeUndefined();
  });
});
