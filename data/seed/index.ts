/**
 * Static registry of the bundled seed datasets.
 *
 * These are imported statically (rather than read off disk with fs) so that
 * Next's bundler traces them into the serverless output. A runtime
 * fs.readFileSync("data/seed/...") works locally and then 404s on Vercel,
 * which is exactly the class of "worked on my machine" failure that kills a
 * live demo.
 */

import batchAndFreeze from "./batch-and-freeze.json";
import devbrief from "./devbrief.json";
import homelabHour from "./homelab-hour.json";
import manifestJson from "./manifest.json";
import plainKitchen from "./plain-kitchen.json";
import rackmounted from "./rackmounted.json";
import selfhostedSundays from "./selfhosted-sundays.json";
import shipfastWeekly from "./shipfast-weekly.json";
import theRefactor from "./the-refactor.json";
import weeknightWok from "./weeknight-wok.json";

import type { ChannelRecord, VideoRecord } from "@/lib/types";

export interface SeedDataset {
  synthetic: boolean;
  note: string;
  anchor: string;
  channel: ChannelRecord;
  videos: VideoRecord[];
}

export interface SeedManifestEntry {
  slug: string;
  channelId: string;
  title: string;
  handle: string;
  aliases: string[];
  niche: string;
  subscribers: number;
  videoCount: number;
  competitors: string[];
  isPrimaryDemo: boolean;
}

const RAW: Record<string, unknown> = {
  "devbrief": devbrief,
  "plain-kitchen": plainKitchen,
  "homelab-hour": homelabHour,
  "shipfast-weekly": shipfastWeekly,
  "the-refactor": theRefactor,
  "weeknight-wok": weeknightWok,
  "batch-and-freeze": batchAndFreeze,
  "rackmounted": rackmounted,
  "selfhosted-sundays": selfhostedSundays,
};

export const SEED_DATASETS = RAW as Record<string, SeedDataset>;

export const SEED_MANIFEST = (manifestJson as { channels: SeedManifestEntry[] }).channels;

/** Match arbitrary user input against a seed channel's aliases. */
export function findSeedSlug(input: string): string | null {
  const needle = input.trim().toLowerCase().replace(/^@/, "");
  if (!needle) return null;

  for (const entry of SEED_MANIFEST) {
    if (entry.slug.toLowerCase() === needle) return entry.slug;
    if (entry.channelId.toLowerCase() === needle) return entry.slug;
    for (const alias of entry.aliases) {
      const a = alias.toLowerCase().replace(/^@/, "");
      if (a === needle) return entry.slug;
    }
  }

  // Tolerate URLs and spacing differences, e.g. "youtube.com/@devbrief".
  const collapsed = needle.replace(/[^a-z0-9]/g, "");
  for (const entry of SEED_MANIFEST) {
    for (const alias of [entry.slug, entry.handle, entry.title, ...entry.aliases]) {
      if (alias && alias.toLowerCase().replace(/[^a-z0-9]/g, "") === collapsed) return entry.slug;
    }
  }
  // Substring match on URL-ish input ("https://youtube.com/@plainkitchen/videos").
  if (collapsed.length >= 6) {
    for (const entry of SEED_MANIFEST) {
      const h = entry.handle.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (h.length >= 6 && collapsed.includes(h)) return entry.slug;
    }
  }
  return null;
}

export function seedEntry(slug: string): SeedManifestEntry | null {
  return SEED_MANIFEST.find((e) => e.slug === slug) ?? null;
}

export const DEMO_CHANNELS = SEED_MANIFEST.filter((e) => e.isPrimaryDemo);
