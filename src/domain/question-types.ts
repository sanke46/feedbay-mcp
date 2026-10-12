/**
 * One canonical question vocabulary for the whole MCP surface.
 *
 * The codebase carries four overlapping unions of question types (the API
 * types, the backend template enum, the renderer, and an aspirational spec
 * file). The only one that decides whether a question actually *renders* is
 * `normalizeQuestionType()` in packages/survey-renderer/src/utils.ts — it folds
 * every historical spelling down to the variant the renderer switches on.
 *
 * So: this module mirrors that table. Tools accept any known spelling and
 * always persist the canonical one, which guarantees anything the MCP creates
 * both renders in the widget and groups correctly in the dashboard editor.
 */

export type CanonicalQuestionType =
  | "WELCOME"
  | "THANK_YOU"
  | "RATING_SCALE"
  | "NPS"
  | "CSAT"
  | "CES"
  | "SMILEY_SCALE"
  | "YES_NO"
  | "THUMB"
  | "SINGLE_ANSWER"
  | "MULTIPLE_ANSWER"
  | "DROPDOWN"
  | "TEXT_ANSWER"
  | "LONG_TEXT"
  | "EMAIL"
  | "CONTACT_FORM"
  | "DATE"
  | "MATRIX";

export type QuestionCategory = "screens" | "rating" | "choice" | "text" | "advanced";

export interface QuestionTypeSpec {
  type: CanonicalQuestionType;
  label: string;
  category: QuestionCategory;
  /** What the question is for, phrased for a model choosing between types. */
  description: string;
  /** Every spelling accepted on input and folded to `type`. */
  aliases: readonly string[];
  /** Config keys that matter for this type, with a one-line meaning each. */
  configFields: Readonly<Record<string, string>>;
  /** Screens carry no answer, so `required` is meaningless for them. */
  isScreen?: boolean;
  deprecated?: string;
}

const SHARED_CHOICE_FIELDS = {
  options: 'string[] – the answer options as plain strings, e.g. ["Card", "PayPal"] (not objects)',
  allowOther: 'boolean – adds an "Other" option with a free-text field',
  randomize: "boolean – shuffle the option order per respondent",
  autoAdvance: "boolean – jump to the next question as soon as an option is picked",
} as const;

/**
 * The editor's Vertical / Horizontal toggle (question-card.tsx, `hasOptionAxis`).
 * It was missing here, so the assistant told the tester that ratings can only
 * be horizontal: the prompt forbids config keys the catalogue does not list.
 */
const ORIENTATION_FIELD = {
  optionsOrientation:
    '"vertical" | "horizontal" – lay the answers out in a column or a row. Default: horizontal for ratings, vertical for choices',
} as const;

export const QUESTION_TYPES: readonly QuestionTypeSpec[] = [
  {
    type: "WELCOME",
    label: "Welcome screen",
    category: "screens",
    description: "Intro screen shown before the first question. Collects no answer.",
    aliases: ["WELCOME", "WELCOME_SCREEN", "INTRO_MESSAGE"],
    configFields: { buttonText: 'string – label of the start button (default "Start")' },
    isScreen: true,
  },
  {
    type: "THANK_YOU",
    label: "Thank-you screen",
    category: "screens",
    description: "Closing screen shown after the last question. Collects no answer.",
    aliases: ["THANK_YOU"],
    configFields: {
      emoji: "string – a single emoji shown above the message",
      message: "string – headline (falls back to the question title)",
      subtext: "string – smaller line under the headline",
    },
    isScreen: true,
  },
  {
    type: "RATING_SCALE",
    label: "Rating scale",
    category: "rating",
    description: "Numeric or icon rating, 1..scale. The general-purpose rating question.",
    aliases: ["RATING_SCALE", "STAR_RATING", "SCALE"],
    configFields: {
      ...ORIENTATION_FIELD,
      scale: "number 1-10 – how many points the scale has (default 5)",
      style:
        '"stars" | "hearts" | "smileys" | "thumbs" | "lightning" | "emoji" – icon set, or "numbers" for a ' +
        "1..scale grid of numbered buttons (default \"stars\")",
      iconVariant:
        '"filled" | "outlined" – icon weight (default "outlined"). Filled stars: style "stars" + iconVariant "filled"',
      labels: '{ enabled, left, right } – captions under the ends of a style "numbers" scale',
      autoAdvance: "boolean – advance as soon as a value is picked",
    },
  },
  {
    type: "NPS",
    label: "Net Promoter Score",
    category: "rating",
    description: "The standard 0-10 recommendation question. Use for loyalty measurement.",
    aliases: ["NPS"],
    configFields: {
      ...ORIENTATION_FIELD,
      scale: "number 3-10 – top of the scale (default 10)",
      minLabel: 'string – caption under the low end (e.g. "Not likely")',
      maxLabel: 'string – caption under the high end (e.g. "Very likely")',
      autoAdvance: "boolean – advance as soon as a value is picked",
    },
  },
  {
    type: "CSAT",
    label: "Customer satisfaction",
    category: "rating",
    description: "Satisfaction rating. Same UI as a rating scale, distinct metric.",
    aliases: ["CSAT"],
    configFields: {
      ...ORIENTATION_FIELD,
      scale: "number 1-10 (default 5)",
      style: '"stars" | "hearts" | "smileys" | "thumbs" | "lightning" | "emoji" | "numbers"',
      iconVariant: '"filled" | "outlined"',
    },
  },
  {
    type: "CES",
    label: "Customer effort score",
    category: "rating",
    description: 'Effort rating ("how easy was it?"). Same UI as a rating scale.',
    aliases: ["CES"],
    configFields: {
      ...ORIENTATION_FIELD,
      scale: "number 1-10 (default 5)",
      style: '"stars" | "hearts" | "smileys" | "thumbs" | "lightning" | "emoji" | "numbers"',
      iconVariant: '"filled" | "outlined"',
    },
  },
  {
    type: "SMILEY_SCALE",
    label: "Smiley scale",
    category: "rating",
    description: "Five faces from unhappy to happy. Fastest, lowest-effort rating.",
    aliases: ["SMILEY_SCALE", "EMOJI_RATING"],
    configFields: { autoAdvance: "boolean – advance as soon as a face is picked" },
  },
  {
    type: "YES_NO",
    label: "Yes / No",
    category: "choice",
    description: "Binary question.",
    aliases: ["YES_NO"],
    configFields: {
      ...ORIENTATION_FIELD,
      yesLabel: 'string – label of the positive answer (default "Yes")',
      noLabel: 'string – label of the negative answer (default "No")',
      autoAdvance: "boolean – advance as soon as an answer is picked",
    },
  },
  {
    type: "THUMB",
    label: "Thumbs up / down",
    category: "choice",
    description: "Binary question rendered as thumbs.",
    aliases: ["THUMB"],
    configFields: { autoAdvance: "boolean – advance as soon as an answer is picked" },
    deprecated: "Legacy type kept for existing surveys; prefer YES_NO for new questions.",
  },
  {
    type: "SINGLE_ANSWER",
    label: "Single choice",
    category: "choice",
    description: "Pick exactly one option (radio buttons).",
    aliases: ["SINGLE_ANSWER", "SINGLE_CHOICE"],
    configFields: { ...SHARED_CHOICE_FIELDS, ...ORIENTATION_FIELD },
  },
  {
    type: "MULTIPLE_ANSWER",
    label: "Multiple choice",
    category: "choice",
    description: "Pick any number of options (checkboxes).",
    aliases: ["MULTIPLE_ANSWER", "MULTIPLE_CHOICE", "CHECKBOX"],
    configFields: {
      ...ORIENTATION_FIELD,
      ...SHARED_CHOICE_FIELDS,
      allowMultiple: "boolean – always true for this type; kept for the renderer",
      minSelection: "number – minimum options the respondent must pick",
      maxSelection: "number – maximum options the respondent may pick",
    },
  },
  {
    type: "DROPDOWN",
    label: "Dropdown",
    category: "choice",
    description: "Single choice from a collapsed list. Use when there are many options.",
    aliases: ["DROPDOWN", "SELECT"],
    configFields: { ...SHARED_CHOICE_FIELDS, placeholder: "string – text shown before a choice is made" },
  },
  {
    type: "TEXT_ANSWER",
    label: "Short text",
    category: "text",
    description: "Single-line free text.",
    aliases: ["TEXT_ANSWER", "SHORT_TEXT"],
    configFields: {
      placeholder: "string – hint inside the empty field",
      maxLength: "number – character limit (default 5000)",
      validation: '"email" | "url" | "tel" | "phone" | "number" – client-side format check',
    },
  },
  {
    type: "LONG_TEXT",
    label: "Long text",
    category: "text",
    description: "Multi-line free text. Use for open-ended feedback.",
    aliases: ["LONG_TEXT"],
    configFields: {
      placeholder: "string – hint inside the empty field",
      maxLength: "number – character limit",
    },
  },
  {
    type: "EMAIL",
    label: "Email",
    category: "text",
    description: "Email address field with format validation.",
    aliases: ["EMAIL", "EMAIL_FIELD"],
    configFields: {
      placeholder: "string – hint inside the empty field",
      gdprNote: "string – consent line shown under the field",
    },
  },
  {
    type: "CONTACT_FORM",
    label: "Contact form",
    category: "advanced",
    description: "Several contact fields (name / email / phone) on one screen.",
    aliases: ["CONTACT_FORM", "CONTACT_INFO", "PHONE_FIELD"],
    configFields: {
      fields:
        "{ id, type: text|email|phone|select|textarea, label, placeholder, required, order }[] – the fields to collect. " +
        "Every field needs a unique id; use type phone for a phone number",
      enablePhoneCountryCode: "boolean – show a country-code picker next to phone fields",
    },
  },
  {
    type: "DATE",
    label: "Date",
    category: "advanced",
    description: "Date picker.",
    aliases: ["DATE"],
    configFields: {
      format: '"MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD" – display format',
      separator: '"/" | "-" | "." – separator between date parts',
      placeholder: "string – hint shown before a date is picked",
      enableCalendar: "boolean – show the calendar popup",
      minDate: "ISO date string – earliest selectable date",
      maxDate: "ISO date string – latest selectable date",
    },
  },
  {
    type: "MATRIX",
    label: "Matrix",
    category: "advanced",
    description: "Grid of rows rated against shared columns.",
    aliases: ["MATRIX", "RANKING"],
    configFields: {
      rows: "{ id, label }[] – the things being rated",
      columns: "{ id, label, value: number }[] – the rating options shared by every row",
      inputType: '"radio" | "checkbox" – one answer per row, or many',
    },
  },
] as const;

const BY_ALIAS: ReadonlyMap<string, QuestionTypeSpec> = new Map(
  QUESTION_TYPES.flatMap((spec) => spec.aliases.map((alias) => [alias, spec] as const)),
);

export const CANONICAL_TYPES: readonly CanonicalQuestionType[] = QUESTION_TYPES.map((spec) => spec.type);

/** Every spelling a tool will accept, for the enum in a tool schema. */
export const ACCEPTED_TYPE_SPELLINGS: readonly string[] = [...BY_ALIAS.keys()].sort();

/**
 * Разделители внутри названия типа значения не имеют.
 *
 * <p>ЭТО ПОЧИНКА ЖИВОГО ИМПОРТА, А НЕ ВЕЖЛИВОСТЬ К ОПЕЧАТКАМ. Схема ответа
 * модели в `/ai/import` просит назвать тип ОБЫЧНЫМИ СЛОВАМИ и сама приводит
 * примеры: «single choice», «long text», «rating scale», «yes/no». Модель
 * послушно отвечала именно так — а таблица псевдонимов знала только
 * `SINGLE_CHOICE` и `LONG_TEXT`. В итоге КАЖДЫЙ вопрос с вариантами, шкалой
 * или длинным ответом импортировался обычным текстовым полем, и человек
 * видел предупреждение «тип не поддерживается» про тип, который продукт
 * поддерживает с первого дня.
 *
 * <p>Поймано живым прогоном на PDF: юнит-тесты брали типы уже в канонической
 * записи, то есть проверяли путь, которым настоящий импорт не ходит.
 */
function foldSeparators(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s/\\.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function findQuestionType(raw: string): QuestionTypeSpec | undefined {
  return BY_ALIAS.get(raw.trim().toUpperCase()) ?? BY_ALIAS.get(foldSeparators(raw));
}

/** Расстояние Левенштейна: опечатки в названии типа — одна-две буквы. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * Канонические типы, которые, скорее всего, имелись в виду: опечатка до двух
 * букв или общее начало («SINGLE» → SINGLE_ANSWER). Список всех 25 типов в
 * ошибке модель читает хуже, чем одно «did you mean».
 */
export function suggestQuestionTypes(raw: string): CanonicalQuestionType[] {
  const folded = foldSeparators(raw);
  if (!folded) return [];
  const found = new Set<CanonicalQuestionType>();
  for (const [alias, spec] of BY_ALIAS) {
    const prefix = folded.length >= 4 && (alias.startsWith(folded) || folded.startsWith(alias));
    if (prefix || editDistance(folded, alias) <= 2) found.add(spec.type);
  }
  return [...found].slice(0, 3);
}

/**
 * Fold any accepted spelling to the canonical one.
 * @throws when the type is unknown — silently coercing would produce a question
 *         that the renderer drops on the floor at display time.
 */
export function canonicalizeQuestionType(raw: string): CanonicalQuestionType {
  const spec = findQuestionType(raw);
  if (!spec) {
    const guesses = suggestQuestionTypes(raw);
    throw new Error(
      `Unknown question type "${raw}".` +
        (guesses.length ? ` Did you mean ${guesses.join(" or ")}?` : "") +
        ` Supported types: ${CANONICAL_TYPES.join(", ")}. ` +
        `Call feedbay_question_types for what each one does and which config fields it takes.`,
    );
  }
  return spec.type;
}

export function isScreenType(type: string): boolean {
  return findQuestionType(type)?.isScreen === true;
}
