/**
 * HTTP smoke test against a running server. Exercises the real streaming
 * endpoint the browser uses, including the failure paths.
 *
 *   npx tsx scripts/smokeTest.ts http://localhost:3111
 */

const BASE = process.argv[2] ?? "http://localhost:3000";

interface Case {
  name: string;
  body: Record<string, unknown>;
  expect: "report" | "error";
}

const CASES: Case[] = [
  { name: "bundled demo channel", body: { channel: "devbrief", preferSeed: true }, expect: "report" },
  { name: "demo by @handle", body: { channel: "@plainkitchen" }, expect: "report" },
  { name: "demo by url", body: { channel: "https://youtube.com/@homelabhour/videos" }, expect: "report" },
  { name: "thin-data channel", body: { channel: "homelab-hour", preferSeed: true }, expect: "report" },
  // A mistyped handle must fail loudly. It must NOT fuzzy-match to some other
  // channel and hand back a confident report about the wrong creator.
  { name: "unknown @handle", body: { channel: "@definitely-not-a-real-channel-xyz" }, expect: "error" },
  { name: "unknown channel id", body: { channel: "UCzzzzzzzzzzzzzzzzzzzzzz" }, expect: "error" },
  { name: "empty input", body: { channel: "   " }, expect: "error" },
  { name: "absurdly long input", body: { channel: "x".repeat(400) }, expect: "error" },
];

let failures = 0;

async function runCase(c: Case) {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c.body),
  });

  // A 400 counts as a handled error, which is what we want for bad input.
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const ok = c.expect === "error";
    report(c, ok, `HTTP ${res.status}: ${body.error ?? "(no message)"}`);
    return;
  }

  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);

  const reportEvent = events.find((e) => e.type === "report");
  const errorEvent = events.find((e) => e.type === "error");
  const stages = events.filter((e) => e.type === "stage");

  if (c.expect === "report") {
    if (!reportEvent) {
      report(c, false, `no report event. error=${errorEvent?.message ?? "none"}`);
      return;
    }
    const r = reportEvent.report;
    const checks: Array<[string, boolean]> = [
      ["has channel title", Boolean(r.dataset?.channel?.title)],
      ["sample size > 0", r.dataset?.sampleSize > 0],
      ["has diagnosis", typeof r.strategy?.diagnosis === "string" && r.strategy.diagnosis.length > 40],
      ["has headline", typeof r.strategy?.headline === "string" && r.strategy.headline.length > 20],
      ["1-3 concepts", r.strategy?.concepts?.length >= 1 && r.strategy.concepts.length <= 3],
      ["every concept has a title", r.strategy?.concepts?.every((x: any) => x.title?.length > 5)],
      ["every concept cites evidence", r.strategy?.concepts?.every((x: any) => x.rationale?.length > 40)],
      ["rewriteBefore is a real title", r.signals?.scoredVideos?.some((v: any) => v.title === r.strategy?.titleFormula?.rewriteBefore)],
      ["has checklist", r.strategy?.nextUploadChecklist?.length >= 3],
      ["has ranked findings", r.signals?.rankedFindings?.length > 0],
      ["performance index centred near 1", indexCentred(r.signals?.scoredVideos ?? [])],
      ["timings recorded", typeof r.timings?.total === "number"],
      ["terminal done stage", stages.some((s) => s.stage === "done" && s.status === "ok")],
      ["no failed fatal stage", !stages.some((s) => s.status === "failed" && (s.stage === "collect" || s.stage === "analyze"))],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
    report(c, bad.length === 0, bad.length ? `failed checks: ${bad.join(", ")}` : summarise(r));
  } else {
    if (errorEvent) report(c, true, errorEvent.message.slice(0, 120));
    else report(c, false, `expected an error event, got ${reportEvent ? "a report" : "nothing"}`);
  }
}

function indexCentred(videos: Array<{ performanceIndex: number }>): boolean {
  if (videos.length === 0) return false;
  const s = videos.map((v) => v.performanceIndex).sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return Math.abs(med - 1) < 0.2;
}

function summarise(r: any): string {
  return (
    `${r.dataset.channel.title}, n=${r.dataset.sampleSize}, ` +
    `${r.strategy.concepts.length} concepts, ${r.whitespace.gaps.length} gaps, ` +
    `${r.signals.rankedFindings.length} findings, ${r.timings.total}ms, by ${r.strategy.generatedBy}`
  );
}

function report(c: Case, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name.padEnd(30)} ${detail}`);
}

async function main() {
  console.log(`\nsmoke testing ${BASE}\n`);

  const caps = await fetch(`${BASE}/api/capabilities`).then((r) => r.json());
  console.log(
    `capabilities: liveMode=${caps.liveMode} llm=${caps.llmNarration} model=${caps.model ?? "none"} demos=${caps.demoChannels.length}\n`,
  );

  for (const c of CASES) {
    try {
      await runCase(c);
    } catch (err) {
      report(c, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} case(s) failed`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();

// See the note in liveCheck.ts: keeps this file a module rather than a global
// script, so its top-level `BASE` and `main` do not collide.
export {};
