import { describe, expect, it } from "vitest";
import { buildBreakdown } from "../src/domain/aggregate.js";
import type { SurveyResponseItem } from "../src/types.js";

function response(overrides: Partial<SurveyResponseItem> = {}): SurveyResponseItem {
  return {
    id: Math.random().toString(36).slice(2),
    surveyId: "survey-1",
    responseNumber: 1,
    visitorId: null,
    sessionId: null,
    answers: {},
    metadata: {},
    completed: true,
    startedAt: "2026-08-01T10:00:00Z",
    completedAt: "2026-08-01T10:02:00Z",
    ipAddress: null,
    userAgent: null,
    referrer: null,
    channel: "web",
    createdAt: "2026-08-01T10:00:00Z",
    countryCode: "DE",
    countryName: "Germany",
    device: "DESKTOP",
    durationSeconds: 120,
    durationFormatted: "2m 0s",
    ...overrides,
  };
}

describe("response breakdown", () => {
  it("handles an empty set without dividing by zero", () => {
    const breakdown = buildBreakdown([]);
    expect(breakdown).toMatchObject({ totalResponses: 0, completedResponses: 0, completionRate: 0 });
    expect(breakdown.byCountry).toEqual([]);
    expect(breakdown.duration.averageSeconds).toBeNull();
  });

  it("counts completion as a percentage", () => {
    const breakdown = buildBreakdown([
      response({ completed: true }),
      response({ completed: true }),
      response({ completed: false }),
    ]);
    expect(breakdown.completedResponses).toBe(2);
    expect(breakdown.completionRate).toBeCloseTo(66.7, 1);
  });

  it("groups by country, device and channel, largest first", () => {
    const breakdown = buildBreakdown([
      response({ countryCode: "DE", countryName: "Germany", device: "MOBILE", channel: "widget" }),
      response({ countryCode: "DE", countryName: "Germany", device: "DESKTOP", channel: "web" }),
      response({ countryCode: "FR", countryName: "France", device: "MOBILE", channel: "widget" }),
    ]);
    expect(breakdown.byCountry[0]).toMatchObject({ key: "DE", label: "Germany", count: 2 });
    expect(breakdown.byDevice[0]).toMatchObject({ key: "MOBILE", count: 2 });
    expect(breakdown.byChannel[0]).toMatchObject({ key: "widget", count: 2 });
  });

  it("labels rows the geo lookup could not resolve rather than dropping them", () => {
    const breakdown = buildBreakdown([response({ countryCode: null, countryName: null, device: null, channel: null })]);
    expect(breakdown.byCountry).toEqual([{ key: "unknown", label: "Unknown", count: 1, percentage: 100 }]);
    expect(breakdown.byDevice[0]?.label).toBe("Unknown");
  });

  it("builds a chronological daily series of starts and completions", () => {
    const breakdown = buildBreakdown([
      response({ startedAt: "2026-08-02T09:00:00Z", completed: false }),
      response({ startedAt: "2026-08-01T23:00:00Z", completed: true }),
      response({ startedAt: "2026-08-01T08:00:00Z", completed: true }),
    ]);
    expect(breakdown.byDay).toEqual([
      { date: "2026-08-01", started: 2, completed: 2 },
      { date: "2026-08-02", started: 1, completed: 0 },
    ]);
  });

  it("summarises durations and reports how many rows had none", () => {
    const breakdown = buildBreakdown([
      response({ durationSeconds: 10 }),
      response({ durationSeconds: 20 }),
      response({ durationSeconds: 120 }),
      response({ durationSeconds: null }),
    ]);
    expect(breakdown.duration.averageSeconds).toBe(50);
    expect(breakdown.duration.medianSeconds).toBe(20);
    expect(breakdown.duration.p90Seconds).toBe(100);
    expect(breakdown.duration.missing).toBe(1);
  });
});
