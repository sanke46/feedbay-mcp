import { describe, expect, it } from "vitest";

import { shareTools } from "../src/tools/share.js";

/**
 * Картинка QR в ответе MCP не годится для печати: многие клиенты её не
 * показывают, а авторизованный адрес не открыть в браузере. Теперь рядом
 * лежит публичный printUrl, который работает у опубликованного опроса.
 */

const qrCode = shareTools.find((tool) => tool.name === "survey_qr_code")!;
const PRINT_URL = "https://feedbay.io/api/v1/public/surveys/AbCd1234/qr-code.png";

type Part = { type: string; text?: string; data?: string };
const parts = (result: { content: unknown[] }) => result.content as Part[];

function client(shareInfo: (() => Promise<unknown>) | null) {
  const sizes: number[] = [];
  return {
    sizes,
    getQrCode: async (_id: string, size: number) => {
      sizes.push(size);
      return { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };
    },
    getShareInfo: async () => {
      if (!shareInfo) throw new Error("404");
      return shareInfo();
    },
  };
}

describe("survey_qr_code: публичная ссылка для печати", () => {
  it("printUrl стоит в первой строке и в payload, картинка остаётся", async () => {
    const api = client(async () => ({ publicId: "AbCd1234", qrCodeUrl: PRINT_URL }));
    const result = await qrCode.handler({ surveyId: "s-1", size: 600 }, { client: api } as never);
    const content = parts(result);

    expect(content[0].text).toContain(PRINT_URL);
    expect(content[0].text).toMatch(/opens once the survey is published/);
    expect(JSON.parse(content[1].text!)).toEqual({ surveyId: "s-1", printUrl: PRINT_URL });
    expect(content[content.length - 1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(content[content.length - 1].data).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
    expect(api.sizes).toEqual([600]);
  });

  it("share-info недоступен — прежний ответ с картинкой, а не ошибка", async () => {
    const result = await qrCode.handler({ surveyId: "s-1" }, { client: client(null) } as never);
    const content = parts(result);

    expect(result.isError).toBeFalsy();
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe("QR code for survey s-1, 300×300px.");
    expect(content[1].type).toBe("image");
  });
});
