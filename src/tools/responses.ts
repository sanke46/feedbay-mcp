/**
 * Reading collected data and handing it out.
 *
 * `/results/overview` is the only aggregate the API offers, and it tallies every
 * question as if it were a multiple-choice one. Everything else — geography,
 * device, channel, time series, durations — is computed here from the raw
 * response rows, which already carry those fields.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readQuestions } from "../domain/questions.js";
import { buildBreakdown, buildSegments, readableQuestionStats } from "../domain/aggregate.js";
import type { FeedBayClient } from "../client/endpoints.js";
import type { SurveyResponseItem } from "../types.js";
import { PathOutsideRootError, resolveToolPath } from "./paths.js";
import { confirmField, failResult, jsonResult, requireConfirmation, type ToolDefinition } from "./shared.js";

/** Page size the dashboard itself uses when it needs every response. */
const FETCH_PAGE_SIZE = 200;
/** Ceiling on a single breakdown, so one call cannot page through a huge survey forever. */
const MAX_FETCHED_RESPONSES = 5000;
/** CSV shorter than this is returned inline; anything larger is only written to disk. */
const MAX_INLINE_CSV_CHARS = 100_000;
/** Export files larger than this are not attached to the reply. */
const MAX_ATTACHED_BYTES = 5 * 1024 * 1024;

/**
 * Page through every response, up to the ceiling.
 * Returns `truncated` so the caller is told when the numbers cover only part of
 * the data rather than quietly reporting a partial total as the whole.
 */
async function fetchAllResponses(
  client: FeedBayClient,
  surveyId: string,
): Promise<{ responses: SurveyResponseItem[]; total: number; truncated: boolean }> {
  const collected: SurveyResponseItem[] = [];
  let page = 0;
  let total = 0;

  for (;;) {
    const result = await client.listResponses(surveyId, { page, size: FETCH_PAGE_SIZE, sort: "startedAt", order: "asc" });
    total = result.totalElements;
    collected.push(...result.content);
    page += 1;
    if (result.last || result.content.length === 0 || collected.length >= MAX_FETCHED_RESPONSES) break;
  }

  return {
    responses: collected.slice(0, MAX_FETCHED_RESPONSES),
    total,
    truncated: total > collected.length || collected.length > MAX_FETCHED_RESPONSES,
  };
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "survey";
}

export const responseTools: ToolDefinition[] = [
  {
    name: "response_list",
    title: "List responses",
    description:
      "One page of individual responses, each with its answers (keyed by question id – see `questions` for the " +
      "titles), country, device, channel and duration. For totals and cross-sections use results_overview and " +
      "results_breakdown instead of paging by hand.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      page: z.number().int().min(0).optional().describe("Zero-based page index."),
      size: z.number().int().min(1).max(200).optional().describe("Page size, up to 200 (default 20)."),
      sort: z
        .enum(["startedAt", "completedAt", "createdAt", "responseNumber"])
        .optional()
        .describe("Sort field (default startedAt)."),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
      search: z.string().optional().describe("Matches response number, visitor id, IP or answer text."),
    },
    handler: async (args, { client }) => {
      const { surveyId, ...params } = args;
      const [survey, page] = await Promise.all([
        client.getSurvey(String(surveyId)),
        client.listResponses(String(surveyId), params as never),
      ]);
      // Без IP, user agent, referrer и служебных id: модели клиента они не
      // нужны для разбора, а это персональные данные и лишние токены. Зато
      // заголовки вопросов рядом — иначе ответы по id не прочитать без
      // отдельного question_list (прогон 12.10: так делали все три модели).
      return jsonResult(
        `${page.totalElements} responses, showing page ${page.number + 1} of ${Math.max(page.totalPages, 1)}.`,
        {
          totalElements: page.totalElements,
          totalPages: page.totalPages,
          page: page.number,
          questions: Object.fromEntries(readQuestions(survey).map((question) => [question.id, question.title])),
          responses: page.content.map((response) => ({
            id: response.id,
            responseNumber: response.responseNumber,
            completed: response.completed,
            startedAt: response.startedAt,
            completedAt: response.completedAt,
            durationSeconds: response.durationSeconds,
            channel: response.channel,
            country: response.countryName,
            device: response.device,
            answers: response.answers,
          })),
        },
      );
    },
  },
  {
    name: "response_get",
    title: "Read one response",
    description: "A single response with its full answer map and metadata.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      responseId: z.string().describe("Response id, from response_list."),
    },
    handler: async (args, { client }) => {
      const response = await client.getResponse(String(args.surveyId), String(args.responseId));
      return jsonResult(`Response #${response.responseNumber ?? "?"} of survey ${args.surveyId}.`, response);
    },
  },
  {
    name: "response_delete",
    title: "Delete a response",
    description: "Permanently delete one response. The survey's response count drops by one. There is no undo.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      responseId: z.string().describe("Response id."),
      confirm: confirmField,
    },
    handler: async (args, { client }) => {
      const blocked = requireConfirmation(args.confirm, "This response and its answers are erased with no way back.");
      if (blocked) return blocked;
      await client.deleteResponse(String(args.surveyId), String(args.responseId));
      return jsonResult("Response deleted.", { responseId: args.responseId, deleted: true });
    },
  },
  {
    name: "results_overview",
    title: "Results summary",
    description:
      "The backend's own summary: the viewed -> started -> completed funnel, totals, completion rate, average " +
      "completion time and a per-question tally. " +
      "Note the tally counts raw answer values for every question type, so for rating questions it reads as a " +
      "distribution rather than an average.",
    // Оговорки к числам переехали сюда из описания ДОСЛОВНО. Они не советы:
    // без них «80% конверсии» — это доля от начавших, выданная за долю от
    // увидевших, а показы — нижняя граница, выданная за факт. Правка описания
    // из админки их не стирает.
    invariants: [
      "Views and starts are reported by the respondent's browser, so they are a lower bound – ad blockers " +
        "drop them while the response still arrives; completions are counted on the server.",
      "completionRate is completed/responses and ignores everyone who never started, so quote " +
        "startToCompleteRate when asked how well a survey converts.",
    ],
    readOnly: true,
    idempotent: true,
    inputSchema: { surveyId: z.string().describe("Survey id.") },
    handler: async (args, { client }) => {
      const [overview, survey] = await Promise.all([
        client.getResultsOverview(String(args.surveyId)),
        // Без опроса итоги остаются как прислал бэкенд — это не повод падать.
        Promise.resolve()
          .then(() => client.getSurvey(String(args.surveyId)))
          .catch(() => null),
      ]);
      // Воронка в первой строке, если бэкенд её прислал: агент читает
      // сводку раньше, чем JSON, и «40 из 50» без знаменателя показов —
      // ровно то число, которое раньше вводило в заблуждение.
      const funnel =
        overview.viewedCount !== undefined
          ? ` Funnel: ${overview.viewedCount} viewed -> ${overview.startedCount} started ` +
            `(${overview.viewToStartRate}%) -> ${overview.completedResponses} completed ` +
            `(${overview.startToCompleteRate}%).`
          : "";
      return jsonResult(
        `"${overview.surveyName}": ${overview.completedResponses}/${overview.totalResponses} completed ` +
          `(${overview.completionRate}%).${funnel}`,
        survey
          ? { ...overview, questionStats: readableQuestionStats(overview.questionStats ?? [], readQuestions(survey)) }
          : overview,
      );
    },
  },
  {
    name: "results_breakdown",
    title: "Cross-sections of the responses",
    description:
      "Responses split by country, device, channel and day, plus duration; with segmentBy, NPS, averages and " +
      "comments for each answer of that question. One page fetch per 200 responses.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      segmentBy: z.string().optional().describe("Question id (from question_list) to split the scores by."),
    },
    handler: async (args, { client }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const questions = readQuestions(survey);
      const segmentQuestion = args.segmentBy ? questions.find((question) => question.id === args.segmentBy) : undefined;
      if (args.segmentBy && !segmentQuestion) {
        return failResult(
          `"${survey.name}" has no question with id ${String(args.segmentBy)}. Question ids come from question_list.`,
        );
      }
      const { responses, total, truncated } = await fetchAllResponses(client, survey.id);
      const breakdown = buildBreakdown(responses);
      const segments = segmentQuestion ? buildSegments(responses, questions, segmentQuestion) : undefined;

      const caveat = truncated
        ? ` Computed from the first ${responses.length} of ${total} responses – the rest were not fetched.`
        : "";
      const segmentLine = segments
        ? ` Split by "${segments.segmentBy.title}" into ${segments.segments.length} groups.`
        : "";
      return jsonResult(
        `"${survey.name}": ${breakdown.completedResponses}/${breakdown.totalResponses} completed ` +
          `(${breakdown.completionRate}%).${segmentLine}${caveat}`,
        {
          // Сегменты первыми: чат режет длинный вывод с конца, и лучше потерять посуточные данные.
          ...(segments ? { segments } : {}),
          ...breakdown,
          analysedResponses: responses.length,
          totalResponses: total,
          truncated,
        },
      );
    },
  },
  {
    name: "responses_export",
    title: "Export responses",
    description:
      "Export every response as CSV or Excel, returned in the reply so it can be read or forwarded straight " +
      "away. A server running on the person's own computer also saves the file to its download folder; the " +
      "hosted server keeps no copy. Rate-limited to 10 exports per hour.",
    readOnly: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      format: z.enum(["csv", "excel"]).optional().describe("Export format (default csv)."),
      outputPath: z.string().optional().describe("Where to write the file. Defaults to the server's download dir."),
    },
    handler: async (args, { client, config }) => {
      const format = (args.format as "csv" | "excel" | undefined) ?? "csv";
      const survey = await client.getSurvey(String(args.surveyId));
      const { bytes, contentType } = await client.exportResponses(survey.id, format);

      const extension = format === "csv" ? "csv" : "xlsx";
      // На нашем сервере путь из аргументов запирается в каталог выгрузок:
      // прежде здесь стоял голый `resolve`, то есть выбранный моделью путь
      // писался куда угодно. На машине самого пользователя ограничения нет —
      // решает `filesystemOwner`, см. tools/paths.ts.
      // На хостинге диск наш, а не человека: путь вида /tmp/exports/... ему
      // ничего не даёт (прогон 12.10), а файлы копились бы на сервере.
      const keepsCopy = config.filesystemOwner !== "server";
      let target: string;
      try {
        target = args.outputPath
          ? resolveToolPath(String(args.outputPath), config, `The export path "${String(args.outputPath)}"`)
          : join(config.downloadDir, `${safeFileName(survey.name)}-responses.${extension}`);
      } catch (error) {
        if (error instanceof PathOutsideRootError) return failResult(error.message);
        throw error;
      }

      let savedTo: string | null = null;
      let saveError: string | null = null;
      if (keepsCopy) {
        try {
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, bytes);
          savedTo = target;
        } catch (error) {
          // A read-only or containerised filesystem is a normal deployment, not a
          // failure — the inline copy below still delivers the data.
          saveError = (error as Error).message;
        }
      }

      const content: Array<Record<string, unknown>> = [];
      const sizeKb = (bytes.byteLength / 1024).toFixed(1);
      const summary =
        `Exported ${survey.responseCount} responses of "${survey.name}" as ${format} (${sizeKb} KB).` +
        (savedTo
          ? ` Saved to ${savedTo}.`
          : keepsCopy
            ? ` Not saved to disk: ${saveError}.`
            : " The file is in this reply; the hosted server keeps no copy.");
      content.push({ type: "text", text: summary });

      if (format === "csv") {
        const text = Buffer.from(bytes).toString("utf8");
        content.push({
          type: "text",
          text:
            text.length <= MAX_INLINE_CSV_CHARS
              ? text
              : `${text.slice(0, MAX_INLINE_CSV_CHARS)}\n… truncated;` +
                (savedTo ? " the complete file is on disk." : " export as excel for the complete file."),
        });
      } else if (bytes.byteLength <= MAX_ATTACHED_BYTES) {
        content.push({
          type: "resource",
          resource: {
            uri: `feedbay://survey/${survey.id}/export.xlsx`,
            mimeType: contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            blob: Buffer.from(bytes).toString("base64"),
          },
        });
      }

      return { content } as never;
    },
  },
];
