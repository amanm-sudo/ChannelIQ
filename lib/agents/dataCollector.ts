/**
 * AGENT 1 — DATA COLLECTOR
 *
 * Responsibility: turn a string a human typed into a clean, normalised
 * ChannelDataset. Nothing else in the pipeline is allowed to talk to the
 * YouTube API.
 *
 * Resolution order:
 *   1. Bundled seed snapshot (if the input names one, or live mode is off)
 *   2. Live YouTube Data API v3 (cheap path, see lib/youtube.ts)
 *   3. Seed snapshot as a last-resort fallback when live fails
 *
 * That third step is the demo insurance policy: a quota error or a flaky
 * network at judging time degrades to "here is a cached channel" instead of a
 * red error box.
 */

import { DEMO_CHANNELS, SEED_DATASETS, findSeedSlug, seedEntry } from "@/data/seed";
import { QuotaMeter, YouTubeError, fetchChannelVideos, hasApiKey } from "@/lib/youtube";
import type { ChannelDataset, ChannelRecord, VideoRecord } from "@/lib/types";

export const DEFAULT_SAMPLE_SIZE = 50;
/** Below this we can still produce a report, but we hedge everything. */
export const MIN_VIABLE_SAMPLE = 8;

export interface CollectOptions {
  sampleSize?: number;
  /** Force the bundled snapshot even when an API key exists (demo button). */
  preferSeed?: boolean;
  meter?: QuotaMeter;
  onLog?: (message: string) => void;
}

export interface CollectResult extends ChannelDataset {
  /** Slug when this came from a bundled snapshot, else null. */
  seedSlug: string | null;
  /** True when the dataset is fabricated sample data, not a real channel. */
  synthetic: boolean;
  /** Slugs of bundled competitor snapshots, when known. */
  suggestedCompetitorSlugs: string[];
}

/**
 * Seed timelines are frozen at generation time. Shifting them forward keeps the
 * bundled demo from ageing into "this channel died 8 months ago".
 *
 * The shift is quantised to whole weeks on purpose: a non-multiple-of-7 shift
 * would rotate every video onto a different weekday and silently destroy the
 * day-of-week signal the Pattern Analysis Agent is supposed to find.
 */
function shiftSeedTimeline(videos: VideoRecord[], targetNewestAgeDays = 4): VideoRecord[] {
  if (videos.length === 0) return videos;
  const newest = Math.max(...videos.map((v) => Date.parse(v.publishedAt)));
  const target = Date.now() - targetNewestAgeDays * 86_400_000;
  const week = 7 * 86_400_000;
  const weeks = Math.round((target - newest) / week);
  if (weeks === 0) return videos;
  const shift = weeks * week;

  return videos.map((v) => ({ ...v, publishedAt: new Date(Date.parse(v.publishedAt) + shift).toISOString() }));
}

/** Drop junk that would poison the statistics. */
function sanitise(videos: VideoRecord[]): { videos: VideoRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const before = videos.length;

  const clean = videos.filter((v) => {
    if (!v.title || !v.publishedAt) return false;
    if (Number.isNaN(Date.parse(v.publishedAt))) return false;
    // Unlisted/processing uploads and premieres report 0 views and would drag
    // every median down, so they are excluded rather than counted as failures.
    if (v.views <= 0) return false;
    // A zero-length duration means the API had no contentDetails for it.
    if (v.durationSeconds <= 0) return false;
    // Videos younger than 48h have not had time to find an audience; including
    // them makes the newest upload look like a flop every single time.
    if (Date.now() - Date.parse(v.publishedAt) < 2 * 86_400_000) return false;
    return true;
  });

  const dropped = before - clean.length;
  if (dropped > 0) {
    warnings.push(
      `Excluded ${dropped} upload${dropped === 1 ? "" : "s"} from the analysis (under 48h old, zero views, or missing metadata).`,
    );
  }

  clean.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { videos: clean, warnings };
}

function loadSeed(slug: string, sampleSize: number): CollectResult {
  const raw = SEED_DATASETS[slug];
  if (!raw) throw new Error(`Unknown seed dataset "${slug}"`);

  const shifted = shiftSeedTimeline(raw.videos);
  const { videos, warnings } = sanitise(shifted);
  const trimmed = videos.slice(0, sampleSize);
  const entry = seedEntry(slug);

  return {
    channel: raw.channel as ChannelRecord,
    videos: trimmed,
    source: "seed",
    fetchedAt: new Date().toISOString(),
    quotaUnits: 0,
    warnings,
    seedSlug: slug,
    synthetic: raw.synthetic !== false,
    suggestedCompetitorSlugs: entry?.competitors ?? [],
  };
}

export async function collectChannelData(input: string, options: CollectOptions = {}): Promise<CollectResult> {
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const log = options.onLog ?? (() => {});
  const trimmed = input.trim();

  if (!trimmed) {
    throw new CollectorError("Enter a YouTube channel handle or URL to get started.", "empty_input");
  }

  // 1. Bundled snapshot, either because it was asked for or because it matches.
  const seedSlug = findSeedSlug(trimmed);
  if (options.preferSeed || (seedSlug && !hasApiKey())) {
    const slug = seedSlug ?? DEMO_CHANNELS[0].slug;
    log(`Loading bundled snapshot: ${SEED_DATASETS[slug].channel.title}`);
    return loadSeed(slug, sampleSize);
  }
  if (seedSlug) {
    // Seed names always win over the live API — "devbrief" is not a real
    // channel, and we would rather serve the known-good demo than a stranger.
    log(`Loading bundled snapshot: ${SEED_DATASETS[seedSlug].channel.title}`);
    return loadSeed(seedSlug, sampleSize);
  }

  // 2. Live mode.
  if (!hasApiKey()) {
    throw new CollectorError(
      `Live channel lookup needs a YOUTUBE_API_KEY. Without one you can still run the full pipeline on a bundled demo channel.`,
      "no_key",
      DEMO_CHANNELS.map((c) => c.title),
    );
  }

  try {
    log(`Resolving "${trimmed}" via YouTube Data API v3...`);
    const unitsBefore = options.meter?.units ?? 0;
    const { record, videos } = await fetchChannelVideos(trimmed, sampleSize, options.meter);
    // Say which it was. This used to log "Fetched N uploads" unconditionally,
    // including on a pure cache hit, which is actively misleading when you are
    // trying to work out whether a result came from the live API or not.
    const unitsSpent = (options.meter?.units ?? 0) - unitsBefore;
    log(
      unitsSpent === 0
        ? `Loaded ${videos.length} cached uploads for ${record.title} (no API calls)`
        : `Fetched ${videos.length} uploads for ${record.title} (${unitsSpent} quota units)`,
    );

    const { videos: clean, warnings } = sanitise(videos);
    if (clean.length < MIN_VIABLE_SAMPLE) {
      throw new CollectorError(
        `${record.title} only has ${clean.length} analysable public upload${clean.length === 1 ? "" : "s"}. ChannelIQ needs at least ${MIN_VIABLE_SAMPLE} to find real patterns rather than noise.`,
        "too_few_videos",
      );
    }

    return {
      channel: record,
      videos: clean,
      source: "live",
      fetchedAt: new Date().toISOString(),
      quotaUnits: options.meter?.units ?? 0,
      warnings,
      seedSlug: null,
      synthetic: false,
      suggestedCompetitorSlugs: [],
    };
  } catch (err) {
    if (err instanceof CollectorError) throw err;

    if (err instanceof YouTubeError) {
      // Not-found is the user's mistake and must be reported honestly. Quota,
      // network and key problems are OUR problem, so we degrade gracefully.
      if (err.kind === "not_found") {
        throw new CollectorError(
          `We could not find a YouTube channel for "${trimmed}". Try the @handle or the full channel URL.`,
          "not_found",
        );
      }
      throw new CollectorError(
        err.kind === "quota"
          ? "YouTube's daily API quota is exhausted. Run a bundled demo channel instead — the analysis pipeline is identical."
          : `YouTube API is unavailable right now (${err.message}). Run a bundled demo channel instead.`,
        err.kind === "quota" ? "quota" : "upstream",
        DEMO_CHANNELS.map((c) => c.title),
      );
    }

    throw new CollectorError(
      `Unexpected error collecting channel data: ${err instanceof Error ? err.message : String(err)}`,
      "unknown",
    );
  }
}

export type CollectorErrorKind =
  | "empty_input"
  | "not_found"
  | "no_key"
  | "quota"
  | "upstream"
  | "too_few_videos"
  | "unknown";

export class CollectorError extends Error {
  constructor(
    message: string,
    readonly kind: CollectorErrorKind,
    /** Demo channel titles to offer as a way forward. */
    readonly suggestions: string[] = [],
  ) {
    super(message);
    this.name = "CollectorError";
  }
}

/** Load a competitor dataset from the bundled snapshots. */
export function loadSeedCompetitor(slug: string, sampleSize = 30): ChannelDataset | null {
  const raw = SEED_DATASETS[slug];
  if (!raw) return null;
  const { videos, warnings } = sanitise(shiftSeedTimeline(raw.videos));
  return {
    channel: raw.channel as ChannelRecord,
    videos: videos.slice(0, sampleSize),
    source: "seed",
    fetchedAt: new Date().toISOString(),
    quotaUnits: 0,
    warnings,
  };
}
