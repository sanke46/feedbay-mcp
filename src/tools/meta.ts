/**
 * Orientation tools: who the server acts as, and what building blocks exist.
 */

import { z } from "zod";
import { PRODUCT_LIMITATIONS } from "../domain/capabilities.js";
import { MEDIA_CONFIG_FIELDS } from "../domain/question-media.js";
import { findQuestionType, QUESTION_TYPES, type QuestionTypeSpec } from "../domain/question-types.js";
import { jsonResult, type ToolDefinition } from "./shared.js";

export const metaTools: ToolDefinition[] = [
  {
    name: "feedbay_whoami",
    title: "Account and quota",
    description:
      "The FeedBay account this server acts as: whether it can publish, its response quota, and what the " +
      "product cannot do. Call it before promising to publish, and when a publish fails with QUOTA_EXCEEDED.",
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
      // Прогон 12.10: без этого две модели из трёх выясняли тариф пробной
      // публикацией на проде, а третья раз за разом говорила человеку, что
      // публикация платная, хотя у него она работала.
      const publishing =
        quota.canPublish === undefined
          ? "Publishing needs a paid plan; this server cannot tell whether the account has one. Do not publish " +
            "just to find out – publish only when the person asks, and a PLAN_REQUIRED error will say so."
          : quota.canPublish
            ? "This account can publish."
            : "This account cannot publish until it has a paid plan; everything else works.";
      // Профиль урезан до того, что нужно модели: телефон, аватар и адрес
      // API внутри docker-сети ей ни к чему, а читать их будет чужая модель.
      return jsonResult(`Signed in as ${profile.email}. ${usage} ${publishing}`, {
        account: { email: profile.email, name: profile.fullName },
        readOnlyMode: config.readOnly,
        ...(quota.canPublish === undefined ? {} : { canPublish: quota.canPublish }),
        quota: {
          used: quota.used,
          ...(quota.unlimited ? { unlimited: true } : { total: quota.total, remaining: quota.remaining }),
          resetDate: quota.resetDate,
          exhausted: quota.exhausted === true,
        },
        notAvailableInFeedBay: PRODUCT_LIMITATIONS.map((limitation) => limitation.text),
      });
    },
  },
  {
    name: "feedbay_question_types",
    title: "Question type catalogue",
    description:
      "Every question type a survey can contain and what it is for, with the names of its config fields. " +
      'Pass `types` (for example ["MATRIX", "CSAT"]) to get the full config schema of the types you will use ' +
      "before composing them.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      types: z
        .array(z.string())
        .optional()
        .describe("Types or aliases to spell out in full. Without it, a compact list of every type."),
    },
    handler: async (args) => {
      const requested = Array.isArray(args.types) ? (args.types as string[]) : [];
      if (requested.length === 0) {
        // Полный каталог — 11 тыс. символов, то есть ~3 тыс. токенов модели
        // клиента на каждый вызов, а нужны из него обычно два-три типа.
        return jsonResult(
          `${QUESTION_TYPES.length} question types. Call again with types for the full config of the ones you use.`,
          {
            note:
              "Pass any listed alias as `type`; it is stored in its canonical form so the widget renders it correctly.",
            types: QUESTION_TYPES.map((spec) => ({
              type: spec.type,
              label: spec.label,
              description: spec.description,
              aliases: spec.aliases.filter((alias) => alias !== spec.type),
              configFields: Object.keys(spec.configFields),
              ...(spec.deprecated ? { deprecated: spec.deprecated } : {}),
            })),
          },
        );
      }
      const specs: QuestionTypeSpec[] = [];
      const unknown: string[] = [];
      for (const name of requested) {
        const spec = findQuestionType(name);
        if (!spec) unknown.push(name);
        else if (!specs.includes(spec)) specs.push(spec);
      }
      return jsonResult(
        `${specs.length} question types in full.` + (unknown.length ? ` Unknown: ${unknown.join(", ")}.` : ""),
        { sharedConfigFields: MEDIA_CONFIG_FIELDS, types: specs },
      );
    },
  },
  {
    name: "feedbay_templates",
    title: "Survey templates",
    description:
      "The built-in survey templates. Without templateId: the list. With templateId: that template with every " +
      "question spelled out. Use a template id with survey_create (fromTemplate) to start from a proven set; " +
      "templates are in English.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      templateId: z.string().optional().describe('Template id, for example "nps", to read its questions.'),
    },
    handler: async (args, { client }) => {
      if (typeof args.templateId === "string" && args.templateId.trim() !== "") {
        const template = await client.getTemplate(args.templateId.trim());
        return jsonResult(`Template "${template.name}" – ${template.questions.length} questions.`, template);
      }
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
];
