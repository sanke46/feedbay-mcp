/**
 * Cross-sections of a survey's responses, computed here because the API has no
 * endpoint for them.
 *
 * `/results/overview` returns totals and a per-question tally and nothing else —
 * no geography, device, channel or time series, even though every response row
 * carries `countryCode`, `device`, `channel` and timestamps. Rather than send a
 * chat thousands of raw rows to count by hand, the server pages through them
 * once and returns the summary.
 */

import type { SurveyResponseItem } from "../types.js";

export interface BreakdownSlice {
  key: string;
  label: string;
  count: number;
  /** Share of all responses in the set, 0-100, rounded to one decimal. */
  percentage: number;
}

export interface DailyPoint {
  /** ISO date, YYYY-MM-DD, in UTC. */
  date: string;
  started: number;
  completed: number;
}

export interface DurationSummary {
  averageSeconds: number | null;
  medianSeconds: number | null;
  p90Seconds: number | null;
  /** Responses that carried no duration and were excluded from the stats above. */
  missing: number;
}

export interface ResponseBreakdown {
  totalResponses: number;
  completedResponses: number;
  /** 0-100, one decimal. */
  completionRate: number;
  byCountry: BreakdownSlice[];
  byDevice: BreakdownSlice[];
  byChannel: BreakdownSlice[];
  byDay: DailyPoint[];
  duration: DurationSummary;
}

function percentage(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function tally(
  responses: readonly SurveyResponseItem[],
  pick: (response: SurveyResponseItem) => { key: string; label: string },
): BreakdownSlice[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const response of responses) {
    const { key, label } = pick(response);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label, count: 1 });
  }
  return [...counts.entries()]
    .map(([key, { label, count }]) => ({ key, label, count, percentage: percentage(count, responses.length) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  if (lower === upper) return Math.round(lowerValue);
  return Math.round(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function summariseDurations(responses: readonly SurveyResponseItem[]): DurationSummary {
  const durations = responses
    .map((response) => response.durationSeconds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (durations.length === 0) {
    return { averageSeconds: null, medianSeconds: null, p90Seconds: null, missing: responses.length };
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    averageSeconds: Math.round(total / durations.length),
    medianSeconds: quantile(durations, 0.5),
    p90Seconds: quantile(durations, 0.9),
    missing: responses.length - durations.length,
  };
}

function utcDay(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function buildBreakdown(responses: readonly SurveyResponseItem[]): ResponseBreakdown {
  const completed = responses.filter((response) => response.completed).length;

  const days = new Map<string, DailyPoint>();
  for (const response of responses) {
    const day = utcDay(response.startedAt) ?? utcDay(response.createdAt);
    if (!day) continue;
    const point = days.get(day) ?? { date: day, started: 0, completed: 0 };
    point.started += 1;
    if (response.completed) point.completed += 1;
    days.set(day, point);
  }

  return {
    totalResponses: responses.length,
    completedResponses: completed,
    completionRate: percentage(completed, responses.length),
    byCountry: tally(responses, (response) => ({
      key: response.countryCode ?? "unknown",
      // Geo lookup is async and best-effort, so a null country is normal for
      // rows enriched moments ago or for IPs the provider could not resolve.
      label: response.countryName ?? response.countryCode ?? "Unknown",
    })),
    byDevice: tally(responses, (response) => ({
      key: response.device ?? "unknown",
      label: response.device ?? "Unknown",
    })),
    byChannel: tally(responses, (response) => ({
      key: response.channel ?? "unknown",
      label: response.channel ?? "Unknown",
    })),
    byDay: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    duration: summariseDurations(responses),
  };
}
