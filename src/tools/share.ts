/**
 * Getting a survey in front of people: links, QR codes, and when the widget fires.
 */

import { z } from "zod";
import { buildInstallSnippet } from "../domain/install-snippet.js";
import { failResult, jsonResult, type ToolDefinition } from "./shared.js";

/**
 * The widget implements six trigger types (widget/src/core/TriggerManager.ts)
 * but the dashboard only offers the first three. Everything here is already
 * supported end to end — the API just never had a UI for it.
 */
const TRIGGER_TYPES = ["immediate", "delay", "scroll", "exit", "click", "manual"] as const;

/**
 * Адрес API, по которому виджет ходит из браузера посетителя.
 *
 * Хостинг говорит с бэкендом по внутренней сети (`http://backend:8080`), и
 * этот адрес попадал прямо в код для сайта: прогон 12.10 выдал всем трём
 * моделям виджет, который не загрузился бы ни у одного посетителя. Хост без
 * точки — имя контейнера, наружу его не видно; тогда берём публичный origin
 * ссылки на опрос, он отдаёт `/api` наружу. localhost остаётся: это
 * разработка, где сайт и бэкенд на одной машине.
 */
function publicApiOrigin(apiUrl: string, shareHostOrigin: string): string {
  try {
    const host = new URL(apiUrl).hostname;
    return host.includes(".") || host === "localhost" ? apiUrl : shareHostOrigin;
  } catch {
    return shareHostOrigin;
  }
}

export const shareTools: ToolDefinition[] = [
  {
    name: "survey_share_info",
    title: "Links and embed code",
    description:
      "The public survey URL, the ready-made embed snippet and the QR code URL. The survey must be published " +
      "for the public URL to answer.",
    readOnly: true,
    idempotent: true,
    inputSchema: { surveyId: z.string().describe("Survey id.") },
    handler: async (args, { client }) => {
      const info = await client.getShareInfo(String(args.surveyId));
      return jsonResult(`Public link: ${info.publicUrl}`, info);
    },
  },
  {
    name: "survey_install_snippet",
    title: "Website install code",
    description:
      "The <script> snippet to paste into a website so the survey actually appears there. The snippet already " +
      "carries the survey's trigger, so run targeting_update first if the timing should change. For a published " +
      "survey the reply also shows what a visitor's browser receives (display mode, trigger, design).",
    // Переехало из описания дословно. Оба факта — про то, после чего опрос
    // ВООБЩЕ появится на сайте: без них ассистент выдаёт ссылку вместо
    // установки и объявляет готовым неопубликованный опрос.
    invariants: [
      "This is what a channel:WEBSITE survey needs to go live – the link from survey_share_info is a " +
        "standalone page, not an installation.",
      "Publishing is still required: the widget fetches its config from the public API.",
    ],
    readOnly: true,
    idempotent: true,
    inputSchema: { surveyId: z.string().describe("Survey id.") },
    handler: async (args, { client, config }) => {
      const surveyId = String(args.surveyId);
      const [survey, info] = await Promise.all([client.getSurvey(surveyId), client.getShareInfo(surveyId)]);

      // Origin берётся из публичной ссылки, а не из настроек сервера: ссылку
      // строит сам бэкенд по app.survey.public-url-base, и на self-hosted
      // установке она отличается от адреса API. Угадывать её — значит выдать
      // пользователю сниппет, который тянет виджет с несуществующего домена.
      const shareHostOrigin = info.publicUrl.replace(/\/s\/[^/]+\/?$/, "");

      const snippet = buildInstallSnippet({
        publicId: info.publicId,
        shareHostOrigin,
        apiOrigin: publicApiOrigin(config.apiUrl, shareHostOrigin),
        targeting: survey.targeting as Record<string, unknown> | null,
        displayMode: survey.displayMode,
      });

      const warning =
        survey.status === "PUBLISHED"
          ? ""
          : " The survey is not published yet, so the widget will not show anything until it is.";
      const channelNote =
        survey.channel === "WEBSITE"
          ? ""
          : ` The survey's channel is ${survey.channel}: for a page of its own share the link instead, or switch ` +
            "the channel to WEBSITE with survey_update before installing the widget.";

      // Что браузер посетителя получит на деле — то, что раньше отдавал
      // отдельный survey_widget_config. Собирает публичный API, так что есть
      // только у опубликованного опроса; без него сниппет всё равно годен.
      const servedToVisitors =
        survey.status === "PUBLISHED"
          ? await Promise.resolve()
              .then(() => client.getWidgetConfig(info.publicId))
              .catch(() => null)
          : null;

      return jsonResult(`Install snippet for "${survey.name}".${warning}${channelNote}`, {
        surveyId,
        publicId: info.publicId,
        status: survey.status,
        displayMode: survey.displayMode,
        channel: survey.channel,
        snippet,
        ...(servedToVisitors ? { servedToVisitors } : {}),
      });
    },
  },
  {
    name: "survey_qr_code",
    title: "QR code image",
    description:
      "Render the survey's QR code as a PNG. Scans are attributed to the `qr` channel, so responses collected " +
      "this way can be told apart in results_breakdown.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      size: z.number().int().min(64).max(2000).optional().describe("Image size in pixels (default 300)."),
    },
    handler: async (args, { client }) => {
      const size = typeof args.size === "number" ? args.size : 300;
      const { bytes, contentType } = await client.getQrCode(String(args.surveyId), size);
      return {
        content: [
          { type: "text", text: `QR code for survey ${args.surveyId}, ${size}×${size}px.` },
          { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: contentType || "image/png" },
        ],
      };
    },
  },
  {
    name: "targeting_update",
    title: "When the widget appears",
    description:
      "Set what makes the survey appear on a page. Beyond the dashboard's immediate/delay/scroll, the widget " +
      "also supports `exit` (mouse leaves the page), `click` (a CSS selector is clicked) and `manual` " +
      "(shown only when the host page calls fb('show')). Applies to WEBSITE surveys.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      triggerType: z.enum(TRIGGER_TYPES).describe("What causes the survey to appear."),
      delayMs: z.number().int().min(0).optional().describe('Delay in milliseconds, for triggerType "delay".'),
      scrollPercent: z.number().int().min(1).max(100).optional().describe('Scroll depth, for triggerType "scroll".'),
      selector: z.string().optional().describe('CSS selector of the element to watch, for triggerType "click".'),
    },
    handler: async (args, { client }) => {
      const triggerType = String(args.triggerType);
      const targeting: Record<string, unknown> = { triggerType };

      if (triggerType === "delay") {
        targeting.triggerDelay = typeof args.delayMs === "number" ? args.delayMs : 5000;
      }
      if (triggerType === "scroll") {
        targeting.triggerScroll = typeof args.scrollPercent === "number" ? args.scrollPercent : 50;
      }
      if (triggerType === "click") {
        if (!args.selector) {
          return failResult('triggerType "click" needs a `selector`, for example "#feedback-button".');
        }
        targeting.triggerSelector = String(args.selector);
      }

      const survey = await client.getSurvey(String(args.surveyId));
      const updated = await client.updateSurvey(survey.id, { targeting: { ...(survey.targeting ?? {}), ...targeting } });

      const unsupportedInDashboard = ["exit", "click", "manual"].includes(triggerType)
        ? " The dashboard's trigger dropdown cannot show this option, so it will keep displaying the closest one it knows."
        : "";
      return jsonResult(`"${updated.name}" now appears on: ${triggerType}.${unsupportedInDashboard}`, updated.targeting);
    },
  },
];
