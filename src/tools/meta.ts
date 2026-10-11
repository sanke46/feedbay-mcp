/**
 * Orientation tools: who the server acts as, and what building blocks exist.
 */

import { z } from "zod";
import { MEDIA_CONFIG_FIELDS } from "../domain/question-media.js";
import { QUESTION_TYPES } from "../domain/question-types.js";
import { jsonResult, type ToolDefinition } from "./shared.js";

export const metaTools: ToolDefinition[] = [
  {
    name: "feedbay_whoami",
    title: "Account and quota",
    description:
      "The FeedBay account this server acts as, plus its response quota. Check this first when a " +
      "publish fails with QUOTA_EXCEEDED – collecting responses stops once the quota is used up.",
    readOnly: true,
    idempotent: true,
    handler: async (_args, { client, config }) => {
      const [profile, quota] = await Promise.all([client.getProfile(), client.getResponseLimit()]);
      // Безлимитный аккаунт описывается словами, а не числом: бэкенд кладёт в
      // total/remaining миллиард как страховку для несведущих потребителей, и
      // «Responses used: 42/1000000000» — ровно тот случай, когда модель
      // получает правдоподобную неправду и строит на ней рассуждение.
      const usage = quota.unlimited
        ? `Responses used: ${quota.used} (no limit).`
        : `Responses used: ${quota.used}/${quota.total} (${quota.remaining} left).`;
      return jsonResult(`Signed in as ${profile.email}. ${usage}`, {
        apiUrl: config.apiUrl,
        readOnlyMode: config.readOnly,
        profile,
        quota,
      });
    },
  },
  {
    name: "feedbay_question_types",
    title: "Question type catalogue",
    description:
      "Every question type a survey can contain, what it is for, and which config fields it accepts. " +
      "Read this before composing questions – it is the schema for the `config` object of each type.",
    readOnly: true,
    idempotent: true,
    handler: async () =>
      jsonResult(`${QUESTION_TYPES.length} question types available.`, {
        note:
          "Pass any listed alias as `type`; it is stored in its canonical form so the widget renders it correctly.",
        sharedConfigFields: MEDIA_CONFIG_FIELDS,
        types: QUESTION_TYPES,
      }),
  },
  {
    name: "feedbay_templates",
    title: "Survey templates",
    description:
      "The built-in survey templates with their questions. Use a template id with survey_create to " +
      "start from a proven question set instead of composing one from scratch.",
    readOnly: true,
    idempotent: true,
    handler: async (_args, { client }) => {
      const { templates, total } = await client.getTemplates();
      return jsonResult(
        `${total} templates: ${templates.map((template) => template.id).join(", ")}.`,
        templates.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          category: template.category,
          questionCount: template.questions.length,
        })),
      );
    },
  },
  {
    name: "feedbay_template_get",
    title: "Read one template",
    description: "A single template with every question spelled out, so it can be reviewed or adapted before use.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      templateId: z.string().describe('Template id, for example "nps" or "csat". See feedbay_templates.'),
    },
    handler: async (args, { client }) => {
      const template = await client.getTemplate(String(args.templateId));
      return jsonResult(`Template "${template.name}" – ${template.questions.length} questions.`, template);
    },
  },
];
