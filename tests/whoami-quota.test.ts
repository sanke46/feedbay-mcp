import { describe, expect, it } from "vitest";
import { metaTools } from "../src/tools/meta.js";
import type { ResponseLimit, UserProfile } from "../src/types.js";

/**
 * Что ассистент узнаёт о квоте.
 *
 * <p>Бэкенд подставляет безлимиту `total = remaining = 1 000 000 000` — это
 * страховка на потребителя, который про флаг `unlimited` не знает: он посчитает
 * остаток положительным и пропустит. Но модель читает ПЕРВУЮ СТРОКУ результата
 * и рассуждает по ней, и «Responses used: 42/1000000000» — правдоподобная
 * неправда, на которой она построит совет («у вас почти миллиард ответов в
 * запасе»). Слово «no limit» и короче, и честнее.
 */

const whoami = metaTools.find((tool) => tool.name === "feedbay_whoami")!;

const PROFILE = { email: "owner@feedbay.io", id: "u-1" } as UserProfile;

async function summary(quota: ResponseLimit): Promise<string> {
  const result = await whoami.handler({}, {
    client: {
      getProfile: async () => PROFILE,
      getResponseLimit: async () => quota,
    },
    config: { apiUrl: "http://localhost:8080/api/v1", readOnly: false },
  } as never);
  return (result.content[0] as { text: string }).text;
}

describe("feedbay_whoami quota line", () => {
  it("обычная квота остаётся тремя числами", async () => {
    const text = await summary({ used: 128, total: 1500, remaining: 1372, resetDate: null });

    expect(text).toMatch(/^Signed in as owner@feedbay\.io\. Responses used: 128\/1500 \(1372 left\)\. /);
  });

  it("безлимит описывается словами, а подставленный миллиард не звучит", async () => {
    const text = await summary({
      used: 42,
      total: 1_000_000_000,
      remaining: 999_999_958,
      resetDate: null,
      unlimited: true,
    });

    expect(text).toMatch(/^Signed in as owner@feedbay\.io\. Responses used: 42 \(no limit\)\. /);
    expect(text).not.toContain("1000000000");
    expect(text).not.toContain("999999958");
  });

  it("право публиковать сказано прямо, когда бэкенд его сообщает", async () => {
    expect(await summary({ used: 0, total: 500, remaining: 500, resetDate: null, canPublish: true })).toContain(
      "This account can publish.",
    );
    expect(await summary({ used: 0, total: 500, remaining: 500, resetDate: null, canPublish: false })).toContain(
      "cannot publish until it has a paid plan",
    );
  });

  it("без ответа бэкенда модель не зовут выяснять тариф пробной публикацией", async () => {
    expect(await summary({ used: 0, total: 500, remaining: 500, resetDate: null })).toContain(
      "Do not publish just to find out",
    );
  });
});

describe("feedbay_whoami не отдаёт модели лишнего", () => {
  it("ни адреса API внутри сети, ни телефона, ни аватара", async () => {
    const result = await whoami.handler({}, {
      client: {
        getProfile: async () =>
          ({ ...PROFILE, phone: "+70000000000", avatarUrl: "https://cdn/a.png", provider: "GOOGLE" }) as UserProfile,
        getResponseLimit: async () => ({ used: 0, total: 500, remaining: 500, resetDate: null }),
      },
      config: { apiUrl: "http://backend:8080", readOnly: false },
    } as never);
    const payload = (result.content[1] as { text: string }).text;

    expect(payload).not.toMatch(/backend:8080|\+70000000000|cdn\/a\.png|GOOGLE/);
    expect(JSON.parse(payload).notAvailableInFeedBay.length).toBeGreaterThan(0);
  });
});
