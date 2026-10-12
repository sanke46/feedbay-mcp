/**
 * Styling a survey.
 *
 * The dashboard's design tab covers eight colours and two presets. This layer
 * adds what the UI cannot do: the renderer-only fields, and a palette generated
 * from a single brand colour with its contrast checked.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import {
  contrastReportFor,
  DEFAULT_SURVEY_DESIGN,
  DESIGN_FIELDS_WITHOUT_UI,
  normalizeColor,
  readableTextOn,
  type BrandRoles,
} from "../domain/design.js";
import { chooseFont, isRenderableFont, SURVEY_FONTS, SYSTEM_SERIF_STACK, wantsSerif } from "../domain/fonts.js";
import { fetchSite, UnsafeUrlError } from "../web/fetch-site.js";
import { extractSignals } from "../web/signals.js";
import { activeTheme, applyBrandThemes, buildBrandThemes, resetTheme, switchTheme } from "../domain/themes.js";
import type { SurveyDesign, ThemeName } from "../types.js";
import { PathOutsideRootError, resolveToolPath } from "./paths.js";
import { failResult, jsonResult, textResult, type ToolDefinition } from "./shared.js";

/**
 * Своя схема на каждое поле, а не одна общая: zod-to-json-schema превращает
 * повторно использованную схему в `$ref`, а `$ref` Gemini не принимает, и
 * описание рядом с ним в draft-07 теряется.
 */
const hexColor = () =>
  z.string().refine((value) => normalizeColor(value) !== null, "Expected a colour such as #7C3AED or rgb(124, 58, 237)");

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const COLOR_FIELDS = new Set([
  "questionColor",
  "answerColor",
  "answerTextColor",
  "answerUnselectedColor",
  "answerUnselectedTextColor",
  "answerBackgroundColor",
  "progressColor",
  "buttonColor",
  "buttonTextColor",
  "backgroundColor",
  "primaryColor",
  "secondaryColor",
]);

/**
 * The brand accent must show up where people look.
 *
 * Found on production (Trello 8Uojv6ny): "make the brand colour #A4DE02" wrote
 * only `primaryColor`, the assistant said "done", and the buttons stayed blue.
 * The renderer uses `primaryColor` only as a fallback (`buttonColor ||
 * primaryColor`), and the dashboard editor always lays its default palette
 * under the saved design — so a blue `buttonColor` is always there to win. The
 * accent is therefore written into the three visible slots too, unless the
 * caller set them on purpose, with a label colour that stays readable on it.
 */
function withVisibleAccent(changes: Record<string, unknown>): void {
  const accent = changes.primaryColor;
  if (typeof accent !== "string") return;
  for (const key of ["buttonColor", "answerColor", "progressColor"] as const) {
    if (changes[key] === undefined) changes[key] = accent;
  }
  if (changes.buttonTextColor === undefined && changes.buttonColor === accent) {
    changes.buttonTextColor = readableTextOn(accent);
  }
}

/** The backend caps uploads at 10MB (spring.servlet.multipart.max-file-size). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const designTools: ToolDefinition[] = [
  {
    name: "design_get",
    title: "Read the styling",
    description:
      "The survey's current colours and styling, plus which fields the dashboard has no form for (those are " +
      "reachable only through design_update).",
    readOnly: true,
    idempotent: true,
    inputSchema: { surveyId: z.string().describe("Survey id.") },
    handler: async (args, { client }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const design = survey.design ?? {};
      return jsonResult(`Styling of "${survey.name}".`, {
        design,
        contrastReport: contrastReportFor(design),
        fieldsWithoutDashboardUI: DESIGN_FIELDS_WITHOUT_UI,
        note:
          "Unset fields fall back to the renderer defaults. `answerBackgroundOpacity` is 0-100; " +
          "`borderRadius` is in pixels; `fontFamily` is a CSS font stack.",
      });
    },
  },
  {
    name: "design_update",
    title: "Update the styling",
    description:
      "Change any styling field. Only the fields you send are touched. Includes primaryColor, secondaryColor, " +
      "fontFamily and borderRadius, which the renderer applies but the dashboard cannot set. A colour the person " +
      "names is the colour they get: set it as given and, if it will be hard to see, offer a lighter or darker " +
      "one instead of swapping it. A brand colour means primaryColor – buttons, selected answers and progress bar.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      questionColor: hexColor().optional().describe("Colour of the question text."),
      answerColor: hexColor().optional().describe("Accent colour of a selected answer."),
      answerTextColor: hexColor().optional().describe("Text colour of a selected answer."),
      answerUnselectedColor: hexColor().optional().describe("Border/fill of an unselected answer."),
      answerUnselectedTextColor: hexColor().optional().describe("Text colour of an unselected answer."),
      answerBackgroundColor: hexColor().optional().describe("Background of the answer card."),
      answerBackgroundOpacity: z.number().min(0).max(100).optional().describe("Answer card opacity, 0-100."),
      progressColor: hexColor().optional().describe("Colour of the progress bar."),
      buttonColor: hexColor().optional().describe("Background of the primary button."),
      buttonTextColor: hexColor().optional().describe("Label colour of the primary button."),
      backgroundColor: hexColor().optional().describe("Background of the survey surface."),
      showBranding: z.boolean().optional().describe('Show the "Powered by FeedBay" line.'),
      logo: z.string().optional().describe("URL of the logo image. Use design_upload_image to get one."),
      backgroundImage: z.string().optional().describe("URL of the background image."),
      primaryColor: hexColor()
        .optional()
        .describe(
          "Brand accent. Also recolours buttons, selected answers and the progress bar unless those are set separately.",
        ),
      secondaryColor: hexColor().optional().describe("Renderer secondary variable. No dashboard form for this."),
      fontFamily: z
        .string()
        .optional()
        .describe(
          "CSS font stack. FeedBay's fonts, all with Cyrillic: Inter, Roboto, Open Sans, Montserrat, Nunito, " +
            "PT Sans, Rubik, Manrope. No serif web font – for serif use \"Georgia, 'Times New Roman', serif\".",
        ),
      borderRadius: z.number().min(0).max(64).optional().describe("Corner radius in px. No dashboard form for this."),
      questionLayout: z
        .enum(["one", "all"])
        .optional()
        .describe('How questions are shown: "one" per screen (default) or "all" on one scrolling page.'),
    },
    handler: async (args, { client }) => {
      const { surveyId, ...patch } = args;
      const changes = Object.fromEntries(
        Object.entries(patch)
          .filter(([, value]) => value !== undefined)
          // Colours are stored the way the colour picker stores them. Fields
          // that are not colours (font, radius, urls) never parse as one.
          .map(([key, value]) => [key, COLOR_FIELDS.has(key) ? normalizeColor(String(value)) : value]),
      );
      if (Object.keys(changes).length === 0) {
        return failResult("Nothing to change – no design fields were provided.");
      }
      withVisibleAccent(changes);
      const survey = await client.getSurvey(String(surveyId));
      const design = { ...(survey.design ?? {}), ...changes };
      const updated = await client.updateSurvey(survey.id, { design });
      const warnings: string[] = [];
      if (typeof changes.fontFamily === "string" && !isRenderableFont(changes.fontFamily)) {
        warnings.push(
          `"${changes.fontFamily}" is not one of FeedBay's fonts (${SURVEY_FONTS.map((font) => font.family).join(", ")}) ` +
            "and ends without a generic fallback, so browsers show their default font.",
        );
      }
      const contrastReport = contrastReportFor(updated.design ?? {});
      for (const entry of contrastReport.filter((item) => !item.passesAA)) {
        warnings.push(`Contrast for ${entry.pair} is ${entry.ratio}:1, below the ${entry.target}:1 target.`);
      }
      return jsonResult(
        `Updated ${Object.keys(changes).length} styling fields on "${updated.name}".` +
          (warnings.length ? ` Warnings: ${warnings.join(" ")}` : ""),
        { design: updated.design, contrastReport, ...(warnings.length ? { warnings } : {}) },
      );
    },
  },
  {
    name: "design_apply_preset",
    title: "Switch theme or apply a brand colour",
    description:
      "Restyle a survey in one call. A survey has a light and a dark theme, each keeping its own colours. " +
      "`light` / `dark` switch to that theme with the colours it had – nothing is reset; pass reset:true only " +
      "when the person asks to go back to the default look of that theme. `brand` derives a palette from one " +
      "accent colour for BOTH themes at once and shows the one on screen (or `mode`), keeping the named colour " +
      "exactly in the shown theme; the other theme's accent is adjusted so it stays visible – say so. Pass " +
      "adjustForContrast only when the person asks for a more readable version: it shifts the accent itself. " +
      "For a brand read from a website or an image, prefer design_match_brand. Logo, background image, font, " +
      "branding flag and question layout are never touched.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      preset: z.enum(["light", "dark", "brand"]).describe("Theme to switch to, or brand."),
      brandColor: hexColor().optional().describe('Accent colour, required when preset is "brand".'),
      mode: z
        .enum(["light", "dark"])
        .optional()
        .describe('Which theme to show after a brand is applied. Defaults to the theme on screen. Only with "brand".'),
      adjustForContrast: z
        .boolean()
        .optional()
        .describe(
          'Shift the accent until it is visible on the background. Changes the colour; off by default. Only used with preset "brand".',
        ),
      reset: z
        .boolean()
        .optional()
        .describe("Only with light/dark: throw away that theme's own colours and use the default ones."),
    },
    handler: async (args, { client }) => {
      const survey = await client.getSurvey(String(args.surveyId));
      const current = (survey.design ?? {}) as Partial<SurveyDesign>;
      const preset = args.preset as "light" | "dark" | "brand";

      let patch: Partial<SurveyDesign>;
      let message: string;
      let notes: string[] = [];
      let contrastReport: unknown = undefined;

      if (preset === "brand") {
        if (!args.brandColor) {
          return failResult('preset "brand" needs a brandColor, for example "#7C3AED".');
        }
        const show = (args.mode as ThemeName | undefined) ?? activeTheme(current);
        const brand = buildBrandThemes({
          brandColor: normalizeColor(String(args.brandColor)) ?? String(args.brandColor),
          keepAccentIn: args.adjustForContrast === true ? undefined : show,
        });
        patch = applyBrandThemes(current, brand, show);
        notes = brand.notes;
        contrastReport = brand.contrastReport;
        message = `Applied the brand colour to both themes of "${survey.name}", showing the ${show} one.`;
      } else if (args.reset === true) {
        patch = resetTheme(current, preset);
        const other = activeTheme(current) === preset ? {} : switchTheme({ ...current, ...patch }, preset) ?? {};
        patch = { ...patch, ...other };
        message = `Reset the ${preset} theme of "${survey.name}" to its default colours.`;
      } else {
        const switched = switchTheme(current, preset);
        if (!switched) {
          return textResult(`"${survey.name}" is already on the ${preset} theme; nothing changed.`);
        }
        patch = switched;
        message = `Switched "${survey.name}" to the ${preset} theme, keeping the colours both themes had.`;
      }

      const updated = await client.updateSurvey(survey.id, {
        design: { ...current, ...patch } as unknown as Record<string, unknown>,
      });
      const summary = notes.length > 0 ? ` ${notes.join(" ")}` : "";
      return jsonResult(`${message}${summary}`, {
        design: updated.design,
        ...(contrastReport ? { contrastReport } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
    },
  },
  {
    name: "brand_read_site",
    title: "Read a brand from a website",
    description:
      "Fetch a public website and list what it declares about its look: colours grouped by where they are used " +
      "(page background, text, buttons, links, surfaces, CSS variables), fonts, the theme colour, the icon and the " +
      "social image. Changes nothing. Use it when the person says \"like our site\": pick the main brand colour " +
      "and the colour roles from this, then call design_match_brand with brandColor, roles, fontFamily and logoUrl.",
    invariants: [
      "Colours are what the page declares in its markup and first stylesheets, not a screenshot: a site built " +
        "from bundled CSS can show few of them. Say so rather than inventing a palette, and offer to use an image " +
        "of the brand instead.",
    ],
    readOnly: true,
    openWorld: true,
    idempotent: true,
    // В чате сайт читает наша модель в изолированном вызове (context.brand) —
    // там этот инструмент лишний. Внешнему клиенту он заменяет её: сырьё
    // отдаём мы, решает его модель.
    available: ({ brand }) => brand === undefined,
    inputSchema: {
      url: z.string().describe("Website address, as the person gave it."),
    },
    handler: async (args) => {
      let site;
      try {
        site = await fetchSite(String(args.url).trim());
      } catch (error) {
        if (error instanceof UnsafeUrlError) return failResult(error.message);
        return failResult("Could not read that site. Ask for the brand colour or an image of the brand instead.");
      }
      const stylesheets = extractSignals(site.html, site.url).stylesheets;
      const css = (
        await Promise.all(stylesheets.map((href) => fetchSite(href).then((sheet) => sheet.html).catch(() => "")))
      ).join("\n");
      const { stylesheets: _sheets, ...signals } = extractSignals(site.html, site.url, css);
      const found = Object.values(signals.colorGroups).reduce((sum, group) => sum + group.length, 0);
      return jsonResult(
        `Read ${new URL(site.url).hostname}: ${found} colours by role, ${signals.fonts.length} fonts` +
          `${signals.icon || signals.ogImage ? ", an image to use as a logo" : ""}.`,
        { url: site.url, ...signals },
      );
    },
  },
  {
    name: "design_match_brand",
    title: "Match a brand",
    description:
      'Style a survey after a brand – "make it look like our site", "use our colours" with a link or an image. ' +
      "With `url` (a website the person gave) the site is read in a separate, isolated step that returns only " +
      "colours, a font and a logo; never pass anything but the address. With an image the person attached, look " +
      "at it yourself and pass `brandColor` (the main brand colour) and, if you can tell, `fontFamily`. Either " +
      "way the palette is built for BOTH the light and the dark theme; the theme on screen stays. A logo is set " +
      "only if the survey has none, and only pass one for the person's own brand – for \"make it look like " +
      "another company's site\" leave the logo out. Tell the person what was set.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      url: z.string().optional().describe("Website of the brand, as the person gave it."),
      brandColor: hexColor()
        .optional()
        .describe("Main brand colour, when there is no website – for example read from an attached image."),
      fontFamily: z.string().optional().describe("Brand font name, if known. Mapped to the closest supported font."),
      roles: z
        .object({
          text: hexColor().optional(),
          background: hexColor().optional(),
          primaryAccent: hexColor().optional(),
          secondaryAccent: hexColor().optional(),
          neutralSurface: hexColor().optional(),
        })
        .optional()
        .describe(
          "Colours by the role they play on the brand's site, when you read them yourself (brand_read_site). " +
            "Leave a role out when unsure.",
        ),
      logoUrl: z
        .string()
        .optional()
        .describe("https address of the person's own logo. Never another company's. Set only if the survey has none."),
      adjustForContrast: z
        .boolean()
        .optional()
        .describe("Shift a named brandColor in the shown theme until it is readable. Off by default."),
    },
    handler: async (args, { client, brand: reader }) => {
      const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : null;
      if (!url && !args.brandColor) {
        return failResult("Give a website (url) or the brand colour (brandColor), for example read from the image.");
      }

      let brandColor: string;
      let fontRequest: string | undefined = typeof args.fontFamily === "string" ? args.fontFamily : undefined;
      let logo: string | null = null;
      let source: string;
      let injectionSuspected = false;
      let roles: BrandRoles | undefined;

      if (url) {
        if (!reader) {
          // Здесь нет нашей модели — и не нужно: разбирает сайт модель
          // клиента. Сервер отдаёт ей сырьё, роли цветов выбирает она.
          return failResult(
            `Read the site first: call brand_read_site with url "${url}", choose the brand colour and the colour ` +
              "roles from what it returns, then call design_match_brand again with brandColor, roles, fontFamily " +
              "and logoUrl – without url.",
          );
        }
        const reading = await reader.readSite(url);
        brandColor = reading.primaryColor;
        fontRequest = reading.fontFamily;
        logo = reading.logo;
        source = reading.source;
        injectionSuspected = reading.injectionSuspected;
        roles = reading.roles;
      } else {
        brandColor = normalizeColor(String(args.brandColor)) ?? String(args.brandColor);
        source = "the colour given";
        if (args.roles && typeof args.roles === "object") {
          roles = args.roles as BrandRoles;
          source = "the brand's site";
        }
        const givenLogo = typeof args.logoUrl === "string" ? args.logoUrl.trim() : "";
        if (givenLogo.startsWith("https://")) logo = givenLogo;
      }

      const survey = await client.getSurvey(String(args.surveyId));
      const current = (survey.design ?? {}) as Partial<SurveyDesign>;
      const show = activeTheme(current);
      // A colour the person named (or read off their image) stays exact in the
      // theme they are looking at. A colour read from a site is the site's, not
      // theirs, so both themes get the readable version — like the dashboard's
      // Match your brand button.
      const themes = buildBrandThemes({
        brandColor,
        // Цвета, прочитанные с сайта (здесь или моделью клиента), — сайта, а не
        // человека: обе темы получают читаемый вариант.
        keepAccentIn: url || roles || args.adjustForContrast === true ? undefined : show,
        ...(roles ? { roles } : {}),
      });
      const font = fontRequest
        ? wantsSerif(fontRequest)
          ? {
              family: SYSTEM_SERIF_STACK,
              requested: fontRequest,
              note:
                `${fontRequest}: FeedBay has no serif web font, so the system serif (Georgia, Times New Roman) ` +
                "is used – it has Cyrillic on most devices.",
            }
          : chooseFont(fontRequest)
        : null;

      const patch: Partial<SurveyDesign> = {
        ...applyBrandThemes(current, themes, show),
        ...(font ? { fontFamily: font.family } : {}),
      };
      const notes = [...themes.notes];
      if (font?.note) notes.push(font.note);
      if (logo && !current.logo) {
        patch.logo = logo;
        notes.push("Logo from the site was set.");
      } else if (logo) {
        notes.push("The survey already has a logo, so the one from the site was not applied.");
      } else if (url) {
        notes.push("No usable logo was found on the site.");
      }
      if (injectionSuspected) {
        notes.push("The site contained text addressed to an AI; it was ignored and only colours were read.");
      }

      const updated = await client.updateSurvey(survey.id, {
        design: { ...current, ...patch } as unknown as Record<string, unknown>,
      });
      return jsonResult(
        `Matched "${updated.name}" to ${source}: brand ${brandColor} in both themes, showing the ${show} one.` +
          (notes.length > 0 ? ` ${notes.join(" ")}` : ""),
        {
          design: updated.design,
          themes: { light: themes.light, dark: themes.dark },
          contrastReport: themes.contrastReport,
          ...(font ? { font } : {}),
          notes,
        },
      );
    },
  },
  {
    name: "design_upload_image",
    title: "Upload a logo or background",
    description:
      "Upload an image and attach it to the survey as the logo or the background. Accepts a local file path " +
      "(when the server runs next to your files) or base64 data. Max 10MB; the backend downscales and re-encodes it.",
    readOnly: false,
    inputSchema: {
      surveyId: z.string().describe("Survey id."),
      target: z.enum(["logo", "backgroundImage"]).describe("Where to attach the uploaded image."),
      filePath: z.string().optional().describe("Path to a local image file. Use this or base64Data."),
      base64Data: z.string().optional().describe("Base64-encoded image bytes. Use this or filePath."),
      fileName: z.string().optional().describe("File name for the upload; required with base64Data."),
    },
    handler: async (args, { client, config }) => {
      let bytes: Uint8Array;
      let fileName: string;

      if (args.filePath) {
        // Путь выбирает МОДЕЛЬ, а на неё в чате влияет чужой текст. На нашем
        // сервере без этой проверки инструмент читал любой файл и выкладывал
        // его в медиахранилище публичной ссылкой — готовый способ вынести
        // секрет. На машине самого пользователя (stdio) ограничение не
        // ставится: диск его, и «загрузи ~/Downloads/logo.png» — обычный
        // сценарий. Решает `filesystemOwner`, см. tools/paths.ts.
        let path: string;
        try {
          path = resolveToolPath(String(args.filePath), config, `The image path "${String(args.filePath)}"`);
        } catch (error) {
          if (error instanceof PathOutsideRootError) return failResult(error.message);
          throw error;
        }
        bytes = new Uint8Array(await readFile(path));
        fileName = basename(path);
      } else if (args.base64Data) {
        bytes = new Uint8Array(Buffer.from(String(args.base64Data), "base64"));
        fileName = String(args.fileName ?? "upload.png");
      } else {
        return failResult("Provide either filePath or base64Data (with fileName).");
      }

      if (bytes.byteLength === 0) return failResult(`"${fileName}" is empty.`);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return failResult(
          `"${fileName}" is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; the API rejects anything over 10MB.`,
        );
      }

      const mimeType = MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? "image/png";
      const url = await client.uploadImage(bytes, fileName, mimeType, "design");

      const survey = await client.getSurvey(String(args.surveyId));
      const design = { ...(survey.design ?? {}), [String(args.target)]: url };
      const updated = await client.updateSurvey(survey.id, { design });

      return jsonResult(`Uploaded ${fileName} and set it as the ${args.target} of "${updated.name}".`, {
        url,
        design: updated.design,
      });
    },
  },
];

export { DEFAULT_SURVEY_DESIGN };
