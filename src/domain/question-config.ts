/**
 * The shape a question's config must have before it is stored.
 *
 * WHY THIS EXISTS. The backend keeps `config` as jsonb and never looks inside,
 * and the tools take it as a free-form record — so whatever the model invents
 * is saved and the tool reports success. The tester's survey (Trello, 25.09)
 * showed three ways this breaks a real survey:
 *  - options sent as `[{label: "Карта"}, …]` — the preview copes, the editor
 *    prints "[object Object]" in every option field;
 *  - contact fields sent without `id` — the renderer keys answers by `field.id`,
 *    so all three fields shared one value under the key "undefined", the email
 *    check failed on the name, and nobody could submit the survey;
 *  - `style: "filled_stars"` — accepted silently, rendered as the default star,
 *    so the model saw no error and needed three attempts to make stars filled.
 *
 * Shapes are repaired where the intent is unambiguous (a label is a label, a
 * missing id can be made up) and refused with the list of valid values where it
 * is not (an icon set nobody has heard of).
 */

import type { CanonicalQuestionType } from "./question-types.js";

/** Types whose `options` are plain strings in the editor and the renderer. */
const STRING_OPTION_TYPES: ReadonlySet<string> = new Set(["SINGLE_ANSWER", "MULTIPLE_ANSWER", "DROPDOWN"]);

/** Types that take an icon set in `style`. */
const ICON_STYLE_TYPES: ReadonlySet<string> = new Set(["RATING_SCALE", "CSAT", "CES"]);

export const RATING_STYLES = ["stars", "hearts", "smileys", "thumbs", "lightning", "emoji", "numbers"] as const;
export const ICON_VARIANTS = ["filled", "outlined"] as const;
export const CONTACT_FIELD_TYPES = ["text", "email", "phone", "select", "textarea"] as const;

/** A refusal the tool shows to the model as-is, so it can correct the call. */
export class QuestionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "Карта", {label:"Карта"}, {value:"Карта"}, {text:"Карта"} → "Карта". */
function optionText(option: unknown, index: number): string {
  if (typeof option === "string") return option;
  if (typeof option === "number" || typeof option === "boolean") return String(option);
  if (isPlainObject(option)) {
    for (const key of ["label", "value", "text", "title", "name"]) {
      const candidate = option[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return `Option ${index + 1}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Contact fields as the renderer needs them: objects with a unique `id`.
 * Ids are made from the type for the obvious fields (email, phone), then the
 * label, then the position — stable enough that re-saving the same list keeps
 * the same ids, so answers already collected stay matched to their field.
 */
export function normalizeContactFields(fields: unknown): Record<string, unknown>[] {
  if (!Array.isArray(fields)) return [];
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = base || "field";
    for (let n = 2; used.has(id); n += 1) id = `${base || "field"}_${n}`;
    used.add(id);
    return id;
  };

  return fields.map((raw, index) => {
    const field: Record<string, unknown> = isPlainObject(raw)
      ? { ...raw }
      : { label: typeof raw === "string" ? raw : `Field ${index + 1}` };

    // A bare "email" / "phone" from a template is both the type and the label.
    if (typeof raw === "string" && (CONTACT_FIELD_TYPES as readonly string[]).includes(raw)) {
      field.type = raw;
    }
    const type = typeof field.type === "string" && (CONTACT_FIELD_TYPES as readonly string[]).includes(field.type)
      ? field.type
      : "text";
    field.type = type;
    if (typeof field.label !== "string" || !field.label.trim()) field.label = `Field ${index + 1}`;
    if (typeof field.required !== "boolean") field.required = false;
    field.order = index;

    const given = typeof field.id === "string" ? field.id.trim() : "";
    const base = given || (type === "email" || type === "phone" ? type : slug(String(field.label)) || `field_${index + 1}`);
    field.id = given && !used.has(given) ? (used.add(given), given) : unique(base);
    return field;
  });
}

function assertOneOf(value: unknown, allowed: readonly string[], key: string, type: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new QuestionConfigError(
      `${type} config.${key} must be one of ${allowed.map((v) => `"${v}"`).join(", ")} – got ${JSON.stringify(value)}.` +
        (key === "style" ? ' Filled stars are style "stars" with iconVariant "filled".' : ""),
    );
  }
}

/**
 * The config to store for a question of `type`. Throws QuestionConfigError on a
 * value that cannot be repaired.
 *
 * `checked` limits the refusals to the keys the caller is sending now. Repairs
 * always run — an old question with object options is fixed on its next edit —
 * but a legacy value nobody touched must not make an unrelated edit (a new
 * title) fail.
 */
export function normalizeQuestionConfig(
  type: CanonicalQuestionType | string,
  config: Record<string, unknown>,
  checked: Record<string, unknown> = config,
): Record<string, unknown> {
  const next = { ...config };

  if (STRING_OPTION_TYPES.has(type) && Array.isArray(next.options)) {
    next.options = next.options.map(optionText);
  }

  if (type === "CONTACT_FORM" && next.fields !== undefined) {
    next.fields = normalizeContactFields(next.fields);
  }

  if (ICON_STYLE_TYPES.has(type)) {
    if ("style" in checked) assertOneOf(next.style, RATING_STYLES, "style", type);
    if ("iconVariant" in checked) assertOneOf(next.iconVariant, ICON_VARIANTS, "iconVariant", type);
  }

  return next;
}
