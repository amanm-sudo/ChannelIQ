/**
 * NUMERIC CLAIM GUARD — test suite.
 *
 *   npx tsx scripts/guardTest.ts              # offline fixtures only
 *   npx tsx scripts/guardTest.ts --live       # + real Gemini output (needs GEMINI_API_KEY)
 *
 * WHY THIS EXISTS
 * ---------------
 * The guard is what lets ChannelIQ put LLM prose in front of a user without
 * risking a fabricated statistic. It is therefore the one component where a
 * silent regression is genuinely dangerous, and it is NOT provider-neutral by
 * default: it is a text parser, and different models format numbers
 * differently. Grouped thousands, K/M/B suffixes, "1.8x" multipliers,
 * percentages with and without signs, numbers quoted from real video titles —
 * each is a way for a correct report to be rejected, or a fabricated one
 * accepted.
 *
 * PART A (offline) pins the parsing behaviour against adversarial fixtures.
 * PART B (--live) runs the real model and checks two separate things:
 *   1. no FALSE POSITIVES on genuine output, and
 *   2. that a deliberately corrupted version of that same real output IS caught.
 * The second half matters most: a guard that never fires is indistinguishable
 * from a guard that works, until the day it needs to work.
 */

import { precomputedCount, precomputedFor, staleSchemaCount } from "../data/precomputed";
import { DEMO_CHANNELS } from "../data/seed";
import { collectChannelData } from "../lib/agents/dataCollector";
import { analyzePatterns } from "../lib/agents/patternAnalyzer";
import {
  buildBriefing,
  collectAllowedNumbers,
  extractNumbers,
  hasLlmKey,
  PRIMARY_MODEL,
  validateResponseSchema,
  verifyNumericClaims,
  writeStrategy,
  writeStrategyDeterministic,
} from "../lib/agents/strategyWriter";
import { tokenize } from "../lib/agents/patternAnalyzer";
import { summariseTraits } from "../lib/agents/thumbnailAgent";
import { findWhitespace } from "../lib/agents/whitespaceAgent";
import type {
  GuidanceStrength,
  StrategyReport,
  ThumbnailReport,
  ThumbnailTraitSegment,
  WhitespaceReport,
} from "../lib/types";

const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

// ===========================================================================
// PART A1 — the number parser itself
// ===========================================================================

function testSchema() {
  section("A0. Response schema is internally consistent");
  const problems = validateResponseSchema();
  check(
    "propertyOrdering and required only name real properties",
    problems.length === 0,
    problems.length === 0 ? "" : problems.join(" | "),
  );
}

function testParser() {
  section("A1. Number extraction");

  const cases: Array<{ text: string; expect: Array<[string, number]> }> = [
    { text: "median of 3800000 views", expect: [["3800000", 3_800_000]] },
    { text: "median of 3.8M views", expect: [["3.8M", 3_800_000]] },
    { text: "median of 137K views", expect: [["137K", 137_000]] },
    // Grouped thousands: the format that silently broke the original guard.
    { text: "median of 3,800,000 views", expect: [["3,800,000", 3_800_000]] },
    { text: "a total of 1,250 uploads", expect: [["1,250", 1_250]] },
    { text: "runs +84% against the rest", expect: [["84%", 84]] },
    { text: "runs -33% against the rest", expect: [["-33%", -33]] },
    { text: "at 2.3x your median", expect: [["2.3x", 2.3]] },
    { text: "1.2B lifetime views", expect: [["1.2B", 1_200_000_000]] },
    { text: "n=13 videos", expect: [["13", 13]] },
    { text: "a 4.35% like rate", expect: [["4.35%", 4.35]] },
    { text: "no numbers at all here", expect: [] },
  ];

  // Hashtags and mentions must never survive tokenisation. Against a real
  // channel this produced the recommendation to make videos about
  // "#ashusir #scienceandfun" — a competitor's own branding hashtags — graded
  // high confidence.
  const branding = tokenize("Aap kar paate ? | Science Experiment #ashusir #scienceandfun @somechannel");
  check(
    "tokenizer strips hashtags and mentions",
    !branding.some((t) => /ashusir|scienceandfun|somechannel/.test(t)),
    branding.join(" "),
  );

  for (const c of cases) {
    const got = extractNumbers(c.text);
    const ok =
      got.length === c.expect.length &&
      c.expect.every(([raw, value], i) => got[i].raw === raw && Math.abs(got[i].value - value) < 0.001);
    check(
      `parse ${JSON.stringify(c.text)}`,
      ok,
      ok ? "" : `got ${JSON.stringify(got.map((g) => [g.raw, g.value]))}`,
    );
  }
}

// ===========================================================================
// PART A2 — the guard, against a fixed briefing
// ===========================================================================

const BRIEFING = {
  channel: { title: "Test Channel", subscribers: 214_000, sampleSize: 48, medianViews: 79_000, medianLikeRatePct: 4.35 },
  rankedFindings: [
    { statement: 'Videos about "docker compose" (13 videos) run +102% against other topics; median 137000 views.', liftPct: 102, videoCount: 13 },
    { statement: "10-20 min videos (22 of them) run +84% against every other length.", liftPct: 84, videoCount: 22 },
  ],
  topics: [{ label: "kubernetes", n: 6, liftPct: -61, medianViews: 39_000, daysSinceLastCovered: 57 }],
  topPerformers: [{ title: "12 Container Builds Habits Nobody Warns You About", views: 239_000 }],
  rewriteTarget: { title: "Kubernetes Operators Explained" },
  recommendedLengthMinutes: "12-18 minutes",
  targetTitleCharCount: "45-59 characters",
};

const ALLOWED = collectAllowedNumbers(BRIEFING);

/** Minimal StrategyReport wrapper so we can feed prose to the guard. */
function reportWith(fields: Partial<Record<"diagnosis" | "headline", string>>, checklist: string[] = []): StrategyReport {
  return {
    diagnosis: fields.diagnosis ?? "Nothing notable.",
    headline: fields.headline ?? "Nothing notable.",
    concepts: [],
    titleFormula: { formula: "", reasoning: "", rewriteBefore: "", rewriteAfter: "", targetCharCount: "" },
    lengthGuidance: { band: "", reasoning: "" },
    timingGuidance: { slot: "", reasoning: "", evidence: "day_and_hour" },
    thumbnailGuidance: null,
    avoid: [],
    nextUploadChecklist: checklist,
    generatedBy: "llm",
    modelNote: "",
  };
}

function testGuard() {
  section("A2. Guard accept / reject");

  const shouldPass: Array<[string, StrategyReport]> = [
    [
      "exact figures copied from the briefing",
      reportWith({ diagnosis: "13 videos on docker compose run +102% at a median of 137000 views." }),
    ],
    [
      "abbreviated views (137K for 137000)",
      reportWith({ diagnosis: "Docker compose videos hit a median of 137K views versus 79K channel-wide." }),
    ],
    [
      "millions abbreviated (3.8M style on a big number)",
      reportWith({ diagnosis: "Subscribers sit at 214K and the top video did 239K views." }),
    ],
    [
      "grouped thousands (Gemini's likely default)",
      reportWith({ diagnosis: "A median of 137,000 views against a channel median of 79,000." }),
    ],
    [
      "lift restated as a multiplier (+102% -> 2.0x)",
      reportWith({ diagnosis: "Docker compose runs about 2.0x the rest of the channel." }),
    ],
    [
      "negative lift with sign",
      reportWith({ diagnosis: "Kubernetes runs -61% across 6 videos, last covered 57 days ago." }),
    ],
    [
      "numbers quoted from a real video title",
      reportWith({ diagnosis: 'Your best performer is "12 Container Builds Habits Nobody Warns You About" at 239K views.' }),
    ],
    [
      "list positions and ranks",
      reportWith({}, ["1. Make concept 1.", "2. Then concept 2.", "3. Publish it."]),
    ],
    [
      "runtime target from the briefing",
      reportWith({}, ["Target 12-18 minutes of runtime.", "Keep the title to 45-59 characters."]),
    ],
    ["a calendar year", reportWith({ diagnosis: "This holds through 2026." })],
    ["decimal like rate", reportWith({ diagnosis: "The like rate is 4.35%." })],
    ["no numbers at all", reportWith({ diagnosis: "Packaging is the bottleneck, not subject matter." })],
  ];

  for (const [name, report] of shouldPass) {
    const r = verifyNumericClaims(report, ALLOWED);
    check(`accepts: ${name}`, r.ok, r.ok ? "" : r.violations.join(" | "));
  }

  console.log("");

  const shouldFail: Array<[string, StrategyReport]> = [
    [
      "invented view count",
      reportWith({ diagnosis: "Your docker videos average 450000 views." }),
    ],
    [
      "invented percentage",
      reportWith({ diagnosis: "Docker compose videos run +311% against the rest." }),
    ],
    [
      "derived arithmetic (137000 - 79000 = 58000)",
      reportWith({ diagnosis: "That is a gap of 58000 views per upload." }),
    ],
    [
      "invented subscriber count",
      reportWith({ headline: "With 512000 subscribers you should be doing better." }),
    ],
    [
      "invented figure in the checklist",
      reportWith({}, ["Aim for 620000 views on this one."]),
    ],
    [
      "plausible-but-absent day count",
      reportWith({ diagnosis: "You last covered kubernetes 143 days ago." }),
    ],
    [
      "invented abbreviated number",
      reportWith({ diagnosis: "Expect around 900K views." }),
    ],
    [
      "invented grouped-thousands number",
      reportWith({ diagnosis: "Expect around 512,000 views." }),
    ],
  ];

  for (const [name, report] of shouldFail) {
    const r = verifyNumericClaims(report, ALLOWED);
    check(`rejects: ${name}`, !r.ok, r.ok ? "GUARD MISSED IT" : r.violations[0]);
  }
}

// ===========================================================================
// PART A3 — the deterministic writer must always pass its own guard
// ===========================================================================

const NO_WS: WhitespaceReport = {
  attempted: false, ok: false, competitors: [], gaps: [], sharedTopics: [], quotaUnits: 0, note: null,
};
const NO_TH: ThumbnailReport = {
  attempted: false,
  ok: false,
  sampled: 0,
  traits: [],
  guidance: null,
  strength: "inconclusive",
  note: null,
};

/**
 * The timing recommendation's evidence grade must agree with its own prose.
 *
 * This exists because it did not. The grade was a boolean, the derivation had
 * three outcomes, and the middle one ("the day holds up, the hour does not") was
 * reported as `isHeuristic: false` while the reasoning beside it said the hour
 * was a general heuristic. Structured field and prose contradicted each other,
 * and nothing was checking for that.
 */
/**
 * The briefing must be byte-identical across repeated runs.
 *
 * The precomputed narration bundle is keyed on a hash of the briefing, so any
 * value that drifts between two runs on the same day invalidates it silently and
 * the demo channels stop being instant. This caught two real defects: a seed
 * timeline shift whose Math.round flipped by a whole week on a few minutes of
 * elapsed time, and video ages that ticked over at each video's own time of day.
 */
async function testBriefingDeterminism() {
  section("A3d. The briefing is deterministic within a day");

  for (const demo of DEMO_CHANNELS) {
    const build = async () => {
      const dataset = await collectChannelData(demo.slug, { preferSeed: true });
      const signals = analyzePatterns(dataset);
      const whitespace = await findWhitespace(dataset, signals, { seedSlugs: dataset.suggestedCompetitorSlugs });
      return { briefing: buildBriefing(signals, whitespace, NO_TH), n: signals.sampleSize };
    };

    const a = await build();
    await new Promise((r) => setTimeout(r, 1200));
    const b = await build();

    const same = JSON.stringify(a.briefing) === JSON.stringify(b.briefing);
    check(
      `${demo.title}: two builds 1.2s apart are identical (n=${a.n})`,
      same && a.n === b.n,
      same && a.n === b.n ? "" : `sample size ${a.n} -> ${b.n}; briefing drifted`,
    );
  }
}

async function testTimingEvidenceConsistency() {
  section("A3b. Timing evidence grade agrees with its own prose");

  for (const demo of DEMO_CHANNELS) {
    const dataset = await collectChannelData(demo.slug, { preferSeed: true });
    const signals = analyzePatterns(dataset);
    const report = writeStrategyDeterministic(signals, NO_WS, NO_TH);
    const { slot, reasoning, evidence } = report.timingGuidance;

    const text = `${slot} ${reasoning}`.toLowerCase();
    const claimsHeuristic = /heuristic|not enough uploads|too thinly|starting point/.test(text);

    // Every grade below "day_and_hour" must say so in the prose, and
    // "day_and_hour" must not disclaim itself.
    const consistent =
      evidence === "day_and_hour" ? !claimsHeuristic : claimsHeuristic;

    check(
      `${demo.title}: evidence "${evidence}" matches its prose`,
      consistent,
      consistent ? "" : `prose ${claimsHeuristic ? "claims" : "does not claim"} a heuristic`,
    );

    // The slot label must be the actionable slot only — caveats belong in the
    // evidence field, where they cannot be lost by reformatting.
    check(
      `${demo.title}: slot label carries no embedded caveat`,
      !/heuristic|supported|not from/i.test(slot),
      slot,
    );
  }
}

/**
 * Thumbnail guidance wording must match the strength of its evidence.
 *
 * This exists because it did not. A trait backed by 8 of 12 thumbnails at LOW
 * confidence was rendered as "— cut it.", a bare imperative indistinguishable in
 * tone from findings with real sample sizes behind them. Separately, the
 * headline trait was chosen by raw |lift| alone, so an n=3 noise spike outranked
 * an n=6 medium-confidence effect on a real channel.
 *
 * Runs on synthetic trait sets so it needs no API key and no images, and so the
 * edge cases can actually be constructed rather than waited for.
 */
const IMPERATIVES = /\b(cut it|lean into it|stop using|start using|remove|always|never)\b/i;
const HEDGES = /\b(worth testing|does not clear|not this channel's bottleneck|rather than treating|thin)\b/i;

function fakeTrait(
  key: string,
  n: number,
  lift: number,
  confidence: "high" | "medium" | "low",
): ThumbnailTraitSegment {
  return {
    id: `thumb:${key}`,
    trait: key,
    label: key === "high_contrast" ? "High colour contrast / bold saturated colours" : `label for ${key}`,
    videoCount: n,
    medianIndex: 1 + lift / 100,
    liftPct: lift,
    medianViews: 1000,
    confidence,
    pSuperiority: 0.5 + lift / 400,
    examples: [],
  };
}

function testThumbnailWording() {
  section("A3c. Thumbnail guidance is hedged to match its evidence");

  const cases: Array<{
    name: string;
    traits: ThumbnailTraitSegment[];
    expectStrength: GuidanceStrength;
    expectImperative: boolean;
  }> = [
    {
      name: "well-evidenced effect earns an imperative",
      traits: [fakeTrait("high_contrast", 6, -40, "medium")],
      expectStrength: "directive",
      expectImperative: true,
    },
    {
      // gradeConfidence awards "medium" from a cohort of 4, which is too thin to
      // instruct on. Observed on a real channel as "screenshot, n=4, +35%,
      // medium confidence — lean into it".
      name: "n=4 medium confidence is below the cohort floor for an imperative",
      traits: [fakeTrait("screenshot", 4, 35, "medium")],
      expectStrength: "tentative",
      expectImperative: false,
    },
    {
      // The exact Fireship case that prompted this.
      name: "n=8 low confidence must NOT read as an imperative",
      traits: [fakeTrait("high_contrast", 8, -54, "low")],
      expectStrength: "tentative",
      expectImperative: false,
    },
    {
      name: "small effect, low confidence is inconclusive",
      traits: [fakeTrait("face", 5, 6, "low")],
      expectStrength: "inconclusive",
      expectImperative: false,
    },
    {
      name: "no traits at all is inconclusive",
      traits: [],
      expectStrength: "inconclusive",
      expectImperative: false,
    },
  ];

  for (const c of cases) {
    const r = summariseTraits(c.traits, 16);
    const okStrength = r.strength === c.expectStrength;
    const hasImperative = IMPERATIVES.test(r.guidance);
    const okWording = hasImperative === c.expectImperative;
    const okHedge = c.expectImperative || HEDGES.test(r.guidance);

    check(
      c.name,
      okStrength && okWording && okHedge,
      okStrength && okWording && okHedge
        ? `strength=${r.strength}`
        : `strength=${r.strength} imperative=${hasImperative} hedged=${HEDGES.test(r.guidance)} :: ${r.guidance.slice(0, 90)}`,
    );
  }

  // Every trait must produce grammatical English, not just the ones whose label
  // happens to be clause-shaped. Three of five were broken: the sentence
  // "Thumbnails where <label> run ..." has no verb when the label is a noun
  // phrase, e.g. "Thumbnails where three or more competing focal points run".
  for (const key of ["face", "text_overlay", "high_contrast", "cluttered", "screenshot"]) {
    const r = summariseTraits([fakeTrait(key, 6, 40, "medium")], 16);
    const sentence = r.guidance;
    const clause = sentence.slice(sentence.indexOf("Thumbnails where") + 17, sentence.indexOf(" run "));
    // A clause needs a verb. Every trait phrasing here contains one of these.
    const hasVerb = /\b(is|are|there are|overlaid|visible)\b/.test(clause);
    check(
      `trait "${key}" reads as a sentence`,
      hasVerb && !/\bui\b/.test(sentence),
      hasVerb ? (/\bui\b/.test(sentence) ? "acronym lower-cased to 'ui'" : "") : `no verb in clause: "${clause}"`,
    );
  }

  // Ranking: the better-evidenced trait must win, not the loudest one.
  const ranked = summariseTraits(
    [fakeTrait("cluttered", 3, -62, "low"), fakeTrait("high_contrast", 6, -39, "medium")],
    16,
  );
  check(
    "an n=3 low-confidence spike does not outrank an n=6 medium-confidence effect",
    /contrast/i.test(ranked.guidance),
    ranked.guidance.slice(0, 100),
  );

  // The inconclusive branch must be reachable, since it was effectively dead
  // code when the bar was |lift| >= 15 with no confidence requirement.
  const inconclusive = summariseTraits(
    [fakeTrait("face", 6, 10, "low"), fakeTrait("text_overlay", 5, -12, "low")],
    16,
  );
  check(
    "the 'not your bottleneck' outcome is reachable",
    inconclusive.strength === "inconclusive" && /bottleneck/i.test(inconclusive.guidance),
    inconclusive.guidance.slice(0, 100),
  );
}

async function testDeterministicSelfConsistency() {
  section("A3. Deterministic writer passes its own guard (all demo channels)");

  for (const demo of DEMO_CHANNELS) {
    const dataset = await collectChannelData(demo.slug, { preferSeed: true });
    const signals = analyzePatterns(dataset);
    const whitespace = await findWhitespace(dataset, signals, { seedSlugs: dataset.suggestedCompetitorSlugs });

    const report = writeStrategyDeterministic(signals, whitespace, NO_TH);
    const allowed = collectAllowedNumbers(buildBriefing(signals, whitespace, NO_TH));
    const r = verifyNumericClaims(report, allowed);

    // This is a real invariant, not a formality: the deterministic writer and
    // the briefing are built from the same signals, so if the guard flags the
    // deterministic output then the guard and the briefing have drifted apart —
    // and the guard would be rejecting honest LLM output for the same reason.
    check(
      `${demo.title} (n=${signals.sampleSize})`,
      r.ok,
      r.ok ? "no violations" : r.violations.slice(0, 3).join(" | "),
    );
  }

  // Same check with whitespace disabled, since that changes which numbers exist.
  const dataset = await collectChannelData(DEMO_CHANNELS[0].slug, { preferSeed: true });
  const signals = analyzePatterns(dataset);
  const report = writeStrategyDeterministic(signals, NO_WS, NO_TH);
  const r = verifyNumericClaims(report, collectAllowedNumbers(buildBriefing(signals, NO_WS, NO_TH)));
  check("with no competitor data", r.ok, r.ok ? "no violations" : r.violations.slice(0, 3).join(" | "));
}

// ===========================================================================
// PART A4 — precomputed narrations must be re-verified, not trusted
// ===========================================================================

/**
 * The committed narrations in data/precomputed/ exist so the narrated report
 * survives a cold serverless instance, where the runtime cache cannot.
 *
 * That only stays honest if a drifted narration is REJECTED rather than served.
 * These assertions check the mechanism actually discriminates, instead of
 * waving anything through that happens to be on disk.
 */
async function testPrecomputed() {
  section("A4. Precomputed narrations are re-verified against current signals");

  if (precomputedCount() === 0) {
    console.log("  No precomputed narrations committed yet. Run `npm run bake`.");
    console.log("  Not a failure — the app falls back to the deterministic writer.");
    return;
  }

  const stale = staleSchemaCount();
  check(
    "no precomputed narration predates the current report shape",
    stale === 0,
    stale === 0 ? `${precomputedCount()} entries, all current` : `${stale} stale entr${stale === 1 ? "y" : "ies"} — re-run npm run bake`,
  );

  const briefings = new Map<string, { allowed: Set<number>; title: string }>();

  for (const demo of DEMO_CHANNELS) {
    const dataset = await collectChannelData(demo.slug, { preferSeed: true });
    const signals = analyzePatterns(dataset);
    const whitespace = await findWhitespace(dataset, signals, { seedSlugs: dataset.suggestedCompetitorSlugs });
    const allowed = collectAllowedNumbers(buildBriefing(signals, whitespace, NO_TH));
    briefings.set(signals.channel.channelId, { allowed, title: signals.channel.title });

    const baked = precomputedFor(signals.channel.channelId);
    if (!baked) {
      console.log(`  [ -- ] ${demo.title} — no precomputed narration (will call the model or fall back)`);
      continue;
    }

    // 1. Against its OWN channel it must still verify, or the bake is stale.
    const own = verifyNumericClaims(baked.report, allowed);
    check(
      `${demo.title}: precomputed narration still verifies`,
      own.ok,
      own.ok ? `baked ${baked.bakedAt.slice(0, 10)}` : `STALE — ${own.violations[0]} (re-run npm run bake)`,
    );
  }

  // 2. THE IMPORTANT ONE. A narration checked against a DIFFERENT channel's
  //    signals must be rejected. If this passes, the guard is not discriminating
  //    and "re-verified before serving" would be a hollow claim.
  const ids = [...briefings.keys()];
  for (const id of ids) {
    const baked = precomputedFor(id);
    if (!baked) continue;
    const otherId = ids.find((x) => x !== id);
    if (!otherId) continue;
    const other = briefings.get(otherId)!;

    const cross = verifyNumericClaims(baked.report, other.allowed);
    check(
      `${baked.channelTitle}'s narration is rejected against ${other.title}'s signals`,
      !cross.ok,
      cross.ok ? "GUARD FAILED TO DISCRIMINATE BETWEEN CHANNELS" : `${cross.violations.length} violations, correctly caught`,
    );
  }

  // 3. A drifted figure must invalidate it. Simulates the realistic decay case:
  //    elapsed days changing a "last covered N days ago" number.
  const firstId = ids.find((id) => precomputedFor(id));
  if (firstId) {
    const baked = precomputedFor(firstId)!;
    const drifted: StrategyReport = {
      ...baked.report,
      diagnosis: `${baked.report.diagnosis} You last covered this topic 9999 days ago.`,
    };
    const r = verifyNumericClaims(drifted, briefings.get(firstId)!.allowed);
    check(
      "a drifted figure invalidates a precomputed narration",
      !r.ok,
      r.ok ? "GUARD MISSED THE DRIFT" : r.violations[0],
    );
  }
}

// ===========================================================================
// PART B — real Gemini output
// ===========================================================================

async function testLive() {
  section(`B. Real ${PRIMARY_MODEL} output`);

  if (!hasLlmKey()) {
    console.log("  SKIPPED: GEMINI_API_KEY is not set.");
    console.log("  This suite is NOT complete without it. Set the key and re-run with --live.");
    failed += 1;
    return;
  }

  for (const demo of DEMO_CHANNELS) {
    const dataset = await collectChannelData(demo.slug, { preferSeed: true });
    const signals = analyzePatterns(dataset);
    const whitespace = await findWhitespace(dataset, signals, { seedSlugs: dataset.suggestedCompetitorSlugs });
    const briefing = buildBriefing(signals, whitespace, NO_TH);
    const allowed = collectAllowedNumbers(briefing);

    console.log(`\n  --- ${demo.title} ---`);
    const logs: string[] = [];
    // bypassCache is essential here. A cached narration would satisfy every
    // assertion below without a single model call, turning the live half of
    // this suite into a no-op that reports success.
    const report = await writeStrategy(signals, whitespace, NO_TH, {
      onLog: (m) => logs.push(m),
      bypassCache: true,
    });
    for (const l of logs) console.log(`      . ${l}`);

    // 1. Did it actually use the model?
    check(`${demo.title}: model produced the report`, report.generatedBy === "llm", report.modelNote.slice(0, 110));

    if (report.generatedBy !== "llm") continue;

    // 2. No false positives on genuine output.
    const r = verifyNumericClaims(report, allowed);
    check(
      `${demo.title}: real output passes the guard`,
      r.ok,
      r.ok ? "every figure traced to the briefing" : r.violations.slice(0, 4).join(" | "),
    );

    // 3. rewriteBefore must be a verbatim channel title.
    const isRealTitle = signals.scoredVideos.some((v) => v.title === report.titleFormula.rewriteBefore);
    check(`${demo.title}: rewriteBefore is a real video title`, isRealTitle, report.titleFormula.rewriteBefore);

    // 4. Timing must match what WE derived, not what the model preferred.
    //
    // The earlier version of this assertion was wrong: it treated thin
    // slot-level data as implying a heuristic recommendation. It does not —
    // when hour-level data is too thin but weekday-level data is solid, a
    // weekday-only recommendation is a genuine finding, not a heuristic.
    //
    // The real invariant is that the model cannot change the slot or clear the
    // heuristic flag. It tried: on a weekday-only channel it returned
    // "Thursday morning", inventing the hour we had explicitly said was
    // unsupported.
    const ours = writeStrategyDeterministic(signals, whitespace, NO_TH);
    check(
      `${demo.title}: slot label is ours, not the model's`,
      report.timingGuidance.slot === ours.timingGuidance.slot,
      report.timingGuidance.slot,
    );
    // The evidence grade must equal ours exactly.
    //
    // The previous version of this assertion was `!ours.isHeuristic ||
    // report.isHeuristic`, which is vacuously true whenever our own value is
    // false — i.e. it passed without checking anything on exactly the channels
    // where the flag was wrong. An assertion that cannot fail is worse than no
    // assertion, because it reads like coverage.
    check(
      `${demo.title}: timing evidence grade is ours, not the model's`,
      report.timingGuidance.evidence === ours.timingGuidance.evidence,
      `ours=${ours.timingGuidance.evidence} report=${report.timingGuidance.evidence}`,
    );

    // 5. THE IMPORTANT ONE. Corrupt the real output and confirm it is caught.
    //    Without this, "the guard passed" is unfalsifiable.
    const corrupted: StrategyReport = {
      ...report,
      diagnosis: `${report.diagnosis} The channel averages 4815162342 views per upload.`,
    };
    const c = verifyNumericClaims(corrupted, allowed);
    check(
      `${demo.title}: fabricated figure injected into real output IS caught`,
      !c.ok && c.violations.some((v) => v.includes("4815162342")),
      c.ok ? "GUARD MISSED THE INJECTED NUMBER" : c.violations[0],
    );

    // 6. A subtler corruption: a number derived from two real ones.
    const derived = Math.round(signals.medianViews * 1.37) + 7;
    const corrupted2: StrategyReport = {
      ...report,
      headline: `Your median should be ${derived} views.`,
    };
    const c2 = verifyNumericClaims(corrupted2, allowed);
    check(
      `${demo.title}: derived-but-unstated figure (${derived}) IS caught`,
      !c2.ok,
      c2.ok ? "GUARD MISSED A DERIVED NUMBER" : c2.violations[0],
    );

    console.log(`\n      headline: ${report.headline}`);
    console.log(`      concepts: ${report.concepts.map((x) => x.title).join(" | ")}`);
  }
}

// ===========================================================================

async function main() {
  console.log(`\nNumeric claim guard test suite  (model: ${PRIMARY_MODEL}, live: ${LIVE})`);

  testSchema();
  testParser();
  testGuard();
  await testDeterministicSelfConsistency();
  await testBriefingDeterminism();
  await testTimingEvidenceConsistency();
  testThumbnailWording();
  await testPrecomputed();
  if (LIVE) await testLive();
  else {
    section("B. Real Gemini output");
    console.log("  NOT RUN. Pass --live with GEMINI_API_KEY set to validate against the real model.");
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(78)}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
