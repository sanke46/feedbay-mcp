/**
 * `config.media` of a question — the one config key that is validated here.
 *
 * Why this key and not the others: a wrong `media` shape did not just fail to
 * show, it took the whole dashboard editor down ("This page couldn't load")
 * every time the question was expanded, reload included. The assistant had no
 * description of the field and invented one. So the shape is now both
 * documented (`MEDIA_CONFIG_FIELDS`) and enforced.
 *
 * Mirrors `QuestionMedia` in packages/survey-renderer/src/types.ts — that file
 * is the source of truth; this package does not depend on the renderer.
 */

import { z } from "zod";

const mediaItem = z.object({
  url: z.string().url(),
  name: z.string().default(""),
  sizeBytes: z.number().nonnegative().default(0),
  durationSec: z.number().nonnegative().optional(),
  posterUrl: z.string().url().optional(),
});

export const questionMediaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), items: z.array(mediaItem).min(1).max(10) }),
  z.object({ kind: z.literal("video"), item: mediaItem }),
  z.object({ kind: z.literal("audio"), item: mediaItem }),
  z.object({ kind: z.literal("embed"), url: z.string().url() }),
  z.object({ kind: z.literal("link"), url: z.string().url(), title: z.string().optional() }),
]);

export const MEDIA_CONFIG_FIELDS = {
  media:
    '{kind:"image", items:[{url, name?}] (1-10)} | {kind:"video"|"audio", item:{url, name?}} | ' +
    '{kind:"embed", url} | {kind:"link", url, title?} – picture, clip or page shown between the ' +
    "question text and the answers. url must be a public https address. Replaced as a whole, never " +
    "merged; null removes it",
  mediaEnabled: "boolean – hide the attached media without deleting it",
} as const;

/**
 * Put the caller's `media` onto an already merged config.
 *
 * Replaced wholesale on purpose: deep-merging `{kind:"video", item}` over a
 * stored gallery would leave `{kind:"video", items, item}` — a shape nobody
 * draws.
 *
 * @throws when the shape is wrong, so the model sees why and can retry.
 */
export function applyMediaPatch(
  config: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch || !("media" in patch)) return config;

  const { media: _dropped, ...rest } = config;
  if (patch.media === null || patch.media === undefined) return rest;

  const parsed = questionMediaSchema.safeParse(patch.media);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "media"}: ${issue.message}`);
    throw new Error(
      `config.media has the wrong shape (${issues.join("; ")}). Expected ${MEDIA_CONFIG_FIELDS.media}.`,
    );
  }
  return { ...rest, media: parsed.data };
}
