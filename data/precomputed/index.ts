/**
 * PRECOMPUTED NARRATIONS
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime cache in lib/cache.ts cannot be relied on in production, and the
 * distinction matters enough to spell out.
 *
 * Locally, ChannelIQ runs as one long-lived process with a persistent `.cache/`
 * directory, so "run the demo channel once to warm the cache" genuinely works.
 * On Vercel neither of those holds:
 *
 *   - Vercel reuses a warm function instance when requests arrive close
 *     together, but that is opportunistic. A cold start begins with empty
 *     module state.
 *   - Concurrent requests are served by separate instances, each with its own
 *     memory and its own `/tmp`. Nothing is shared between them.
 *   - `/tmp` is ephemeral between invocations and is not a persistence layer.
 *
 * So on the deployed app, every request risks being a cache miss. Combined with
 * the Gemini free tier's 20-requests-per-day-per-model limit, a judge opening a
 * cold deployment could get the deterministic writer instead of the narrated
 * report — and no amount of pre-warming from a laptop changes that.
 *
 * The fix is to not depend on a writable filesystem at all. Narrations for the
 * bundled demo channels are generated ahead of time by `npm run bake` and
 * committed here, then STATICALLY IMPORTED so the bundler traces them into the
 * serverless output. Reading them needs no cache, no network and no API key,
 * and it is immune to cold starts because it is just part of the code.
 *
 * SAFETY
 * ------
 * A committed narration is prose about numbers, and numbers drift. Serving a
 * stale one would reintroduce exactly the problem the numeric guard exists to
 * prevent. So a precomputed narration is only ever served after being
 * re-verified against the CURRENT briefing:
 *
 *   1. If the briefing hash matches the one recorded at bake time, the inputs
 *      are byte-identical and the narration is served as-is.
 *   2. Otherwise the numeric claim guard re-checks every figure in the prose
 *      against today's computed signals. It is served only if every figure
 *      still exists.
 *   3. Otherwise it is discarded and the pipeline calls the model, or falls
 *      back to the deterministic writer.
 *
 * That means a stale narration cannot reach a user, and the worst case is the
 * deterministic writer — which is the real always-available guarantee.
 */

import narrations from "./narrations.json";

import type { StrategyReport } from "@/lib/types";

/**
 * Bump whenever the StrategyReport shape changes.
 *
 * Committed narrations are serialised copies of a typed structure, so a schema
 * change silently invalidates them in a way the compiler cannot see — the JSON
 * is cast on import, so a report baked under an older shape type-checks fine and
 * then renders with `undefined` where a new required field should be. That is
 * exactly what happened when `timingGuidance.isHeuristic` became
 * `timingGuidance.evidence`.
 *
 * Version 2: timingGuidance carries a three-state `evidence` grade instead of an
 * `isHeuristic` boolean.
 * Version 3: thumbnailGuidance is pinned from the analysis and hedged to match
 * ThumbnailReport.strength, so a v2 narration may contain an imperative that the
 * evidence no longer earns.
 */
export const PRECOMPUTED_SCHEMA_VERSION = 3;

export interface PrecomputedNarration {
  schemaVersion: number;
  slug: string;
  channelTitle: string;
  /** Hash of the briefing this was generated from. */
  briefingHash: string;
  model: string;
  bakedAt: string;
  report: StrategyReport;
}

interface NarrationFile {
  generatedAt: string;
  note: string;
  entries: Record<string, PrecomputedNarration>;
}

const FILE = narrations as unknown as NarrationFile;

export function precomputedFor(channelId: string): PrecomputedNarration | null {
  const entry = FILE.entries[channelId];
  if (!entry) return null;
  // Reject anything baked under an older report shape. Serving it would mean
  // rendering missing fields as undefined; falling back to the deterministic
  // writer is strictly better, and `npm run bake` fixes it.
  if (entry.schemaVersion !== PRECOMPUTED_SCHEMA_VERSION) return null;
  return entry;
}

/** Entries present but unusable because they predate the current report shape. */
export function staleSchemaCount(): number {
  return Object.values(FILE.entries).filter((e) => e.schemaVersion !== PRECOMPUTED_SCHEMA_VERSION).length;
}

export function precomputedCount(): number {
  return Object.keys(FILE.entries).length;
}

export function precomputedGeneratedAt(): string {
  return FILE.generatedAt;
}
