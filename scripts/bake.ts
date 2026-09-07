/**
 * Precompute narrations for the bundled demo channels and commit them.
 *
 *   npm run bake            # all demo channels
 *   npm run bake -- devbrief
 *
 * Requires GEMINI_API_KEY. Costs one model request per channel (plus one for
 * the thumbnail pass if --thumbnails is passed).
 *
 * RUN THIS BEFORE DEPLOYING. It is what makes the narrated report available on
 * a cold serverless instance, where the runtime cache is per-instance and
 * therefore no guarantee at all. See data/precomputed/index.ts.
 *
 * Nothing unverified is ever written: a narration is only baked if the numeric
 * claim guard passes on it, and the guard runs again at serve time against the
 * signals of that moment.
 */

import fs from "node:fs";
import path from "node:path";

import { PRECOMPUTED_SCHEMA_VERSION } from "../data/precomputed";
import { DEMO_CHANNELS } from "../data/seed";
import { collectChannelData } from "../lib/agents/dataCollector";
import { analyzePatterns } from "../lib/agents/patternAnalyzer";
import {
  buildBriefing,
  collectAllowedNumbers,
  hasLlmKey,
  PRIMARY_MODEL,
  verifyNumericClaims,
  writeStrategy,
} from "../lib/agents/strategyWriter";
import { analyzeThumbnails } from "../lib/agents/thumbnailAgent";
import { findWhitespace } from "../lib/agents/whitespaceAgent";
import type { StrategyReport, ThumbnailReport } from "../lib/types";

const argv = process.argv.slice(2);
const only = argv.filter((a) => !a.startsWith("--"));
/**
 * The thumbnail pass runs by DEFAULT, because the bake has to reproduce the
 * briefing the server will actually build.
 *
 * It used to be opt-in, and that quietly weakened the whole mechanism: the
 * server always attempts the thumbnail pass, so its briefing contained a
 * different `thumbnails` section from the baked one, the hashes never matched,
 * and every demo channel fell through to the slower guard re-verification tier
 * instead of the exact-match tier. One channel missed re-verification entirely
 * and spent 48s on a live model call during a smoke run.
 *
 * For the bundled demo channels this costs no API request: their thumbnail URLs
 * are synthetic, the downloads fail, and the pass returns before calling the
 * vision model.
 */
const skipThumbnails = argv.includes("--no-thumbnails");

const OUT = path.join(process.cwd(), "data", "precomputed", "narrations.json");

const NO_TH: ThumbnailReport = {
  attempted: false,
  ok: false,
  sampled: 0,
  traits: [],
  guidance: null,
  strength: "inconclusive",
  note: null,
};

interface Entry {
  schemaVersion: number;
  slug: string;
  channelTitle: string;
  briefingHash: string;
  model: string;
  bakedAt: string;
  report: StrategyReport;
}

/** Must match hashString() in strategyWriter.ts exactly. */
function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + input.length.toString(36);
}

async function main() {
  if (!hasLlmKey()) {
    console.error(
      "\nGEMINI_API_KEY is not set, so there is nothing to bake.\n" +
        "Without it the app already works — it uses the deterministic writer — but the\n" +
        "narrated report will not be available on a cold serverless instance.\n",
    );
    process.exit(1);
  }

  const targets = DEMO_CHANNELS.filter((d) => only.length === 0 || only.includes(d.slug));
  if (targets.length === 0) {
    console.error(`No demo channel matched ${JSON.stringify(only)}.`);
    process.exit(1);
  }

  console.log(`\nBaking narrations with ${PRIMARY_MODEL} for ${targets.length} channel(s)\n`);

  // Merge into whatever is already committed rather than clobbering it.
  let existing: Record<string, Entry> = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT, "utf8")).entries ?? {};
  } catch {
    /* first run */
  }

  let baked = 0;
  let skipped = 0;

  for (const demo of targets) {
    process.stdout.write(`  ${demo.title.padEnd(20)} `);

    try {
      const dataset = await collectChannelData(demo.slug, { preferSeed: true });
      const signals = analyzePatterns(dataset);
      const whitespace = await findWhitespace(dataset, signals, {
        seedSlugs: dataset.suggestedCompetitorSlugs,
      });

      const thumbnails = skipThumbnails ? NO_TH : await analyzeThumbnails(signals);

      const briefing = buildBriefing(signals, whitespace, thumbnails);
      const allowed = collectAllowedNumbers(briefing);

      // bypassCache so this is genuinely fresh model output, not a replay of
      // something already cached locally.
      const report = await writeStrategy(signals, whitespace, thumbnails, { bypassCache: true });

      if (report.generatedBy !== "llm") {
        console.log(`SKIPPED — model did not produce a report (${report.modelNote.slice(0, 70)})`);
        skipped += 1;
        continue;
      }

      const guard = verifyNumericClaims(report, allowed);
      if (!guard.ok) {
        console.log(`SKIPPED — failed the numeric guard: ${guard.violations[0]}`);
        skipped += 1;
        continue;
      }

      existing[signals.channel.channelId] = {
        schemaVersion: PRECOMPUTED_SCHEMA_VERSION,
        slug: demo.slug,
        channelTitle: signals.channel.title,
        briefingHash: hashString(JSON.stringify(briefing)),
        model: PRIMARY_MODEL,
        bakedAt: new Date().toISOString(),
        report,
      };

      console.log(`OK — ${report.concepts.length} concepts, all figures verified`);
      baked += 1;
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`);
      skipped += 1;
    }
  }

  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "Generated by `npm run bake`. Committed on purpose: Vercel function instances are ephemeral, so a runtime cache cannot guarantee the narrated report is available on a cold start. Each entry is re-verified against the current computed signals by the numeric claim guard before it is served.",
        entries: existing,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n  ${baked} baked, ${skipped} skipped — ${Object.keys(existing).length} total in data/precomputed/narrations.json`);
  console.log(`  Commit that file. It is what keeps the narrated report available on a cold deploy.\n`);

  if (baked === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
