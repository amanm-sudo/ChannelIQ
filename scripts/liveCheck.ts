/**
 * Live end-to-end check through the HTTP endpoint the browser actually uses.
 * Separate from smokeTest.ts because it costs real YouTube quota.
 *
 *   npx tsx scripts/liveCheck.ts http://localhost:3111 @mkbhd
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHANNEL = process.argv[3] ?? "@mkbhd";

async function main() {
  console.log(`\nlive check: ${CHANNEL} via ${BASE}\n`);

  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: CHANNEL }),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
    return;
  }

  const events = (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);

  for (const e of events) {
    if (e.type === "stage") console.log(`  [${e.status.padEnd(7)}] ${String(e.stage).padEnd(11)} ${e.detail}`);
    if (e.type === "log") console.log(`            . ${e.message}`);
    if (e.type === "error") console.log(`  [error]  ${e.message}`);
  }

  const r = events.find((e) => e.type === "report")?.report;
  if (!r) {
    console.error("\nno report produced");
    process.exitCode = 1;
    return;
  }

  console.log(`\n  source:      ${r.dataset.source}`);
  console.log(`  channel:     ${r.dataset.channel.title} (${r.dataset.channel.subscribers} subs)`);
  console.log(`  sample:      ${r.dataset.sampleSize} uploads, ${r.dataset.quotaUnits} quota units`);
  console.log(`  written by:  ${r.strategy.generatedBy}`);
  console.log(`  model note:  ${r.strategy.modelNote}`);
  console.log(`\n  headline:    ${r.strategy.headline}`);
  console.log(`  concepts:`);
  for (const c of r.strategy.concepts) console.log(`    ${c.rank}. [${c.kind}] ${c.title}`);
  console.log(`\n  rewrite:     "${r.strategy.titleFormula.rewriteBefore}"`);
  console.log(`          ->   "${r.strategy.titleFormula.rewriteAfter}"`);
  console.log(`  timing:      ${r.strategy.timingGuidance.slot}  [evidence: ${r.strategy.timingGuidance.evidence}]`);

  console.log(`\n  thumbnails:  attempted=${r.thumbnails.attempted} ok=${r.thumbnails.ok} sampled=${r.thumbnails.sampled}`);
  for (const t of r.thumbnails.traits ?? []) {
    console.log(`    ${String(t.trait).padEnd(14)} n=${t.videoCount} lift=${t.liftPct.toFixed(0)}% [${t.confidence}]`);
  }
  if (r.thumbnails.guidance) console.log(`    guidance: ${r.thumbnails.guidance}`);
  if (r.thumbnails.note) console.log(`    note: ${r.thumbnails.note}`);

  console.log(`\n  whitespace:  ok=${r.whitespace.ok} gaps=${r.whitespace.gaps.length}`);
  if (r.whitespace.note) console.log(`    note: ${r.whitespace.note}`);

  const realTitle = r.signals.scoredVideos.some((v: any) => v.title === r.strategy.titleFormula.rewriteBefore);
  console.log(`\n  rewriteBefore is a real title: ${realTitle ? "yes" : "NO — BUG"}`);

  // A bundled demo slug is EXPECTED to report source=seed; only a channel that
  // looks like a real handle or URL is expected to come back live.
  const expectedLive = /^(@|https?:|UC)/.test(CHANNEL);
  console.log(`  data source:                   ${r.dataset.source}${expectedLive && r.dataset.source !== "live" ? " — expected live!" : ""}`);
  if (!realTitle || (expectedLive && r.dataset.source !== "live")) process.exitCode = 1;
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// This file has no imports, which would otherwise make it a global script and
// collide with the identically-named top-level bindings in smokeTest.ts.
export {};
