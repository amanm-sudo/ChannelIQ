/**
 * End-to-end pipeline run from the CLI. Verifies the whole chain without the
 * browser, which makes it the fastest way to confirm a deploy is sane.
 *
 *   npm run pipeline -- devbrief
 *   npm run pipeline -- @somerealhandle          (needs YOUTUBE_API_KEY)
 */

import { DEMO_CHANNELS } from "../data/seed";
import { runPipeline } from "../lib/pipeline";
import { formatCount } from "../lib/stats";
import type { ChannelIQReport } from "../lib/types";

const argv = process.argv.slice(2);
const arg = argv.find((a) => !a.startsWith("-")) ?? DEMO_CHANNELS[0].slug;

// --competitors @a,@b  — the trusted path: naming them skips auto-suggestion,
// costs no search quota, and is far more accurate than a keyword search.
const compIndex = argv.indexOf("--competitors");
const competitors =
  compIndex >= 0 && argv[compIndex + 1]
    ? argv[compIndex + 1].split(",").map((c) => c.trim()).filter(Boolean)
    : [];

async function main() {
  console.log(`\n>> ChannelIQ pipeline: "${arg}"${competitors.length ? ` vs ${competitors.join(", ")}` : ""}\n`);

  let report: ChannelIQReport | null = null;

  for await (const event of runPipeline({ channel: arg, competitors })) {
    if (event.type === "stage") {
      const icon = { start: "..", ok: "OK", skipped: "--", failed: "!!" }[event.status];
      const ms = event.ms !== undefined ? ` (${event.ms}ms)` : "";
      console.log(`[${icon}] ${event.stage.padEnd(11)} ${event.detail}${ms}`);
    } else if (event.type === "log") {
      console.log(`       . ${event.message}`);
    } else if (event.type === "error") {
      console.error(`\n!! ERROR: ${event.message}\n`);
      process.exitCode = 1;
      return;
    } else if (event.type === "report") {
      report = event.report;
    }
  }

  if (!report) {
    console.error("!! no report produced");
    process.exitCode = 1;
    return;
  }

  const s = report.strategy;
  const line = "-".repeat(78);

  console.log(`\n${line}\nHEADLINE\n${line}`);
  console.log(wrap(s.headline));

  console.log(`\n${line}\nDIAGNOSIS\n${line}`);
  console.log(wrap(s.diagnosis));

  console.log(`\n${line}\nWHAT TO MAKE NEXT\n${line}`);
  for (const c of s.concepts) {
    console.log(`\n ${c.rank}. ${c.title}   [${c.kind}]`);
    console.log(wrap(c.rationale, 4));
    for (const e of c.evidence) console.log(`    - ${e}`);
    console.log(`    length: ${c.suggestedLengthMinutes}  |  format: ${c.format}`);
  }

  console.log(`\n${line}\nTITLE FORMULA\n${line}`);
  console.log(` ${s.titleFormula.formula}`);
  console.log(wrap(s.titleFormula.reasoning, 1));
  console.log(`\n before: ${s.titleFormula.rewriteBefore}`);
  console.log(` after:  ${s.titleFormula.rewriteAfter}`);

  console.log(`\n${line}\nLENGTH / TIMING / THUMBNAILS\n${line}`);
  console.log(` length:  ${s.lengthGuidance.band}`);
  console.log(wrap(s.lengthGuidance.reasoning, 3));
  console.log(` timing:  ${s.timingGuidance.slot}  [evidence: ${s.timingGuidance.evidence}]`);
  console.log(wrap(s.timingGuidance.reasoning, 3));
  console.log(` thumbs:  ${s.thumbnailGuidance ?? "(not available)"}`);

  console.log(`\n${line}\nAVOID\n${line}`);
  for (const a of s.avoid) {
    console.log(` x ${a.what}`);
    console.log(wrap(a.why, 4));
  }

  console.log(`\n${line}\nNEXT UPLOAD CHECKLIST\n${line}`);
  s.nextUploadChecklist.forEach((c, i) => console.log(wrap(`${i + 1}. ${c}`, 1)));

  if (report.whitespace.ok) {
    console.log(`\n${line}\nCOMPETITOR WHITESPACE\n${line}`);
    for (const c of report.whitespace.competitors) {
      console.log(` vs ${c.title} — ${formatCount(c.subscribers)} subs, median ${formatCount(c.medianViews)} views (${c.viewRatio.toFixed(1)}x ours)`);
    }
    for (const g of report.whitespace.gaps) {
      console.log(`\n * ${g.topic}`);
      console.log(wrap(g.evidence, 4));
    }
    if (report.whitespace.note) console.log(`\n note: ${report.whitespace.note}`);
  } else if (report.whitespace.note) {
    console.log(`\n whitespace: ${report.whitespace.note}`);
  }

  if (report.warnings.length) {
    console.log(`\n${line}\nWARNINGS\n${line}`);
    for (const w of report.warnings) console.log(wrap(`* ${w}`, 1));
  }

  console.log(`\n${line}`);
  console.log(` written by: ${s.generatedBy}  |  quota units: ${report.dataset.quotaUnits}  |  ${JSON.stringify(report.timings)}`);
  console.log(` note: ${s.modelNote}`);
  console.log(`${line}\n`);
}

function wrap(text: string, indent = 1, width = 76): string {
  const pad = " ".repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width - indent) {
      lines.push(pad + cur.trim());
      cur = w;
    } else {
      cur += " " + w;
    }
  }
  if (cur.trim()) lines.push(pad + cur.trim());
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
