import { describe, expect, it } from "vitest";
import { questionTools } from "../src/tools/questions.js";
import type { MediaResolver } from "../src/tools/shared.js";

/**
 * Trello QXZI4KJu (25.09): картинка из чата не вставала в вопрос — модель
 * выдумывала путь /tmp/..., а ссылку на страницу Unsplash ставила как картинку
 * («Image • 0 B» в редакторе).
 */

const tool = (name: string) => questionTools.find((entry) => entry.name === name)!;

function store(media?: MediaResolver) {
  const state = {
    config: {
      questions: [{ id: "q1", order: 0, type: "SINGLE_ANSWER", title: "Pick", required: false, config: { options: ["A"] } }],
    } as Record<string, unknown>,
  };
  const client = {
    getSurvey: async () => ({ id: "s1", name: "Test", config: state.config }),
    updateSurvey: async (_id: string, patch: { config: Record<string, unknown> }) => {
      state.config = patch.config;
      return { id: "s1", name: "Test", config: state.config };
    },
  };
  const context = { client, config: { apiUrl: "http://x", readOnly: false }, ...(media ? { media } : {}) } as never;
  const question = () => (state.config.questions as Array<{ config: Record<string, unknown> }>)[0];
  return { context, question };
}

const OWN = "https://feedbay.io/uploads/feedbay-uploads/media/a.png";

function fakeMedia(overrides: Partial<MediaResolver> = {}): MediaResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isOwnUrl: (url) => url.startsWith("https://feedbay.io/uploads/"),
    fromAttachment: async (id) => {
      calls.push(`attachment:${id}`);
      return { url: OWN, name: "photo.png", sizeBytes: 2048 };
    },
    fromUrl: async (url) => {
      calls.push(`url:${url}`);
      return { kind: "image", item: { url: OWN, name: "page-preview.jpg", sizeBytes: 5000 } };
    },
    ...overrides,
  };
}

describe("question_media_from_attachment", () => {
  it("кладёт приложенную картинку в медиа вопроса с настоящим размером", async () => {
    const media = fakeMedia();
    const { context, question } = store(media);

    const result = await tool("question_media_from_attachment").handler(
      { surveyId: "s1", questionId: "q1", attachmentIds: ["att-1"] },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(media.calls).toEqual(["attachment:att-1"]);
    expect(question().config.media).toEqual({ kind: "image", items: [{ url: OWN, name: "photo.png", sizeBytes: 2048 }] });
    expect(question().config.mediaEnabled).toBe(true);
    expect(question().config.options).toEqual(["A"]);
  });

  it("без хоста с вложениями — объясняет, а не выдумывает", async () => {
    const { context, question } = store();
    const result = await tool("question_media_from_attachment").handler(
      { surveyId: "s1", questionId: "q1", attachmentIds: ["att-1"] },
      context,
    );
    expect(JSON.stringify(result.content)).toContain("not available here");
    expect(question().config.media).toBeUndefined();
  });

  it("неизвестный вопрос — ничего не грузит", async () => {
    const media = fakeMedia();
    const { context } = store(media);
    const result = await tool("question_media_from_attachment").handler(
      { surveyId: "s1", questionId: "nope", attachmentIds: ["att-1"] },
      context,
    );
    expect(JSON.stringify(result.content)).toContain("No question with id");
    expect(media.calls).toEqual([]);
  });
});

describe("ссылки в config.media проверяются", () => {
  it("чужая ссылка на страницу превращается в нашу картинку", async () => {
    const media = fakeMedia();
    const { context, question } = store(media);

    await tool("question_update").handler(
      {
        surveyId: "s1",
        questionId: "q1",
        config: { media: { kind: "image", items: [{ url: "https://unsplash.com/photos/abc" }] } },
      },
      context,
    );

    expect(media.calls).toEqual(["url:https://unsplash.com/photos/abc"]);
    expect(question().config.media).toEqual({
      kind: "image",
      items: [{ url: OWN, name: "page-preview.jpg", sizeBytes: 5000 }],
    });
  });

  it("наша ссылка не перепроверяется", async () => {
    const media = fakeMedia();
    const { context } = store(media);
    await tool("question_update").handler(
      { surveyId: "s1", questionId: "q1", config: { media: { kind: "image", items: [{ url: OWN }] } } },
      context,
    );
    expect(media.calls).toEqual([]);
  });

  it("видео под видом картинки — отказ с подсказкой", async () => {
    const media = fakeMedia({
      fromUrl: async (url) => ({ kind: "video", item: { url, name: "clip.mp4", sizeBytes: 10 } }),
    });
    const { context, question } = store(media);
    await expect(
      tool("question_update").handler(
        { surveyId: "s1", questionId: "q1", config: { media: { kind: "image", items: [{ url: "https://x.io/clip.mp4" }] } } },
        context,
      ),
    ).rejects.toThrow('Use media kind "video"');
    expect(question().config.media).toBeUndefined();
  });

  it("отказ проверки доходит до модели и опрос не меняется", async () => {
    const media = fakeMedia({
      fromUrl: async () => {
        throw new Error("That link is a web page, not a picture");
      },
    });
    const { context, question } = store(media);
    await expect(
      tool("question_add").handler(
        { surveyId: "s1", type: "NPS", config: { media: { kind: "image", items: [{ url: "https://x.io/page" }] } } },
        context,
      ),
    ).rejects.toThrow("web page");
    expect(question().config.media).toBeUndefined();
  });

  it("видео по ссылке получает размер с сервера, имя человека сохраняется", async () => {
    const media = fakeMedia({
      fromUrl: async (url) => ({ kind: "video", item: { url, name: "clip.mp4", sizeBytes: 1234 } }),
    });
    const { context, question } = store(media);
    await tool("question_update").handler(
      {
        surveyId: "s1",
        questionId: "q1",
        config: { media: { kind: "video", item: { url: "https://x.io/clip.mp4", name: "Демо" } } },
      },
      context,
    );
    expect(question().config.media).toEqual({
      kind: "video",
      item: { url: "https://x.io/clip.mp4", name: "Демо", sizeBytes: 1234 },
    });
  });
});
