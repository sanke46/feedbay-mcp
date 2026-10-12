/**
 * Survey lifecycle: list, read, create, edit, publish, archive, delete.
 */

import { z } from "zod";
import { buildQuestion, deepMerge, readQuestions, type QuestionInput } from "../domain/questions.js";
import { canonicalizeQuestionType, isScreenType } from "../domain/question-types.js";
import { getDefaultConfig } from "../domain/question-defaults.js";
import { surveyWarnings, warningLine } from "../domain/survey-warnings.js";
import type { Question, Survey } from "../types.js";
import { confirmField, jsonResult, requireConfirmation, type ToolDefinition } from "./shared.js";

const CHANNELS = ["WEBSITE", "EMAIL", "LINK"] as const;
const DISPLAY_MODES = [
  "STANDARD",
  "EMBED",
  "POPUP_CENTER",
  "POPUP_TOP",
  "POPUP_BOTTOM",
  "SLIDE_IN_LEFT",
  "SLIDE_IN_RIGHT",
  "SIDE_TAB",
  "POPOVER",
] as const;

const questionInputSchema = z.object({
  type: z.string().describe("Question type or any accepted alias – see feedbay_question_types."),
  title: z.string().optional().describe("The question text. Defaults to a sensible title for the type."),
  description: z.string().optional().describe("Optional helper text under the question."),
  required: z.boolean().optional().describe("Whether an answer is mandatory. Ignored for welcome/thank-you screens."),
  config: z
    .record(z.unknown())
    .optional()
    .describe("Type-specific settings (options, scale, labels...). Merged over the type's defaults."),
});

/**
 * «Вне папок» в схеме — строка "root", а не `null`: тип `["string","null"]`
 * отвергают Gemini и часть обёрток OpenAI. Пустую строку читаем так же.
 */
function folderOrRoot(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "root" ? value : null;
}

/**
 * «5 вопросов» человек понимает без экранов приветствия и благодарности.
 * Прогон 12.10: модели пересказывали «10 questions» за анкету из восьми.
 */
function countLine(questions: readonly Question[]): string {
  const screens = questions.filter((question) => isScreenType(question.type)).length;
  const asked = questions.length - screens;
  return screens > 0 ? `${asked} questions (+${screens} screens)` : `${asked} questions`;
}

/** A compact view: full surveys carry large config blobs that bury the answer. */
function summarise(survey: Survey, questions: Question[]) {
  return {
    id: survey.id,
    publicId: survey.publicId,
    name: survey.name,
    description: survey.description,
    status: survey.status,
    channel: survey.channel,
    displayMode: survey.displayMode,
    folderId: survey.folderId,
    folderName: survey.folderName,
    responseCount: survey.responseCount,
    questionCount: questions.filter((question) => !isScreenType(question.type)).length,
    questions: questions.map((question) => ({
      id: question.id,
      order: question.order,
      type: question.type,
      title: question.title,
      required: question.required,
    })),
    publishedAt: survey.publishedAt,
    updatedAt: survey.updatedAt,
  };
}

export const surveyTools: ToolDefinition[] = [
  {
    name: "survey_list",
    title: "List surveys",
    description: "Paginated list of surveys, optionally filtered by folder, status or a search term.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      folderId: z.string().optional().describe("Only surveys in this folder."),
      status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional().describe("Only surveys in this state."),
      search: z.string().optional().describe("Free-text match on the survey name."),
      sort: z
        .enum(["updatedAt", "createdAt", "name", "status", "responseCount", "publishedAt"])
        .optional()
        .describe("Sort field (default updatedAt)."),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
      page: z.number().int().min(0).optional().describe("Zero-based page index."),
      size: z.number().int().min(1).max(100).optional().describe("Page size, up to 100 (default 20)."),
    },
    handler: async (args, { client }) => {
      const page = await client.listSurveys(args as never);
      // Без дизайна и конфига: прогон 12.10 — список тащил обе темы каждого
      // опроса, и модели жаловались, что ответ тяжёлый, а нужен им был id.
      return jsonResult(
        `${page.totalElements} surveys, showing page ${page.number + 1} of ${Math.max(page.totalPages, 1)}.`,
        {
          totalElements: page.totalElements,
          totalPages: page.totalPages,
          page: page.number,
          surveys: page.content.map((survey) => ({
            id: survey.id,
            publicId: survey.publicId,
            name: survey.name,
            status: survey.status,
            channel: survey.channel,
            folderId: survey.folderId,
            responseCount: survey.responseCount,
            updatedAt: survey.updatedAt,
          })),
        },
      );
    },
  },
  {
    name: "survey_stats",
    title: "Survey counts",
    description: "How many surveys exist in each state (total, published, draft, archived).",
    readOnly: true,
    idempotent: true,
    inputSchema: { folderId: z.string().optional().describe("Restrict the counts to one folder.") },
    handler: async (args, { client }) => {
      const stats = await client.getSurveyStats(args.folderId as string | undefined);
      return jsonResult(
        `${stats.total} surveys – ${stats.published} published, ${stats.draft} draft, ${stats.archived} archived.`,
        stats,
      );
    },
  },
  {
    name: "survey_get",
    title: "Read a survey",
    description: "One survey with its questions, design and targeting.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id (the UUID, not the public id)."),
      includeRaw: z
        .boolean()
        .optional()
        .describe("Include the full config/design/targeting objects rather than a summary."),
    },
    handler: async (args, { client }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const questions = readQuestions(survey);
      const payload = args.includeRaw
        ? { ...summarise(survey, questions), config: survey.config, design: survey.design, targeting: survey.targeting }
        : summarise(survey, questions);
      return jsonResult(
        `"${survey.name}" – ${survey.status}, ${countLine(questions)}.${warningLine(surveyWarnings(questions))}`,
        payload,
      );
    },
  },
  {
    name: "survey_create",
    title: "Create a survey",
    description:
      "Create a survey, complete in one call: your own questions (or a template), and the design. It starts as " +
      "a draft; publish only when the person asks. Write every text in the person's language – templates are " +
      "in English. Keep it to five questions or fewer besides the welcome/thank-you screens unless the person " +
      "asked for more. Use channel LINK for a link or QR code, WEBSITE for a widget on their site. Do the " +
      "creating – describing a survey you did not create is not done.",
    readOnly: false,
    openWorld: true,
    inputSchema: {
      name: z.string().min(1).max(255).describe("Survey name shown in the dashboard."),
      description: z.string().max(2000).optional().describe("Internal description of the survey."),
      channel: z
        .enum(CHANNELS)
        .optional()
        .describe("How the survey reaches people: WEBSITE (widget), EMAIL or LINK. Defaults to WEBSITE."),
      displayMode: z.enum(DISPLAY_MODES).optional().describe("Widget presentation, for WEBSITE surveys."),
      folderId: z.string().optional().describe("Folder to create the survey in."),
      fromTemplate: z.string().optional().describe('Template id to seed the questions from, e.g. "nps".'),
      questions: z
        .array(questionInputSchema)
        .optional()
        .describe("Questions to create. Appended after template questions when both are given."),
      design: z.record(z.unknown()).optional().describe("Design overrides; see design_update for the fields."),
    },
    handler: async (args, { client }) => {
      const questions: Question[] = [];
      const config: Record<string, unknown> = {};

      if (args.fromTemplate) {
        const template = await client.getTemplate(String(args.fromTemplate));
        config.templateId = template.id;
        for (const templateQuestion of template.questions) {
          const type = canonicalizeQuestionType(templateQuestion.type);
          // Template configs come from the backend's own defaults, which use a
          // different vocabulary than the editor's (`min/max/step` vs `scale`).
          // Layering the editor defaults underneath gives the renderer the keys
          // it actually reads while keeping everything the template specified.
          const templateConfig: Record<string, unknown> = { ...(templateQuestion.config ?? {}) };
          if (templateQuestion.options?.length) templateConfig.options = templateQuestion.options;
          questions.push(
            buildQuestion(
              {
                type,
                title: templateQuestion.title,
                ...(templateQuestion.description ? { description: templateQuestion.description } : {}),
                required: templateQuestion.required,
                config: deepMerge(getDefaultConfig(type), templateConfig),
              },
              questions.length,
            ),
          );
        }
      }

      for (const input of (args.questions as QuestionInput[] | undefined) ?? []) {
        questions.push(buildQuestion(input, questions.length));
      }
      if (questions.length > 0) config.questions = questions;

      const survey = await client.createSurvey({
        name: String(args.name),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        channel: (args.channel as string | undefined) ?? "WEBSITE",
        ...(args.displayMode ? { displayMode: String(args.displayMode) } : {}),
        ...(args.folderId ? { folderId: String(args.folderId) } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
        ...(args.design ? { design: args.design as Record<string, unknown> } : {}),
      });

      return jsonResult(
        `Created draft "${survey.name}" with ${countLine(questions)} (id ${survey.id}).` +
          warningLine(surveyWarnings(questions)),
        summarise(survey, questions),
      );
    },
  },
  {
    name: "survey_update",
    title: "Update survey settings",
    description:
      "Change a survey's name, description, channel, display mode or folder. " +
      "Questions are edited with the question_* tools and styling with design_update.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      name: z.string().min(1).max(255).optional().describe("New name."),
      description: z.string().max(2000).optional().describe("New description."),
      channel: z.enum(CHANNELS).optional().describe("New channel."),
      displayMode: z.enum(DISPLAY_MODES).optional().describe("New widget presentation."),
      folderId: z
        .string()
        .optional()
        .describe('Move to this folder; "root" takes the survey out of any folder.'),
    },
    handler: async (args, { client }) => {
      const { surveyId, ...rest } = args;
      const payload = Object.fromEntries(
        Object.entries(rest)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, key === "folderId" ? folderOrRoot(value) : value]),
      );
      const survey = await client.updateSurvey(String(surveyId), payload as never);
      return jsonResult(`Updated "${survey.name}".`, summarise(survey, readQuestions(survey)));
    },
  },
  {
    name: "survey_set_status",
    title: "Publish / unpublish / archive",
    description:
      "Move a survey between states. `publish` makes it collect responses (fails with PLAN_REQUIRED on a free " +
      "account and QUOTA_EXCEEDED when the account quota is used up), `unpublish` takes it back to a draft – the " +
      "link stops answering, responses stay – `archive` takes it out of the active list, `unarchive` brings it back.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      action: z.enum(["publish", "unpublish", "archive", "unarchive"]).describe("State change to apply."),
      confirm: confirmField.describe("Required only for `archive`, which takes the survey out of the active list."),
    },
    handler: async (args, { client }) => {
      const action = args.action as "publish" | "unpublish" | "archive" | "unarchive";
      if (action === "archive") {
        const blocked = requireConfirmation(
          args.confirm,
          "Archiving stops the survey from collecting responses and removes it from the active list. " +
            "It is reversible with `unarchive`, but it does take a live survey offline.",
        );
        if (blocked) return blocked;
      }
      const survey = await client.surveyAction(String(args.surveyId), action);
      const questions = readQuestions(survey);
      return jsonResult(
        `"${survey.name}" is now ${survey.status}.` +
          (survey.status === "PUBLISHED" ? warningLine(surveyWarnings(questions)) : ""),
        summarise(survey, questions),
      );
    },
  },
  {
    name: "survey_duplicate",
    title: "Duplicate a survey",
    description: "Copy a survey, including its questions and design, as a new draft.",
    readOnly: false,
    inputSchema: { surveyId: z.string().describe("Survey to copy.") },
    handler: async (args, { client }) => {
      const survey = await client.duplicateSurvey(String(args.surveyId));
      return jsonResult(`Duplicated as "${survey.name}" (id ${survey.id}).`, summarise(survey, readQuestions(survey)));
    },
  },
  {
    name: "survey_move",
    title: "Move to a folder",
    description:
      'Move a survey into a folder, or out of every folder with folderId "root". Archived folders are rejected.',
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      folderId: z.string().describe('Destination folder id, or "root" to take the survey out of any folder.'),
    },
    handler: async (args, { client }) => {
      const survey = await client.moveSurvey(String(args.surveyId), folderOrRoot(args.folderId));
      return jsonResult(`"${survey.name}" moved to ${survey.folderName ?? "the root"}.`, {
        id: survey.id,
        folderId: survey.folderId,
        folderName: survey.folderName,
      });
    },
  },
  {
    name: "survey_delete",
    title: "Delete a survey",
    description:
      "Delete a survey: it and its responses disappear from the dashboard, and FeedBay has no undo for this. " +
      "The rows stay in the database, so support can still restore them on request. For a full wipe, archive " +
      "the survey and then use survey_delete_permanent.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      confirm: confirmField,
    },
    handler: async (args, { client }) => {
      const blocked = requireConfirmation(
        args.confirm,
        "The survey and its responses disappear from the dashboard, and there is no undo in FeedBay.",
      );
      if (blocked) return blocked;
      await client.deleteSurvey(String(args.surveyId));
      return jsonResult("Survey deleted.", { surveyId: args.surveyId, deleted: true });
    },
  },
  {
    name: "survey_delete_permanent",
    title: "Delete a survey forever",
    description:
      "Physically delete an archived survey and every response it collected. Nothing restores this. " +
      "The survey must already be ARCHIVED – archive it first with survey_set_status.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      surveyId: z.string().describe("Archived survey id."),
      confirm: confirmField,
    },
    handler: async (args, { client }) => {
      const blocked = requireConfirmation(
        args.confirm,
        "The survey and all of its collected responses are erased from the database with no way back.",
      );
      if (blocked) return blocked;
      await client.permanentlyDeleteSurvey(String(args.surveyId));
      return jsonResult("Survey permanently deleted.", { surveyId: args.surveyId, deleted: true });
    },
  },
];
