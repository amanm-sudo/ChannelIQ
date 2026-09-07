/**
 * Day-2 sanity harness. Not a unit test suite — a "do these numbers survive
 * being looked at by a human" check.
 *
 * Run: npx tsx scripts/sanityCheck.ts
 */

import { DEMO_CHANNELS } from "../data/seed";
import { collectChannelData } from "../lib/agents/dataCollector";
import { analyzePatterns } from "../lib/agents/patternAnalyzer";
import { formatCount, formatPct, WEEKDAY_SHORT, formatHourWindow } from "../lib/stats";

function rule(label: string) {
  console.log(`\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}`);
}

async function main() {
  for (const demo of DEMO_CHANNELS) {
    const dataset = await collectChannelData(demo.slug, { preferSeed: true });
    const s = analyzePatterns(dataset);

    rule(`${s.channel.title}  (${formatCount(s.channel.subscribers)} subs, n=${s.sampleSize})`);
    console.log(`window        ${s.windowStart.slice(0, 10)} -> ${s.windowEnd.slice(0, 10)}`);
    console.log(`timezone      ${s.timezone.label} (from ${s.timezone.inferredFrom})`);
    console.log(`median views  ${formatCount(s.medianViews)}`);
    console.log(`like rate     ${(s.medianLikeRate * 100).toFixed(2)}%   comment rate ${(s.medianCommentRate * 100).toFixed(3)}%`);
    console.log(`cadence       every ${s.cadence.medianDaysBetweenUploads}d, ${s.cadence.uploadsPerMonth}/mo, consistency ${s.cadence.consistencyScore}`);
    console.log(`trend         ${s.trend.direction} ${formatPct(s.trend.changePct)} (${s.trend.confidence})`);

    // performanceIndex must centre on ~1.0 by construction. If it does not, the
    // rolling baseline is broken.
    const idx = s.scoredVideos.map((v) => v.performanceIndex).sort((a, b) => a - b);
    const med = idx[Math.floor(idx.length / 2)];
    console.log(`perfIndex     median ${med.toFixed(3)}  min ${idx[0].toFixed(2)}  max ${idx[idx.length - 1].toFixed(2)}`);
    if (Math.abs(med - 1) > 0.15) console.log(`  !! WARNING: performanceIndex median is off 1.0 — baseline may be wrong`);

    console.log(`\n-- title patterns (by lift) --`);
    for (const t of s.titlePatterns) {
      console.log(
        `  ${t.label.padEnd(38)} n=${String(t.videoCount).padStart(2)} lift ${formatPct(t.liftPct).padStart(7)} P(sup)=${t.pSuperiority.toFixed(2)} [${t.confidence}]`,
      );
    }

    console.log(`\n-- length buckets --`);
    for (const b of s.lengthBuckets) {
      console.log(`  ${b.label.padEnd(38)} n=${String(b.videoCount).padStart(2)} lift ${formatPct(b.liftPct).padStart(7)} [${b.confidence}]`);
    }

    console.log(`\n-- title length bands --`);
    for (const b of s.titleLength.bands) {
      console.log(`  ${b.label.padEnd(38)} n=${String(b.videoCount).padStart(2)} lift ${formatPct(b.liftPct).padStart(7)} [${b.confidence}]`);
    }
    console.log(`  channel median title length: ${s.titleLength.channelMedianChars} chars`);

    console.log(`\n-- weekday medianIndex --`);
    console.log(
      "  " +
        s.timing.weekdayTotals
          .map((w) => `${WEEKDAY_SHORT[w.weekday]}:${w.videoCount ? w.medianIndex.toFixed(2) : "--"}(${w.videoCount})`)
          .join("  "),
    );
    console.log(`\n-- best slots --  (dataThin=${s.timing.dataThin})`);
    for (const slot of s.timing.bestSlots) {
      console.log(
        `  ${slot.weekdayLabel} ${formatHourWindow(slot.hourStart)} n=${slot.videoCount} lift ${formatPct(slot.liftPct)} [${slot.confidence}]`,
      );
    }

    console.log(`\n-- topics --`);
    for (const t of s.topics.slice(0, 8)) {
      console.log(
        `  ${t.label.padEnd(34)} n=${String(t.videoCount).padStart(2)} lift ${formatPct(t.liftPct).padStart(7)} med ${formatCount(t.medianViews).padStart(6)} last ${t.daysSinceLastCovered}d [${t.confidence}]`,
      );
    }

    console.log(`\n-- top ranked findings --`);
    for (const f of s.rankedFindings.slice(0, 6)) {
      console.log(`  [${f.confidence.padEnd(6)} w=${f.weight.toFixed(0).padStart(4)}] ${f.statement}`);
    }

    if (s.warnings.length) {
      console.log(`\n-- warnings --`);
      for (const w of s.warnings) console.log(`  * ${w}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
