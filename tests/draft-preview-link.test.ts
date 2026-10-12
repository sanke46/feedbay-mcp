import { describe, expect, it } from "vitest";

import { shareTools } from "../src/tools/share.js";

/**
 * Черновик по публичной ссылке не открывается, а «покажи, как выглядит» до
 * публикации просили во всех прогонах матрицы 12.10.2026. Для черновика
 * survey_share_info отдаёт ссылку-превью; у опубликованного — как было.
 */

const shareInfo = shareTools.find((tool) => tool.name === "survey_share_info")!;
const firstLine = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const payload = (result: { content: unknown[] }) => JSON.parse((result.content[1] as { text: string }).text);

function client(status: string, preview: (() => Promise<unknown>) | null) {
  let previewCalls = 0;
  return {
    get previewCalls() {
      return previewCalls;
    },
    getSurvey: async () => ({ id: "s-1", name: "Анкета", status }),
    getShareInfo: async () => ({ publicId: "AbCd1234", publicUrl: "https://feedbay.io/s/AbCd1234" }),
    createPreviewLink: async () => {
      previewCalls += 1;
      if (!preview) throw new Error("404");
      return preview();
    },
  };
}

describe("survey_share_info: ссылка-превью черновика", () => {
  it("черновик получает previewUrl, и ответ честно говорит, что публичная ссылка пока молчит", async () => {
    const api = client("DRAFT", async () => ({
      url: "https://feedbay.io/s/AbCd1234?preview=tok",
      expiresAt: "2026-10-15T09:00:00Z",
    }));
    const result = await shareInfo.handler({ surveyId: "s-1" }, { client: api } as never);

    expect(payload(result)).toMatchObject({
      previewUrl: "https://feedbay.io/s/AbCd1234?preview=tok",
      previewExpiresAt: "2026-10-15T09:00:00Z",
      status: "DRAFT",
    });
    expect(firstLine(result)).toMatch(/opens only after survey_set_status publish/);
    expect(firstLine(result)).toMatch(/answers are not saved\): https:\/\/feedbay\.io\/s\/AbCd1234\?preview=tok$/);
  });

  it("опубликованный опрос — только публичная ссылка, превью не выдаётся", async () => {
    const api = client("PUBLISHED", async () => ({ url: "x", expiresAt: "y" }));
    const result = await shareInfo.handler({ surveyId: "s-1" }, { client: api } as never);

    expect(firstLine(result)).toBe("Public link: https://feedbay.io/s/AbCd1234");
    expect(payload(result).previewUrl).toBeUndefined();
    expect(api.previewCalls).toBe(0);
  });

  it("бэкенд без превью — прежний ответ, а не ошибка", async () => {
    const result = await shareInfo.handler({ surveyId: "s-1" }, { client: client("DRAFT", null) } as never);

    expect(result.isError).toBeFalsy();
    expect(payload(result).previewUrl).toBeUndefined();
    expect(firstLine(result)).toMatch(/opens only after survey_set_status publish\.$/);
  });
});
