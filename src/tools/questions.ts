/**
 * Composing a survey's questions.
 *
 * `Survey.config.questions[]` has no dedicated endpoints — the dashboard PUTs
 * the whole survey on every edit. So each tool here re-reads the survey, changes
 * the list, and writes it back. Nothing is cached between calls: two chats
 * editing the same survey would otherwise overwrite each other silently.
 */

import { z } from "zod";
import {
  countLine,
  buildQuestion,
  configWithQuestions,
  patchQuestion,
  readQuestions,
  renumber,
  type QuestionInput,
} from "../domain/questions.js";
import type { FeedBayClient } from "../client/endpoints.js";
import { surveyWarnings, warningLine } from "../domain/survey-warnings.js";
import type { Question } from "../types.js";
import {
  confirmField,
  failResult,
  jsonResult,
  requireConfirmation,
  type MediaFile,
  type MediaResolver,
  type ToolDefinition,
} from "./shared.js";

const questionInputSchema = z.object({
  type: z.string().describe("Question type or accepted alias – see feedbay_question_types."),
  title: z.string().optional().describe("The question text. Defaults to a sensible title for the type."),
  description: z.string().optional().describe("Optional helper text under the question."),
  required: z.boolean().optional().describe("Whether an answer is mandatory."),
  config: z.record(z.unknown()).optional().describe("Type-specific settings, merged over the type's defaults."),
});

/** Read the survey, apply `mutate`, write the new list back. */
async function withQuestions(
  client: FeedBayClient,
  surveyId: string,
  mutate: (questions: Question[]) => Question[],
): Promise<{ questions: Question[]; name: string; locale?: string }> {
  const survey = await client.getSurvey(surveyId);
  const next = renumber(mutate(readQuestions(survey)));
  const updated = await client.updateSurvey(surveyId, { config: configWithQuestions(survey, next) });
  return { questions: readQuestions(updated), name: updated.name, locale: localeOf(updated) };
}

/** Язык интерфейса опроса из дизайна — для предупреждения о кнопках. */
function localeOf(survey: { design?: unknown }): string | undefined {
  const locale = (survey.design as { locale?: unknown } | undefined)?.locale;
  return typeof locale === "string" ? locale : undefined;
}

/**
 * Check the links in `config.media` before they are stored.
 *
 * НАЙДЕНО ТЕСТИРОВЩИКОМ (Trello QXZI4KJu, 25.09): ссылку на СТРАНИЦУ фото с
 * Unsplash модель положила в медиа как картинку — в опросе оказалось не то, а
 * в редакторе «Image • 0 B». Где хост умеет (`context.media`, чат в продукте),
 * каждая чужая ссылка проверяется сервером: картинка перекладывается к нам,
 * страница отдаёт свою картинку-превью, не-медиа — отказ с объяснением.
 * Ссылки на наше хранилище не трогаются.
 */
async function resolveMediaLinks(
  config: Record<string, unknown> | undefined,
  media: MediaResolver | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!config || !media || !config.media || typeof config.media !== "object") return config;
  const value = config.media as Record<string, unknown>;
  const kind = value.kind;

  const check = async (raw: unknown, expected: "image" | "video" | "audio"): Promise<unknown> => {
    if (!raw || typeof raw !== "object") return raw;
    const item = raw as Record<string, unknown>;
    if (typeof item.url !== "string" || media.isOwnUrl(item.url)) return raw;
    const found = await media.fromUrl(item.url);
    if (found.kind !== expected) {
      throw new Error(
        `The link ${item.url} is ${found.kind === "image" ? "an image" : `a ${found.kind} file`}, not ${
          expected === "image" ? "an image" : `a ${expected} file`
        }. Use media kind "${found.kind}" for it.`,
      );
    }
    const named: MediaFile = {
      ...found.item,
      name: typeof item.name === "string" && item.name.trim() ? item.name : found.item.name,
    };
    return { ...item, ...named };
  };

  if (kind === "image" && Array.isArray(value.items)) {
    const items = [];
    for (const item of value.items) items.push(await check(item, "image"));
    return { ...config, media: { ...value, items } };
  }
  if ((kind === "video" || kind === "audio") && value.item) {
    return { ...config, media: { ...value, item: await check(value.item, kind) } };
  }
  return config;
}

const listView = (questions: readonly Question[]) =>
  questions.map((question) => ({
    id: question.id,
    order: question.order,
    type: question.type,
    title: question.title,
    description: question.description,
    required: question.required,
    config: question.config,
  }));

export const questionTools: ToolDefinition[] = [
  {
    name: "question_list",
    title: "List questions",
    description: "Every question on a survey, in order, with its type-specific config.",
    readOnly: true,
    idempotent: true,
    inputSchema: { surveyId: z.string().describe("Survey id.") },
    handler: async (args, { client }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const questions = readQuestions(survey);
      // На чтении предупреждения — только в данных: в первой строке они
      // повторялись на каждом вызове, и модели пересказывали их человеку
      // снова и снова (прогон 12.10.2026). Громко — там, где что-то меняют.
      const warnings = surveyWarnings(questions, localeOf(survey));
      return jsonResult(`"${survey.name}" has ${countLine(questions)}.`, {
        questions: listView(questions),
        ...(warnings.length ? { warnings } : {}),
      });
    },
  },
  {
    name: "question_add",
    title: "Add a question",
    description:
      "Add one question. Anything you leave out gets that type's defaults, as when added in the dashboard.",
    readOnly: false,
    openWorld: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      type: z.string().describe("Question type or accepted alias – see feedbay_question_types."),
      title: z.string().optional().describe("The question text."),
      description: z.string().optional().describe("Optional helper text."),
      required: z.boolean().optional().describe("Whether an answer is mandatory."),
      config: z.record(z.unknown()).optional().describe("Type-specific settings, merged over the defaults."),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Zero-based insert position. Omitted: last question, before the thank-you screen."),
    },
    handler: async (args, { client, media }) => {
      const config = await resolveMediaLinks(args.config as Record<string, unknown> | undefined, media);
      const input: QuestionInput = {
        type: String(args.type),
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(args.required !== undefined ? { required: Boolean(args.required) } : {}),
        ...(config ? { config } : {}),
      };
      let added: Question | undefined;

      const { questions, name, locale } = await withQuestions(client, String(args.surveyId), (current) => {
        added = buildQuestion(input, current.length);
        // Без позиции — последним вопросом, но перед экраном благодарности:
        // «в конец» ставило вопрос после «Спасибо!», и респондент видел его
        // уже за финалом (английский прогон матрицы, S5, Opus). Сам экран
        // благодарности по-прежнему уходит в самый конец.
        let end = current.length;
        if (added.type !== "THANK_YOU") {
          while (end > 0 && current[end - 1]!.type === "THANK_YOU") end -= 1;
        }
        const at = typeof args.position === "number" ? Math.min(args.position, current.length) : end;
        const next = [...current];
        next.splice(at, 0, added);
        return next;
      });

      return jsonResult(
        `Added a ${added?.type} question to "${name}". It now has ${countLine(questions)}.` +
          warningLine(surveyWarnings(questions, locale)),
        {
        // Идентификатор опроса — для перехода к добавленному вопросу
        // (`destination.ts`). Без него подсказка навигации не собиралась
        // вовсе: нагрузка знала про вопрос, но не про то, где он лежит.
        id: String(args.surveyId),
        added: added?.id,
        questions: listView(questions),
      });
    },
  },
  {
    name: "question_update",
    title: "Edit a question",
    description:
      "Change one question in place. `config` is merged field by field, so sending only `{ scale: 7 }` keeps " +
      "the rest of the settings. Arrays such as `options` are replaced wholesale.",
    readOnly: false,
    openWorld: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questionId: z.string().describe("Question id, from question_list."),
      type: z.string().optional().describe("Change the type. Missing config for the new type is filled in."),
      title: z.string().optional().describe("New question text."),
      description: z.string().optional().describe("New helper text."),
      required: z.boolean().optional().describe("Whether an answer is mandatory."),
      config: z.record(z.unknown()).optional().describe("Type-specific settings to merge in."),
    },
    handler: async (args, { client, media }) => {
      const questionId = String(args.questionId);
      const config = await resolveMediaLinks(args.config as Record<string, unknown> | undefined, media);
      let found = false;

      const { questions, name, locale } = await withQuestions(client, String(args.surveyId), (current) =>
        current.map((question) => {
          if (question.id !== questionId) return question;
          found = true;
          return patchQuestion(question, {
            ...(args.type !== undefined ? { type: String(args.type) } : {}),
            ...(args.title !== undefined ? { title: String(args.title) } : {}),
            ...(args.description !== undefined ? { description: String(args.description) } : {}),
            ...(args.required !== undefined ? { required: Boolean(args.required) } : {}),
            ...(config ? { config } : {}),
          });
        }),
      );

      if (!found) {
        return failResult(
          `No question with id "${questionId}" on that survey. Call question_list to see the current ids.`,
        );
      }
      return jsonResult(`Updated a question on "${name}".${warningLine(surveyWarnings(questions, locale))}`, listView(questions));
    },
  },
  {
    name: "question_media_from_attachment",
    title: "Put attached pictures on a question",
    description:
      "Show pictures the person attached in this chat on one question (between its text and the answers). " +
      "The files are copied to FeedBay's storage. Use this – not a file path or a made-up link – whenever " +
      "the person attaches a picture for a question. Replaces any media the question had.",
    readOnly: false,
    idempotent: true,
    // Вложения бывают только в чате. Внешнему клиенту этот инструмент всегда
    // отвечал бы отказом, так что он его и не видит.
    available: ({ media }) => media?.fromAttachment !== undefined,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questionId: z.string().describe("Question id, from question_list."),
      attachmentIds: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Ids from the "Attachment <id>" labels next to the pictures in the conversation, in display order.'),
    },
    handler: async (args, { client, media }) => {
      if (!media?.fromAttachment) {
        return failResult(
          "Attached files are not available here. Ask for a public https link to the picture and set it with " +
            'question_update as config.media {kind:"image", items:[{url}]}.',
        );
      }
      const questionId = String(args.questionId);
      const survey = await client.getSurvey(String(args.surveyId));
      if (!readQuestions(survey).some((question) => question.id === questionId)) {
        return failResult(`No question with id "${questionId}" on that survey. Call question_list to see the current ids.`);
      }

      const items: MediaFile[] = [];
      for (const id of args.attachmentIds as string[]) items.push(await media.fromAttachment(String(id)));

      const { questions, name, locale } = await withQuestions(client, survey.id, (current) =>
        current.map((question) =>
          question.id === questionId
            ? patchQuestion(question, { config: { media: { kind: "image", items }, mediaEnabled: true } })
            : question,
        ),
      );
      return jsonResult(
        `Added ${items.length === 1 ? "the picture" : `${items.length} pictures`} to a question on "${name}".`,
        { id: survey.id, questionId, media: { kind: "image", items }, questions: listView(questions) },
      );
    },
  },
  {
    name: "question_delete",
    title: "Delete a question",
    description: "Remove one question and renumber the rest. Answers already collected for it stay in the responses.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questionId: z.string().describe("Question id, from question_list."),
      confirm: confirmField,
    },
    handler: async (args, { client }) => {
      const blocked = requireConfirmation(
        args.confirm,
        "The question disappears from the survey. Answers already collected for it remain in the response data " +
          "but no longer have a question to belong to.",
      );
      if (blocked) return blocked;

      const questionId = String(args.questionId);
      let found = false;
      const { questions, name, locale } = await withQuestions(client, String(args.surveyId), (current) => {
        found = current.some((question) => question.id === questionId);
        return current.filter((question) => question.id !== questionId);
      });

      if (!found) return failResult(`No question with id "${questionId}" on that survey.`);
      return jsonResult(`Deleted a question from "${name}"; ${questions.length} remain.`, listView(questions));
    },
  },
  {
    name: "question_reorder",
    title: "Reorder questions",
    description: "Set the question order by listing every question id in the order you want them shown.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questionIds: z
        .array(z.string())
        .min(1)
        .describe("All question ids in the new order. Must contain exactly the survey's current questions."),
    },
    handler: async (args, { client }) => {
      const requested = (args.questionIds as string[]).map(String);
      let mismatch: string | null = null;

      const { questions, name, locale } = await withQuestions(client, String(args.surveyId), (current) => {
        const byId = new Map(current.map((question) => [question.id, question]));
        const unknown = requested.filter((id) => !byId.has(id));
        const absent = current.filter((question) => !requested.includes(question.id)).map((question) => question.id);
        if (unknown.length > 0 || absent.length > 0) {
          mismatch =
            "The id list must name every current question exactly once. " +
            `Unknown ids: ${unknown.join(", ") || "none"}. Missing ids: ${absent.join(", ") || "none"}.`;
          return current;
        }
        return requested.map((id) => byId.get(id) as Question);
      });

      if (mismatch) return failResult(mismatch);
      return jsonResult(`Reordered the questions on "${name}".`, listView(questions));
    },
  },
  {
    name: "questions_replace",
    title: "Replace all questions",
    description:
      "Overwrite the whole question list in one call – the tool to use when generating a survey from a brief. " +
      "Every existing question is discarded, so read question_list first if you mean to keep any.",
    readOnly: false,
    openWorld: true,
    destructive: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questions: z.array(questionInputSchema).min(1).describe("The complete new question list, in display order."),
      confirm: confirmField,
    },
    handler: async (args, { client, media }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const existing = readQuestions(survey);
      if (existing.length > 0) {
        const blocked = requireConfirmation(
          args.confirm,
          `"${survey.name}" already has ${existing.length} questions and all of them will be discarded.`,
        );
        if (blocked) return blocked;
      }

      const inputs: QuestionInput[] = [];
      for (const input of args.questions as QuestionInput[]) {
        const config = await resolveMediaLinks(input.config, media);
        inputs.push(config ? { ...input, config } : input);
      }
      const next = inputs.map((input, index) => buildQuestion(input, index));
      const updated = await client.updateSurvey(survey.id, { config: configWithQuestions(survey, next) });
      const questions = readQuestions(updated);
      return jsonResult(
        `"${updated.name}" now has ${countLine(questions)}.${warningLine(surveyWarnings(questions, localeOf(updated)))}`,
        listView(questions),
      );
    },
  },
];
