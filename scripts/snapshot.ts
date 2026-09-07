/**
 * Snapshot a REAL YouTube channel into data/seed/ in the bundled-dataset format.
 *
 *   npm run snapshot -- @somehandle
 *   npm run snapshot -- @somehandle --slug my-demo --limit 50 --competitors @rival1,@rival2
 *
 * Requires YOUTUBE_API_KEY. Costs ~3 quota units per channel.
 *
 * Why this exists: the bundled demo channels are synthetic (see
 * scripts/generateSeed.ts for the reasoning). If you want the guaranteed-offline
 * demo to run on real creators instead, snapshot them with this and the app will
 * treat them exactly the same way — except the report will no longer carry the
 * "synthetic sample channel" warning, because it will no longer be one.
 */

import fs from "node:fs";
import path from "node:path";

import { QuotaMeter, fetchChannelVideos, hasApiKey } from "../lib/youtube";

interface Args {
  channel: string;
  slug: string;
  limit: number;
  competitors: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  const channel = positional[0];
  if (!channel) {
    console.error("usage: npm run snapshot -- @handle [--slug name] [--limit 50] [--competitors @a,@b]");
    process.exit(1);
  }

  return {
    channel,
    slug: (flag("slug") ?? channel).replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    limit: Math.min(50, Math.max(10, Number(flag("limit") ?? 50))),
    competitors: (flag("competitors") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}

interface ManifestEntry {
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

async function snapshotOne(
  input: string,
  slug: string,
  limit: number,
  meter: QuotaMeter,
  outDir: string,
  isPrimary: boolean,
  competitorSlugs: string[],
): Promise<ManifestEntry> {
  const { record, videos } = await fetchChannelVideos(input, limit, meter);

  const dataset = {
    synthetic: false,
    note: `Snapshot of a real channel taken ${new Date().toISOString()} via the YouTube Data API v3.`,
    anchor: new Date().toISOString(),
    channel: record,
    videos,
  };

  fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(dataset, null, 2));
  console.log(`  wrote data/seed/${slug}.json — ${record.title}, ${videos.length} videos`);

  return {
    slug,
    channelId: record.channelId,
    title: record.title,
    handle: record.handle ?? slug,
    aliases: [...new Set([slug, record.channelId, record.handle ?? slug, `@${record.handle ?? slug}`, record.title])],
    niche: record.description.split(/[.\n]/)[0]?.slice(0, 80) ?? "",
    subscribers: record.subscribers,
    videoCount: videos.length,
    competitors: competitorSlugs,
    isPrimaryDemo: isPrimary,
  };
}

async function main() {
  if (!hasApiKey()) {
    console.error("YOUTUBE_API_KEY is not set. Put it in .env.local (see .env.example) and try again.");
    process.exit(1);
  }

  const args = parseArgs();
  const outDir = path.join(process.cwd(), "data", "seed");
  fs.mkdirSync(outDir, { recursive: true });
  const meter = new QuotaMeter();

  console.log(`\nsnapshotting "${args.channel}" as "${args.slug}"...`);

  const competitorSlugs: string[] = [];
  const entries: ManifestEntry[] = [];

  // Competitors first, so the primary entry can reference their slugs.
  for (const comp of args.competitors.slice(0, 3)) {
    const compSlug = comp.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    try {
      entries.push(await snapshotOne(comp, compSlug, 30, meter, outDir, false, []));
      competitorSlugs.push(compSlug);
    } catch (err) {
      console.error(`  ! skipped competitor ${comp}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  entries.unshift(await snapshotOne(args.channel, args.slug, args.limit, meter, outDir, true, competitorSlugs));

  // Merge into the manifest rather than clobbering it.
  const manifestPath = path.join(outDir, "manifest.json");
  let manifest: { generatedAt: string; channels: ManifestEntry[] } = {
    generatedAt: new Date().toISOString(),
    channels: [],
  };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  }

  for (const entry of entries) {
    const i = manifest.channels.findIndex((c) => c.slug === entry.slug);
    if (i >= 0) manifest.channels[i] = entry;
    else manifest.channels.push(entry);
  }
  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nquota used: ${meter.units} units`);
  console.log(
    `\nIMPORTANT: new snapshots are not bundled until they are imported in data/seed/index.ts.\n` +
      `Add these lines there:\n` +
      entries.map((e) => `  import ${camel(e.slug)} from "./${e.slug}.json";`).join("\n") +
      `\nand add them to the RAW map:\n` +
      entries.map((e) => `  "${e.slug}": ${camel(e.slug)},`).join("\n") +
      `\n\nThe static import is deliberate — a runtime fs read of data/seed works locally and 404s on Vercel.\n`,
  );
}

function camel(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

main().catch((err) => {
  console.error(`\nsnapshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
