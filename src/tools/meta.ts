/**
 * Orientation tools: who the server acts as, and what building blocks exist.
 */

import { z } from "zod";
import { PRODUCT_LIMITATIONS } from "../domain/capabilities.js";
import { MEDIA_CONFIG_FIELDS } from "../domain/question-media.js";
import { resolveImportedType } from "../domain/import/vocabulary.js";
import {
  findQuestionType,
  QUESTION_TYPES,
  suggestQuestionTypes,
  type QuestionTypeSpec,
} from "../domain/question-types.js";
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
      // Название тарифа и право публиковать — разные вещи: Free с выданным
      // руками лимитом публиковать может. Голое «Plan: Free» рядом с «can
      // publish» две модели из трёх сочли противоречием (прогон 12.10).
      const plan = !quota.plan
        ? ""
        : quota.canPublish && quota.plan === "Free"
          ? ` Plan: Free, with publishing granted to this account.`
          : ` Plan: ${quota.plan}.`;
      return jsonResult(`Signed in as ${profile.email}.${plan} ${usage} ${publishing}`, {
        account: { email: profile.email, name: profile.fullName },
        ...(quota.plan ? { plan: quota.plan } : {}),
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
              "Pass any listed alias as `type`; it is stored in its canonical form so the widget renders it correctly. " +
              'Everyday words ("text", "rating", "phone"…) are accepted too and read as the closest type – "text" is ' +
              "a one-line TEXT_ANSWER, so ask for LONG_TEXT when you want open feedback.",
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
      const readAs: Record<string, string> = {};
      for (const name of requested) {
        // Те же слова, что принимает survey_create: «rating», «text», «phone»
        // знает словарь импорта, а не список алиасов. Каталог, который не
        // узнаёт то, что потом примет создание, учит модель обходным путям.
        const imported = resolveImportedType(name);
        const direct = findQuestionType(name);
        const spec = direct ?? (imported ? findQuestionType(imported) : undefined);
        // Слово из словаря, а не алиас, — сказать вслух, во что оно прочитано:
        // молча вернув TEXT_ANSWER на OPEN_TEXT, каталог заставил модель
        // гадать, однострочное это поле или нет (прогон «после-2», S2).
        if (spec && !direct) readAs[name] = spec.type;
        if (!spec) {
          const guesses = suggestQuestionTypes(name);
          unknown.push(guesses.length ? `${name} (did you mean ${guesses.join(" or ")}?)` : name);
        } else if (!specs.includes(spec)) specs.push(spec);
      }
      const readLine = Object.entries(readAs)
        .map(([name, type]) => `${name} as ${type}`)
        .join(", ");
      // Модель, которая сразу просит типы по именам, полного списка не
      // видит: Haiku в английском прогоне (S6) угадал пять имён и решил,
      // что вступлению и финалу анкеты «некуда деться», хотя это экраны
      // WELCOME и THANK_YOU. Короткий индекс всех типов стоит сотни символов.
      return jsonResult(
        `${specs.length} question types in full.` +
          (readLine ? ` Read ${readLine}.` : "") +
          (unknown.length ? ` Unknown: ${unknown.join(", ")}.` : "") +
          " Intro and closing text go on the WELCOME and THANK_YOU screens; allTypes lists every type.",
        {
          sharedConfigFields: MEDIA_CONFIG_FIELDS,
          ...(readLine ? { readAs } : {}),
          types: specs,
          allTypes: QUESTION_TYPES.filter((spec) => !spec.deprecated).map((spec) => `${spec.type} – ${spec.label}`),
        },
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
