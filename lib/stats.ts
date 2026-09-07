/**
 * Small statistics + formatting toolkit.
 *
 * Everything here is median/rank based rather than mean based. YouTube view
 * distributions are heavily right-skewed — one viral video will drag a mean
 * so far off that every other video looks like a failure. Medians and rank
 * statistics are the honest choice for samples of 20-50 videos.
 */

import type { Confidence } from "./types";

/**
 * The analysis clock: midnight UTC of the current day.
 *
 * Every figure that is derived from "now" — video ages, days-since-last-covered,
 * the seed timeline shift — is computed against this instead of Date.now(), so
 * the entire analysis is deterministic for a whole UTC day.
 *
 * That property is load-bearing, not tidiness. The precomputed narration bundle
 * is keyed on a hash of the computed briefing, so any value that drifts second
 * to second invalidates it continuously. Two concrete failures came from this:
 *
 *  - `Math.round((target - newest) / week)` in the seed timeline shift sits near
 *    a .5 boundary for part of each week, so a few minutes of elapsed time
 *    flipped the rounding by a WHOLE WEEK. Every video moved 7 days, changing
 *    which ones fell inside the 48h exclusion — a channel baked at n=21 was
 *    being served at n=20 minutes later.
 *  - Video ages ticked over at each video's own time of day rather than at a
 *    day boundary, so figures shifted unpredictably through the day.
 *
 * The visible symptom was demo channels taking 34s instead of 0.2s, because
 * their committed narrations no longer matched and the model was called afresh.
 */
export function analysisDayStart(): number {
  const day = 86_400_000;
  return Math.floor(Date.now() / day) * day;
}

/** Whole days between the analysis clock and an ISO timestamp. Never negative. */
export function ageInDays(publishedAtIso: string): number {
  return Math.max(0, Math.floor((analysisDayStart() - Date.parse(publishedAtIso)) / 86_400_000));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Common-language effect size: the probability that a randomly chosen video
 * from group A outperforms a randomly chosen video from group B. 0.5 means no
 * effect. This is the rank-based backbone of the Mann-Whitney U test and it is
 * far more interpretable than a p-value in a product surface — we can literally
 * print "63% of head-to-head comparisons favour this".
 *
 * O(n*m), which is nothing at our sample sizes.
 */
export function probabilityOfSuperiority(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0.5;
  let wins = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) wins += 1;
      else if (x === y) wins += 0.5;
    }
  }
  return wins / (a.length * b.length);
}

/**
 * How much we trust a cohort-vs-rest comparison.
 *
 * Deliberately conservative. A hackathon demo that confidently tells a creator
 * "post on Thursdays" off the back of two videos is worse than useless, and any
 * judge who has run a channel will spot it. Low-confidence findings still get
 * shown, but the Strategy Writer is instructed to hedge them.
 */
export function gradeConfidence(
  cohortSize: number,
  restSize: number,
  liftPct: number,
  pSuperiority: number,
): Confidence {
  const absLift = Math.abs(liftPct);
  const absEffect = Math.abs(pSuperiority - 0.5);

  if (cohortSize < 3 || restSize < 3) return "low";
  if (cohortSize >= 6 && restSize >= 8 && absLift >= 20 && absEffect >= 0.13) return "high";
  if (cohortSize >= 4 && restSize >= 5 && absLift >= 12 && absEffect >= 0.08) return "medium";
  return "low";
}

export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  high: 1,
  medium: 0.6,
  low: 0.28,
};

/** Percentage change from `base` to `value`, guarded against zero bases. */
export function liftPct(value: number, base: number): number {
  if (base <= 0) return 0;
  return ((value - base) / base) * 100;
}

/** Rank percentile (0-100) of each value within its own array. */
export function percentiles(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const below = sorted.filter((s) => s < v).length;
    const equal = sorted.filter((s) => s === v).length;
    return ((below + equal / 2) / sorted.length) * 100;
  });
}

// ---------------------------------------------------------------------------
// Formatting (shared by the deterministic writer, the LLM prompt and the UI so
// a number is never rendered three different ways)
// ---------------------------------------------------------------------------

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatPct(n: number, digits = 0): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatMultiple(n: number): string {
  if (n >= 10) return `${Math.round(n)}x`;
  return `${n.toFixed(1)}x`;
}

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatHourWindow(hourStart: number, span = 3): string {
  const fmt = (h: number) => {
    const hh = ((h % 24) + 24) % 24;
    const suffix = hh < 12 ? "am" : "pm";
    const display = hh % 12 === 0 ? 12 : hh % 12;
    return `${display}${suffix}`;
  };
  return `${fmt(hourStart)}-${fmt(hourStart + span)}`;
}
