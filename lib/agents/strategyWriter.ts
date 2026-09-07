/**
 * AGENT 4 — STRATEGY WRITER
 *
 * The ONLY agent in the pipeline that touches an LLM.
 *
 * ---------------------------------------------------------------------------
 * WHY THAT BOUNDARY MATTERS
 * ---------------------------------------------------------------------------
 * Everything upstream (collection, correlation, whitespace) is deterministic.
 * By the time we get here, every fact is already computed and carries its own
 * numbers. The LLM's job is narration and prioritisation, not arithmetic and
 * not recall. It is handed a compact JSON briefing of findings and told, in
 * effect: "you may only say things that are in this JSON".
 *
 * That is enforced, not merely requested:
 *
 *   1. Structured output — we demand a single JSON object matching a schema,
 *      and validate the shape before rendering anything.
 *   2. A NUMERIC CLAIM GUARD — every number the model wrote in prose is checked
 *      against the set of numbers it was actually given. Inventions trigger one
 *      corrective retry, then a hard fall back to the deterministic writer.
 *   3. A deterministic twin — writeStrategyDeterministic() produces the same
 *      report shape from the same signals with no LLM at all. It is the default
 *      when no API key is present, which means the app is fully functional for
 *      a grader with zero credentials.
 *
 * A hallucinated view count in a report a creator might act on is worse than no
 * report. This file is where that is prevented.
 */

import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";

import { TITLE_PATTERN_LABELS } from "./patternAnalyzer";
import { precomputedFor } from "@/data/precomputed";
import { cacheGet, cacheSet } from "@/lib/cache";
import {
  WEEKDAY_LABELS,
  formatCount,
  formatHourWindow,
  formatMultiple,
  formatPct,
} from "@/lib/stats";
import type {
  Finding,
  GapOpportunity,
  PatternSignals,
  Segment,
  StrategyReport,
  ThumbnailReport,
  TimingEvidence,
  TitlePatternId,
  TopicCluster,
  VideoConcept,
  WhitespaceReport,
} from "@/lib/types";

/**
 * Model candidates, in preference order. The first entry wins; the rest are
 * tried only when the API reports the model id itself as unavailable (a region
 * rollout, a retired id, a key without access to the newest model). A hackathon
 * demo should not die because a model id moved.
 */
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
].filter((m): m is string => Boolean(m));

export const PRIMARY_MODEL = MODEL_CANDIDATES[0];
/** Exported so the thumbnail agent can perform the same availability walk. */
export const GEMINI_MODEL_CANDIDATES: readonly string[] = MODEL_CANDIDATES;
export { isModelAvailabilityError };

export function hasLlmKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
}

/** FNV-1a. Only needs to be stable and collision-resistant enough for a cache key. */
function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + input.length.toString(36);
}

// ===========================================================================
// Shared derivations — used by BOTH writers so the LLM and the fallback can
// never disagree about which finding is the most important one.
// ===========================================================================

interface Levers {
  bestTitlePattern: Segment | null;
  worstTitlePattern: Segment | null;
  bestLength: Segment | null;
  worstLength: Segment | null;
  winningTopics: TopicCluster[];
  losingTopics: TopicCluster[];
  staleWinner: TopicCluster | null;
  slot: { label: string; evidence: TimingEvidence; reasoning: string };
  titleCharTarget: string;
  hiddenGems: PatternSignals["scoredVideos"];
  topGap: GapOpportunity | null;
}

/** Segments we are willing to build advice on. */
function actionable(seg: Segment | undefined, minLift = 10): Segment | null {
  if (!seg) return null;
  if (Math.abs(seg.liftPct) < minLift) return null;
  if (seg.confidence === "low" && Math.abs(seg.liftPct) < 30) return null;
  return seg;
}

function deriveLevers(signals: PatternSignals, whitespace: WhitespaceReport): Levers {
  const titlesByLift = [...signals.titlePatterns].sort((a, b) => b.liftPct - a.liftPct);
  const lengthsByLift = [...signals.lengthBuckets].sort((a, b) => b.liftPct - a.liftPct);

  const winningTopics = signals.topics
    .filter((t) => t.liftPct >= 15 && t.confidence !== "low")
    .sort((a, b) => b.liftPct - a.liftPct);
  const losingTopics = signals.topics
    .filter((t) => t.liftPct <= -15 && t.confidence !== "low")
    .sort((a, b) => a.liftPct - b.liftPct);

  // A topic that reliably out-performs but has not been touched in a while is
  // the cheapest video a creator can make: proven demand, no recent supply.
  const staleWinner =
    winningTopics.find((t) => (t.daysSinceLastCovered ?? 0) >= 45) ??
    signals.topics.find((t) => t.liftPct >= 20 && (t.daysSinceLastCovered ?? 0) >= 60) ??
    null;

  return {
    bestTitlePattern: actionable(titlesByLift[0]),
    worstTitlePattern: actionable(titlesByLift[titlesByLift.length - 1]),
    bestLength: actionable(lengthsByLift[0]),
    worstLength: actionable(lengthsByLift[lengthsByLift.length - 1]),
    winningTopics,
    losingTopics,
    staleWinner,
    slot: deriveSlot(signals),
    titleCharTarget: signals.titleLength.bestBand
      ? signals.titleLength.bestBand.label.toLowerCase()
      : `around ${signals.titleLength.channelMedianChars} characters`,
    hiddenGems: signals.scoredVideos
      .filter((v) => v.engagementPercentile >= 75 && v.performanceIndex < 0.9)
      .sort((a, b) => b.engagementPercentile - a.engagementPercentile),
    topGap: whitespace.gaps[0] ?? null,
  };
}

/**
 * Timing recommendation, with an explicit statement of how much of it is
 * actually evidenced.
 *
 * Three tiers, degrading gracefully:
 *   1. day_and_hour — a specific weekday + 3h window, both from this channel.
 *   2. day_only     — the weekday holds up, but there are too few uploads per
 *                     time-of-day slot to call an hour. The day is a finding;
 *                     the hour is a heuristic. BOTH halves are true at once,
 *                     which is why this returns its own state rather than being
 *                     squeezed into a boolean.
 *   3. heuristic    — the channel's data says nothing about timing. We say so
 *                     rather than dressing a guess up as a finding.
 *
 * The label carries the actionable slot ONLY. Caveats live in `evidence` so the
 * UI, the Markdown export and the CLI can each present them appropriately, and
 * so a caveat can never be silently dropped by a string that got reformatted.
 */
function deriveSlot(signals: PatternSignals): Levers["slot"] {
  const best = signals.timing.bestSlots.find((s) => s.confidence !== "low" && s.liftPct >= 15);
  if (best) {
    return {
      label: `${best.weekdayLabel}, ${formatHourWindow(best.hourStart)} ${signals.timezone.label}`,
      evidence: "day_and_hour",
      reasoning: `${best.videoCount} uploads landed in this window and ran a median ${formatPct(best.liftPct)} against every other slot on the channel. Times are ${signals.timezone.label}, inferred from ${signals.timezone.inferredFrom}.`,
    };
  }

  const days = signals.timing.weekdayTotals
    .filter((w) => w.videoCount >= 3)
    .sort((a, b) => b.liftPct - a.liftPct);
  if (days.length >= 2 && days[0].liftPct >= 15) {
    return {
      label: days[0].label,
      evidence: "day_only",
      reasoning: `${days[0].label} uploads (${days[0].videoCount} videos) run ${formatPct(days[0].liftPct)} against other days, so the day itself is a real finding. The hour is not: there are not enough uploads per time-of-day slot on this channel to separate one window from another. Pick a time you can keep to and hold it, so the hour becomes measurable over the next few uploads.`,
    };
  }

  return {
    label: "Tuesday-Thursday, early afternoon local time",
    evidence: "heuristic",
    reasoning: `This channel's ${signals.sampleSize} uploads are spread too thinly across the week to identify a winning slot from its own history — no day-and-hour window clears the confidence bar. Mid-week afternoons are a reasonable default because they catch both the end of the working day in the Americas and the evening in Europe, but treat this as a starting point to test, not a finding.`,
  };
}

// ===========================================================================
// Title construction (shared)
// ===========================================================================

const TITLE_CASE_SKIP = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "with", "at", "by", "vs"]);

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_CASE_SKIP.has(lower)) return lower;
      // Preserve deliberate casing like "TypeScript", "K8s", "10GbE".
      if (/[A-Z]/.test(w.slice(1))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Pull the substantive noun phrase out of an existing title so it can be
 * re-packaged. Strips the packaging, keeps the subject.
 */
export function extractCore(title: string): string {
  let t = title.trim();
  t = t.replace(/\s*[\[(][^\])]*[\])]\s*/g, " ");          // [brackets] and (parens)
  t = t.replace(/^\s*\d+\s+/, "");                            // leading count
  t = t.replace(/^(how\s+(?:to|i|we|you)\s+)/i, "");
  t = t.replace(/^(is|are|why|what|should|do|does|can|will|which)\s+/i, "");
  t = t.replace(/\bstill\s+worth\s+it\b.*$/i, "");
  t = t.replace(/\s+explained\b.*$/i, "");
  t = t.replace(/^(the\s+best\s+way\s+to\s+|the\s+best\s+)/i, "");
  t = t.replace(/^i\s+spent\s+a\s+month\s+learning\s+/i, "");
  t = t.replace(/:\s*.*$/, "");                               // keep the left of a colon
  t = t.replace(/\s*[-|–—]\s*.*$/, "");
  t = t.replace(/[?!.]+\s*$/, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || title.trim();
}

/**
 * Render a subject in a given proven title pattern.
 *
 * `variant` rotates between phrasings of the SAME structure. Three concepts all
 * coming back as "The Only X Setup You Need" is technically correct — they do
 * all use the winning pattern — but it reads like a broken template, which
 * undermines trust in everything else on the page.
 */
export function applyPattern(pattern: TitlePatternId, subject: string, variant = 0): string {
  const s = preserveCase(subject);
  const options: Record<TitlePatternId, string[]> = {
    number_led: [
      `7 ${s} Mistakes That Quietly Cost You Views`,
      `5 ${s} Decisions I'd Make Differently Now`,
      `9 ${s} Shortcuts Worth Stealing`,
    ],
    listicle: [
      `5 ${s} Tricks I Wish I Knew Sooner`,
      `6 ${s} Habits That Save Hours`,
      `4 ${s} Mistakes Almost Everyone Makes`,
    ],
    how_to: [
      `How to Get ${s} Right the First Time`,
      `How to Fix ${s} Without Starting Over`,
      `How to Set Up ${s} Properly in One Sitting`,
    ],
    question: [
      `Is ${s} Actually Worth It?`,
      `Why Does ${s} Keep Going Wrong?`,
      `Should You Still Bother With ${s}?`,
    ],
    superlative: [
      `The Only ${s} Setup You Need`,
      `The Best ${s} Workflow I've Found`,
      `Stop Doing ${s} the Hard Way`,
    ],
    colon_split: [
      `${s}: What I'd Do Differently`,
      `${s}: The Setup That Actually Held Up`,
      `${s}: Everything That Went Wrong First`,
    ],
    bracketed: [
      `${s} [Full Walkthrough]`,
      `${s} [Start to Finish]`,
      `${s} [Everything I Got Wrong]`,
    ],
    first_person: [
      `I Rebuilt My ${s} From Scratch`,
      `I Spent a Month Fixing My ${s}`,
      `I Was Wrong About ${s}`,
    ],
    plain_statement: [
      `${s} Done Properly`,
      `${s}, Without the Guesswork`,
      `The ${s} Setup I Actually Use`,
    ],
  };
  const list = options[pattern] ?? options.plain_statement;
  return list[variant % list.length];
}

/**
 * Topic keywords come out of the tokenizer lowercased, so building a title from
 * them yields "Typescript Generics" instead of "TypeScript Generics". Recover
 * the creator's own casing by finding the phrase in one of their real titles.
 */
function preserveCase(subject: string, sourceTitles: string[] = []): string {
  const needle = subject.toLowerCase();
  for (const title of sourceTitles) {
    const idx = title.toLowerCase().indexOf(needle);
    if (idx >= 0) return title.slice(idx, idx + subject.length);
  }
  return titleCase(subject);
}

/** Best display phrase for a topic: most specific keyword, in its real casing. */
function subjectFromTopic(topic: TopicCluster): string {
  const titles = topic.examples.map((e) => e.title);
  const bySpecificity = [...topic.keywords].sort(
    (a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length,
  );
  for (const kw of bySpecificity) {
    const cased = preserveCase(kw, titles);
    if (cased !== titleCase(kw)) return cased; // found it verbatim in a real title
  }
  return titleCase(bySpecificity[0] ?? topic.label);
}

/** Same idea for a competitor gap, using the competitor's real title. */
function subjectFromGap(gap: GapOpportunity): string {
  return preserveCase(gap.topic, [gap.exampleTitle]);
}

function patternIdOf(seg: Segment | null): TitlePatternId | null {
  if (!seg) return null;
  const id = seg.id.replace(/^title:/, "");
  return (id in TITLE_PATTERN_LABELS ? id : null) as TitlePatternId | null;
}

/** Describe the winning pattern as a reusable formula string. */
function formulaFor(pattern: TitlePatternId | null, charTarget: string): string {
  const base: Record<TitlePatternId, string> = {
    number_led: "[Number] + [specific subject] + [concrete stake or outcome]",
    listicle: "[Number] + [subject] + [Tips|Mistakes|Tricks] + [why it matters]",
    how_to: "How to [specific outcome] + [constraint that proves you understand the viewer]",
    question: "[Is|Should|Why] + [subject the viewer is already unsure about] + ?",
    superlative: "The [Only|Best] + [subject] + [setup|method] + You Need",
    colon_split: "[Subject]: [the angle or verdict]",
    bracketed: "[Subject] + [[format tag such as Full Walkthrough]]",
    first_person: "I + [did the hard thing] + [subject]",
    plain_statement: "[Subject] + [clear promise]",
  };
  const shape = pattern ? base[pattern] : "[Specific subject] + [concrete outcome the viewer wants]";
  return `${shape}, kept to ${charTarget}`;
}

// ===========================================================================
// DETERMINISTIC WRITER — no LLM, no network, no randomness.
// ===========================================================================

export function writeStrategyDeterministic(
  signals: PatternSignals,
  whitespace: WhitespaceReport,
  thumbnails: ThumbnailReport,
  modelNote = "Written by the deterministic strategy writer (no LLM). Every sentence is templated directly from the computed signals.",
): StrategyReport {
  const levers = deriveLevers(signals, whitespace);
  const top = signals.rankedFindings[0] ?? null;
  const bestPatternId = patternIdOf(levers.bestTitlePattern);

  // ---- diagnosis ---------------------------------------------------------
  const trendClause =
    signals.trend.direction === "improving"
      ? `views are trending up (age-adjusted median ${formatCount(signals.trend.recentMedianViews)} across the newest third of the window versus ${formatCount(signals.trend.earlierMedianViews)} across the oldest)`
      : signals.trend.direction === "declining"
        ? `views are sliding (age-adjusted median ${formatCount(signals.trend.recentMedianViews)} across the newest third versus ${formatCount(signals.trend.earlierMedianViews)} across the oldest)`
        : `views are broadly flat across the window`;

  const sentences: string[] = [];
  sentences.push(
    `Across the last ${signals.sampleSize} uploads (${signals.windowStart.slice(0, 10)} to ${signals.windowEnd.slice(0, 10)}), ${signals.channel.title} runs a median of ${formatCount(signals.medianViews)} views per video at a ${(signals.medianLikeRate * 100).toFixed(1)}% like rate, and ${trendClause}.`,
  );
  if (top) {
    sentences.push(`The strongest pattern in the data: ${lowerFirst(top.statement)}`);
  }
  const drag = signals.rankedFindings.find((f) => f.liftPct < -12);
  if (drag && drag.id !== top?.id) {
    sentences.push(`The clearest drag: ${lowerFirst(drag.statement)}`);
  } else if (levers.hiddenGems.length >= 2) {
    sentences.push(
      `${levers.hiddenGems.length} videos are in the channel's top engagement quartile while under-performing on reach, which points at packaging rather than subject matter.`,
    );
  }

  // ---- headline ----------------------------------------------------------
  const headline = buildHeadline(levers, signals);

  // ---- concepts ----------------------------------------------------------
  const concepts = buildConcepts(signals, whitespace, levers, bestPatternId);

  // ---- title formula + rewrite -------------------------------------------
  const rewriteTarget = pickRewriteTarget(signals, bestPatternId);
  const core = extractCore(rewriteTarget.title);
  const titleFormula = {
    formula: formulaFor(bestPatternId, levers.titleCharTarget),
    reasoning: levers.bestTitlePattern
      ? `${levers.bestTitlePattern.label} account for ${levers.bestTitlePattern.videoCount} of the last ${signals.sampleSize} uploads and run a median ${formatPct(levers.bestTitlePattern.liftPct)} against the rest of the channel, with ${Math.round(levers.bestTitlePattern.pSuperiority * 100)}% of head-to-head comparisons favouring them. Length matters too: ${signals.titleLength.bestBand ? `titles of ${signals.titleLength.bestBand.label.toLowerCase()} run ${formatPct(signals.titleLength.bestBand.liftPct)} against other lengths` : `the channel's median title is ${signals.titleLength.channelMedianChars} characters`}.`
      : `No title structure clears the confidence bar on this channel yet — ${signals.sampleSize} uploads is not enough to separate the styles. Until it is, optimise for specificity: name the subject and the outcome in the first 40 characters.`,
    rewriteBefore: rewriteTarget.title,
    rewriteAfter: bestPatternId
      ? applyPattern(bestPatternId, core)
      : `${titleCase(core)}: The Setup That Actually Worked`,
    targetCharCount: levers.titleCharTarget,
  };

  // ---- length ------------------------------------------------------------
  const lengthGuidance = levers.bestLength
    ? {
        band: levers.bestLength.label,
        reasoning: `${levers.bestLength.videoCount} uploads sit in this band and run ${formatPct(levers.bestLength.liftPct)} against every other length, with a median of ${formatCount(levers.bestLength.medianViews)} views.${levers.worstLength && levers.worstLength.liftPct < -10 ? ` The ${levers.worstLength.label.toLowerCase()} band is the weakest at ${formatPct(levers.worstLength.liftPct)} across ${levers.worstLength.videoCount} videos.` : ""}`,
      }
    : {
        band: "No clear winner yet — hold your current length",
        reasoning: `None of this channel's length bands separate from the others with enough evidence to call (${signals.sampleSize} uploads across ${signals.lengthBuckets.length} bands). Keep the format steady so the next 10 uploads produce a readable signal instead of resetting it.`,
      };

  // ---- avoid -------------------------------------------------------------
  const avoid: StrategyReport["avoid"] = [];
  if (levers.worstTitlePattern && levers.worstTitlePattern.liftPct <= -12) {
    avoid.push({
      what: `Stop defaulting to ${levers.worstTitlePattern.label.toLowerCase()}`,
      why: `${levers.worstTitlePattern.videoCount} of the last ${signals.sampleSize} uploads used them and they run ${formatPct(levers.worstTitlePattern.liftPct)} against the rest of the channel.`,
    });
  }
  if (levers.losingTopics[0]) {
    const t = levers.losingTopics[0];
    avoid.push({
      what: `Deprioritise "${t.label}"`,
      why: `${t.videoCount} videos on this topic run ${formatPct(t.liftPct)} against the channel's other topics, at a median of ${formatCount(t.medianViews)} views.`,
    });
  }
  if (levers.worstLength && levers.worstLength.liftPct <= -15) {
    avoid.push({
      what: `Stop making ${levers.worstLength.label.toLowerCase()} videos`,
      why: `${levers.worstLength.videoCount} of them run ${formatPct(levers.worstLength.liftPct)} against other lengths on this channel.`,
    });
  }
  if (signals.cadence.consistencyScore < 0.5 && signals.sampleSize >= 12) {
    avoid.push({
      what: "Stop letting the schedule drift",
      why: `Upload gaps swing widely (median ${signals.cadence.medianDaysBetweenUploads} days, longest ${signals.cadence.longestGapDays} days, consistency ${signals.cadence.consistencyScore}/1.00), which makes every other signal here harder to read.`,
    });
  }

  // ---- checklist ---------------------------------------------------------
  const nextUploadChecklist = buildChecklist(signals, levers, concepts, titleFormula, lengthGuidance, thumbnails);

  return {
    diagnosis: sentences.join(" "),
    headline,
    concepts,
    titleFormula,
    lengthGuidance,
    timingGuidance: {
      slot: levers.slot.label,
      reasoning: levers.slot.reasoning,
      evidence: levers.slot.evidence,
    },
    thumbnailGuidance: thumbnails.guidance,
    avoid: avoid.slice(0, 4),
    nextUploadChecklist,
    generatedBy: "deterministic",
    modelNote,
  };
}

/**
 * Lowercase the first letter so a finding can be spliced mid-sentence — unless
 * the sentence opens with a proper noun. Without the guard the diagnosis reads
 * "The clearest drag: thursday uploads run -35%...".
 */
function lowerFirst(s: string): string {
  const firstWord = s.split(/[\s,.]/)[0];
  if (WEEKDAY_LABELS.includes(firstWord)) return s;
  // Acronyms and CamelCase product names ("TypeScript", "K8s") must survive too.
  if (/[A-Z]/.test(firstWord.slice(1))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function buildHeadline(levers: Levers, signals: PatternSignals): string {
  if (levers.topGap) {
    return `Your next video should be about ${subjectFromGap(levers.topGap)} — proven in your niche at ${formatMultiple(levers.topGap.multipleOfOurMedian)} your median, and you have never covered it.`;
  }
  if (levers.staleWinner) {
    return `You have stopped making the videos that work: "${levers.staleWinner.label}" runs ${formatPct(levers.staleWinner.liftPct)} above your other topics and you last touched it ${levers.staleWinner.daysSinceLastCovered} days ago.`;
  }
  if (levers.winningTopics[0] && levers.bestLength) {
    return `Your reliable formula is ${lowerFirst(levers.winningTopics[0].label)} at ${levers.bestLength.label.toLowerCase()} — that combination is ${formatPct(levers.winningTopics[0].liftPct)} and ${formatPct(levers.bestLength.liftPct)} respectively, and you are not making enough of it.`;
  }
  if (levers.bestTitlePattern) {
    return `The biggest lever available to you is packaging: ${lowerFirst(levers.bestTitlePattern.label)} run ${formatPct(levers.bestTitlePattern.liftPct)} on your own channel.`;
  }
  return `With ${signals.sampleSize} uploads there is not yet a dominant pattern to exploit — the priority is making the next 10 uploads consistent enough to produce one.`;
}

function pickRewriteTarget(signals: PatternSignals, bestPatternId: TitlePatternId | null): { title: string } {
  // Prefer a recent under-performer that does NOT already use the winning
  // pattern — rewriting a title that is already optimal proves nothing.
  const recent = [...signals.scoredVideos].slice(0, Math.max(8, Math.floor(signals.sampleSize / 2)));
  const candidates = recent
    .filter((v) => !bestPatternId || !v.titlePatterns.includes(bestPatternId))
    .sort((a, b) => a.adjustedIndex - b.adjustedIndex);
  return candidates[0] ?? signals.underPerformers[0] ?? signals.scoredVideos[0];
}

function buildConcepts(
  signals: PatternSignals,
  whitespace: WhitespaceReport,
  levers: Levers,
  bestPatternId: TitlePatternId | null,
): VideoConcept[] {
  const concepts: VideoConcept[] = [];
  const lengthHint = levers.bestLength ? bandToMinutes(levers.bestLength.label) : "match your current format";

  // Each concept gets a different phrasing of the winning structure, so the
  // three recommendations do not read as one template repeated three times.
  const mkTitle = (subject: string) =>
    bestPatternId
      ? applyPattern(bestPatternId, subject, concepts.length)
      : [`${subject}: What Actually Works`, `How to Get ${subject} Right`, `${subject}, Done Properly`][
          concepts.length % 3
        ];

  // 1. Double down on the strongest proven vein.
  const vein = levers.winningTopics[0] ?? signals.topics[0];
  if (vein) {
    concepts.push({
      rank: concepts.length + 1,
      title: mkTitle(subjectFromTopic(vein)),
      rationale: `"${vein.label}" is this channel's strongest subject: ${vein.videoCount} videos on it run ${formatPct(vein.liftPct)} against the channel's other topics at a median of ${formatCount(vein.medianViews)} views, versus a channel median of ${formatCount(signals.medianViews)}. ${vein.daysSinceLastCovered !== null ? `Last covered ${vein.daysSinceLastCovered} days ago.` : ""}`.trim(),
      evidence: [
        `Topic "${vein.label}": ${formatPct(vein.liftPct)} vs other topics, n=${vein.videoCount}, ${vein.confidence} confidence`,
        levers.bestLength
          ? `Length ${levers.bestLength.label}: ${formatPct(levers.bestLength.liftPct)}, n=${levers.bestLength.videoCount}`
          : `Channel median views: ${formatCount(signals.medianViews)}`,
        vein.examples[0] ? `Best existing example: "${vein.examples[0].title}" at ${formatCount(vein.examples[0].views)} views` : "",
      ].filter(Boolean),
      suggestedLengthMinutes: lengthHint,
      format: levers.bestLength?.label ?? "your usual format",
      kind: "proven_vein",
    });
  }

  // 2. Competitor whitespace, when we have it.
  if (levers.topGap) {
    const gap = levers.topGap;
    concepts.push({
      rank: concepts.length + 1,
      title: mkTitle(subjectFromGap(gap)),
      rationale: `This is a gap, not a guess. ${gap.evidence} Their best performer in the topic is "${gap.exampleTitle}" at ${formatCount(gap.exampleViews)} views on ${gap.exampleChannel}.`,
      evidence: [
        `${gap.competitorVideoCount} competitor videos on "${gap.topic}", median ${formatCount(gap.competitorMedianViews)} views`,
        `${formatMultiple(gap.multipleOfOurMedian)} this channel's median of ${formatCount(signals.medianViews)}`,
        `Coverage on this channel: none in the last ${signals.sampleSize} uploads`,
      ],
      suggestedLengthMinutes: lengthHint,
      format: levers.bestLength?.label ?? "your usual format",
      kind: "whitespace",
    });
  }

  // 3. A proven topic gone stale, or a high-engagement/low-reach repackage.
  if (levers.staleWinner && levers.staleWinner.id !== vein?.id) {
    const t = levers.staleWinner;
    concepts.push({
      rank: concepts.length + 1,
      title: mkTitle(subjectFromTopic(t)),
      rationale: `Proven demand with no recent supply: "${t.label}" runs ${formatPct(t.liftPct)} against the channel's other topics across ${t.videoCount} videos, but the most recent one was ${t.daysSinceLastCovered} days ago. Returning to it is the lowest-risk upload available.`,
      evidence: [
        `Topic "${t.label}": ${formatPct(t.liftPct)}, n=${t.videoCount}, median ${formatCount(t.medianViews)} views`,
        `Last covered ${t.daysSinceLastCovered} days ago`,
      ],
      suggestedLengthMinutes: lengthHint,
      format: levers.bestLength?.label ?? "your usual format",
      kind: "underserved_topic",
    });
  } else if (levers.hiddenGems.length >= 1) {
    const gem = levers.hiddenGems[0];
    concepts.push({
      rank: concepts.length + 1,
      title: mkTitle(extractCore(gem.title)),
      rationale: `Remake this one. "${gem.title}" landed only ${formatCount(gem.views)} views (${gem.performanceIndex.toFixed(2)}x its neighbours) but sits in the channel's top engagement quartile at a ${(gem.likeRate * 100).toFixed(1)}% like rate against a channel median of ${(signals.medianLikeRate * 100).toFixed(1)}%. The people who found it loved it; almost nobody found it. That is a packaging failure, not a topic failure.`,
      evidence: [
        `"${gem.title}": ${formatCount(gem.views)} views, performance index ${gem.performanceIndex.toFixed(2)}`,
        `Like rate ${(gem.likeRate * 100).toFixed(1)}% vs channel median ${(signals.medianLikeRate * 100).toFixed(1)}%`,
        `Engagement percentile ${Math.round(gem.engagementPercentile)} of 100`,
      ],
      suggestedLengthMinutes: lengthHint,
      format: levers.bestLength?.label ?? "your usual format",
      kind: "underserved_topic",
    });
  } else if (levers.winningTopics[1]) {
    const t = levers.winningTopics[1];
    concepts.push({
      rank: concepts.length + 1,
      title: mkTitle(subjectFromTopic(t)),
      rationale: `Second-strongest subject on the channel: ${t.videoCount} videos on "${t.label}" run ${formatPct(t.liftPct)} against the other topics at a median of ${formatCount(t.medianViews)} views.`,
      evidence: [`Topic "${t.label}": ${formatPct(t.liftPct)}, n=${t.videoCount}, ${t.confidence} confidence`],
      suggestedLengthMinutes: lengthHint,
      format: levers.bestLength?.label ?? "your usual format",
      kind: "proven_vein",
    });
  }

  return concepts.slice(0, 3);
}

function bandToMinutes(label: string): string {
  if (/under 60s|shorts/i.test(label)) return "under 1 minute";
  if (/under 5/i.test(label)) return "3-5 minutes";
  if (/5-10/i.test(label)) return "6-9 minutes";
  if (/10-20/i.test(label)) return "12-18 minutes";
  if (/over 20/i.test(label)) return "22-30 minutes";
  return label;
}

function buildChecklist(
  signals: PatternSignals,
  levers: Levers,
  concepts: VideoConcept[],
  titleFormula: StrategyReport["titleFormula"],
  lengthGuidance: StrategyReport["lengthGuidance"],
  thumbnails: ThumbnailReport,
): string[] {
  const out: string[] = [];
  if (concepts[0]) out.push(`Make concept #1: "${concepts[0].title}".`);
  out.push(`Write the title to this shape: ${titleFormula.formula}.`);
  out.push(
    lengthGuidance.band.startsWith("No clear")
      ? `Keep the runtime consistent with your recent uploads so the next batch produces a readable length signal.`
      : `Target ${bandToMinutes(lengthGuidance.band)} of runtime — that is your ${lengthGuidance.band.toLowerCase()} band.`,
  );
  out.push(
    levers.slot.evidence === "heuristic"
      ? `Publish ${levers.slot.label} and keep that slot fixed for your next 6 uploads so it becomes measurable.`
      : levers.slot.evidence === "day_only"
        ? `Publish on ${levers.slot.label}, and pick one time of day and hold it for your next 6 uploads so the hour becomes measurable too.`
        : `Publish on ${levers.slot.label}.`,
  );
  // Only a directive belongs in a checklist. This list is a sequence of things
  // to go and do, so putting "no trait separates strongly enough to act on" or
  // "worth testing, the data is thin" in it would read as an instruction and
  // undo the hedging.
  if (thumbnails.guidance && thumbnails.strength === "directive") out.push(thumbnails.guidance);
  if (levers.worstTitlePattern && levers.worstTitlePattern.liftPct <= -12) {
    out.push(`Do not fall back to ${levers.worstTitlePattern.label.toLowerCase()} (${formatPct(levers.worstTitlePattern.liftPct)} on this channel).`);
  }
  out.push(
    `After publishing, check this video's views against the median of the 8 uploads around it (${formatCount(signals.medianViews)} channel-wide) rather than against your best-ever video.`,
  );
  return out.slice(0, 7);
}

// ===========================================================================
// LLM WRITER
// ===========================================================================

/** Compact, number-dense briefing. This is the LLM's entire world. */
export function buildBriefing(
  signals: PatternSignals,
  whitespace: WhitespaceReport,
  thumbnails: ThumbnailReport,
) {
  const levers = deriveLevers(signals, whitespace);
  const bestPatternId = patternIdOf(levers.bestTitlePattern);
  const rewriteTarget = pickRewriteTarget(signals, bestPatternId);

  return {
    channel: {
      title: signals.channel.title,
      subscribers: signals.channel.subscribers,
      sampleSize: signals.sampleSize,
      window: `${signals.windowStart.slice(0, 10)} to ${signals.windowEnd.slice(0, 10)}`,
      medianViews: Math.round(signals.medianViews),
      medianLikeRatePct: Number((signals.medianLikeRate * 100).toFixed(2)),
      medianCommentRatePct: Number((signals.medianCommentRate * 100).toFixed(3)),
      timezone: `${signals.timezone.label} (inferred from ${signals.timezone.inferredFrom})`,
      uploadsPerMonth: signals.cadence.uploadsPerMonth,
      medianDaysBetweenUploads: signals.cadence.medianDaysBetweenUploads,
      scheduleConsistency: signals.cadence.consistencyScore,
      trend: {
        direction: signals.trend.direction,
        changePct: Number(signals.trend.changePct.toFixed(1)),
        recentMedianViews: signals.trend.recentMedianViews,
        earlierMedianViews: signals.trend.earlierMedianViews,
        confidence: signals.trend.confidence,
      },
    },
    metricDefinition:
      "performanceIndex = a video's views divided by the median views of its 8-12 nearest neighbours by publish date. 1.0 means typical for this channel at that moment. It cancels out video age and channel growth. liftPct values compare a cohort's median index against the median index of every video outside that cohort, after dividing out the channel's video-length effect.",
    rankedFindings: signals.rankedFindings.slice(0, 12).map((f) => ({
      id: f.id,
      category: f.category,
      statement: f.statement,
      liftPct: f.liftPct,
      videoCount: f.videoCount,
      confidence: f.confidence,
    })),
    titlePatterns: signals.titlePatterns.map((s) => ({
      label: s.label,
      n: s.videoCount,
      liftPct: Number(s.liftPct.toFixed(1)),
      medianViews: Math.round(s.medianViews),
      pSuperiority: Number(s.pSuperiority.toFixed(2)),
      // The percentage form must be here too, not just the 0-1 probability.
      //
      // Both writers say "62% of head-to-head comparisons favour them", and 62 is
      // not a rendering of 0.62 under any rounding rule — so the guard was right
      // to reject it. It only ever passed because some unrelated figure in the
      // briefing happened to be 62; when the sample size shifted by one video
      // that coincidence disappeared and the deterministic writer started
      // failing its own guard. Any figure a writer states must exist here in the
      // form it is stated.
      pSuperiorityPct: Math.round(s.pSuperiority * 100),
      confidence: s.confidence,
    })),
    titleLength: {
      channelMedianChars: signals.titleLength.channelMedianChars,
      bestBand: signals.titleLength.bestBand
        ? {
            label: signals.titleLength.bestBand.label,
            liftPct: Number(signals.titleLength.bestBand.liftPct.toFixed(1)),
            n: signals.titleLength.bestBand.videoCount,
            confidence: signals.titleLength.bestBand.confidence,
          }
        : null,
    },
    lengthBuckets: signals.lengthBuckets.map((s) => ({
      label: s.label,
      n: s.videoCount,
      liftPct: Number(s.liftPct.toFixed(1)),
      medianViews: Math.round(s.medianViews),
      confidence: s.confidence,
    })),
    timing: {
      recommendedSlot: levers.slot.label,
      evidence: levers.slot.evidence,
      reasoning: levers.slot.reasoning,
      bestSlots: signals.timing.bestSlots.map((s) => ({
        slot: `${s.weekdayLabel} ${formatHourWindow(s.hourStart)}`,
        n: s.videoCount,
        liftPct: Number(s.liftPct.toFixed(1)),
        confidence: s.confidence,
      })),
      weekdays: signals.timing.weekdayTotals
        .filter((w) => w.videoCount > 0)
        .map((w) => ({ day: WEEKDAY_LABELS[w.weekday], n: w.videoCount, liftPct: Number(w.liftPct.toFixed(1)) })),
      dataThin: signals.timing.dataThin,
    },
    topics: signals.topics.map((t) => ({
      label: t.label,
      keywords: t.keywords,
      n: t.videoCount,
      liftPct: Number(t.liftPct.toFixed(1)),
      medianViews: Math.round(t.medianViews),
      daysSinceLastCovered: t.daysSinceLastCovered,
      confidence: t.confidence,
      bestExample: t.examples[0] ? { title: t.examples[0].title, views: t.examples[0].views } : null,
    })),
    topPerformers: signals.topPerformers.map((v) => ({
      title: v.title,
      views: v.views,
      performanceIndex: Number(v.performanceIndex.toFixed(2)),
      durationMinutes: Math.round(v.durationSeconds / 60),
    })),
    underPerformers: signals.underPerformers.map((v) => ({
      title: v.title,
      views: v.views,
      performanceIndex: Number(v.performanceIndex.toFixed(2)),
      durationMinutes: Math.round(v.durationSeconds / 60),
    })),
    highEngagementLowReach: levers.hiddenGems.slice(0, 3).map((v) => ({
      title: v.title,
      views: v.views,
      performanceIndex: Number(v.performanceIndex.toFixed(2)),
      likeRatePct: Number((v.likeRate * 100).toFixed(2)),
      engagementPercentile: Math.round(v.engagementPercentile),
    })),
    competitorWhitespace: whitespace.ok
      ? {
          competitors: whitespace.competitors.map((c) => ({
            title: c.title,
            subscribers: c.subscribers,
            medianViews: Math.round(c.medianViews),
            timesOurMedian: Number(c.viewRatio.toFixed(2)),
            sampleSize: c.sampleSize,
          })),
          gaps: whitespace.gaps.map((g) => ({
            topic: g.topic,
            evidence: g.evidence,
            competitorVideoCount: g.competitorVideoCount,
            competitorMedianViews: g.competitorMedianViews,
            timesOurMedian: g.multipleOfOurMedian,
            exampleTitle: g.exampleTitle,
            exampleViews: g.exampleViews,
            exampleChannel: g.exampleChannel,
            confidence: g.confidence,
          })),
          sharedTopics: whitespace.sharedTopics,
        }
      : { unavailable: whitespace.note ?? "Competitor scan did not run." },
    thumbnails: thumbnails.ok
      ? {
          sampled: thumbnails.sampled,
          traits: thumbnails.traits.map((t) => ({
            trait: t.label,
            n: t.videoCount,
            liftPct: Number(t.liftPct.toFixed(1)),
            confidence: t.confidence,
          })),
          guidance: thumbnails.guidance,
          strength: thumbnails.strength,
        }
      : { unavailable: thumbnails.note ?? "Thumbnail pass did not run." },
    rewriteTarget: {
      title: rewriteTarget.title,
      extractedSubject: extractCore(rewriteTarget.title),
      why: "A recent under-performer that does not already use the channel's best-performing title structure. Rewrite THIS title.",
    },
    suggestedFormulaShape: formulaFor(bestPatternId, levers.titleCharTarget),
    // These two exist so the numeric guard does not flag legitimate output.
    // The model will naturally write "target 12-18 minutes" and "45-59
    // characters"; putting the ranges in the briefing makes those figures
    // quotations rather than inventions. Widening the guard's blanket
    // allow-list instead would have weakened it against real fabrication.
    recommendedLengthMinutes: levers.bestLength
      ? bandToMinutes(levers.bestLength.label)
      : "match the channel's current format",
    targetTitleCharCount: levers.titleCharTarget,
  };
}

const SYSTEM_PROMPT = `You are the Strategy Writer stage of ChannelIQ, an analysis pipeline for YouTube creators.

You will receive a JSON briefing of statistics that have ALREADY been computed from a real channel's last N uploads. Your job is to turn those statistics into a specific, prioritised action plan for the creator's next video.

ABSOLUTE RULES — these are enforced by an automated checker downstream, and violations cause your output to be discarded:

1. NEVER state a number that is not present in the briefing. No invented view counts, percentages, subscriber counts, dates or multipliers. If you want to quantify something, copy the figure from the briefing.
2. NEVER claim a causal mechanism the data does not support. The briefing contains correlations. Write "videos in this band run X% better" not "viewers prefer this because...".
3. Respect the confidence field. For "low" confidence findings, hedge explicitly ("only 4 videos back this, so treat it as a test"). Never present a low-confidence finding as established.
4. Match your timing language to briefing.timing.evidence, which states exactly how much of the recommendation the data supports:
   - "day_and_hour": both the day and the time window come from this channel. State it as a finding.
   - "day_only": the DAY is a real finding, but the HOUR is a general heuristic because there are too few uploads per time-of-day slot. Say both halves. Do not present the hour as evidenced, and do not disclaim the day.
   - "heuristic": nothing about timing comes from this channel's data. Say so plainly and call it a starting point to test.
4b. Match your language to thumbnails.strength in exactly the same way:
   - "directive": the effect clears the confidence bar. An instruction is fine.
   - "tentative": a large effect that does NOT clear the bar. Frame it as something to test on the next few uploads, never as a rule. Do not write "cut it" or "lean into it".
   - "inconclusive": no visual trait separates enough to act on. Say that plainly; it is a real finding, not a gap to fill with advice.
4c. More generally: an imperative is only earned by evidence. If a finding is marked low confidence or is backed by a small cohort, hedge it explicitly and say how many videos back it. Never phrase a low-confidence correlation with the same certainty as a well-evidenced one.
5. Do not invent competitor names, video titles, or topics. Only use titles and channel names that appear in the briefing.
6. If competitorWhitespace is unavailable, do not speculate about competitors at all.

STYLE:
- Write to a working creator who is short on time. Direct, concrete, no hype, no exclamation marks.
- Every recommendation must be traceable to a figure in the briefing, and should name that figure inline.
- Be specific to THIS channel. A sentence that would be true of any YouTube channel is a failure. Never write generic advice like "post consistently" or "make good thumbnails" without a channel-specific number attached.
- Proposed titles must be plausible, publishable titles about subjects this channel actually covers — not placeholders with brackets.
- British or American spelling both fine. No emoji.

NUMBER FORMATTING (this is checked mechanically, so it matters):
- Write figures the way the briefing writes them. If the briefing says 3800000, you may write "3.8M". If it says 37.4, write "37%" or "37.4%".
- Do NOT compute new numbers from the ones you were given. No sums, no averages, no differences, no ratios you derived yourself. If the briefing does not contain the number, the number does not exist.
- Do not use thousands separators inside a figure you copied (write 3800 or 3.8K, not 3,800).

FIELD NOTES:
- rewriteBefore: copy rewriteTarget.title from the briefing EXACTLY, character for character. Do not tidy, retitle or paraphrase it.
- concepts: exactly 3 when the briefing supports it, ranked 1-3, most confident first.
- avoid: 2-4 items.
- nextUploadChecklist: 5-7 imperative, concrete steps.

- Proposed titles must be publishable titles about subjects this channel actually covers, not placeholders with square brackets.`;

/**
 * Response schema, enforced server-side by Gemini.
 *
 * This is a genuine upgrade over the previous provider integration, where the
 * JSON shape was requested in the prompt and could only be validated after the
 * fact. Here the model cannot return a malformed shape at all, which removes an
 * entire class of retry. The numeric guard still runs afterwards, because a
 * schema constrains STRUCTURE and has nothing to say about whether the numbers
 * inside the strings are real.
 */
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    diagnosis: {
      type: Type.STRING,
      description: "2-3 plain-English sentences: what works, what does not, the biggest lever. Cites specific figures.",
    },
    headline: { type: Type.STRING, description: "One sentence, the single most important change. Contains a figure." },
    concepts: {
      type: Type.ARRAY,
      minItems: "1",
      maxItems: "3",
      items: {
        type: Type.OBJECT,
        properties: {
          rank: { type: Type.INTEGER },
          title: { type: Type.STRING },
          rationale: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          suggestedLengthMinutes: { type: Type.STRING },
          format: { type: Type.STRING },
          kind: { type: Type.STRING, enum: ["proven_vein", "whitespace", "underserved_topic"] },
        },
        required: ["rank", "title", "rationale", "evidence", "suggestedLengthMinutes", "format", "kind"],
        propertyOrdering: ["rank", "title", "rationale", "evidence", "suggestedLengthMinutes", "format", "kind"],
      },
    },
    titleFormula: {
      type: Type.OBJECT,
      properties: {
        formula: { type: Type.STRING },
        reasoning: { type: Type.STRING },
        rewriteBefore: { type: Type.STRING },
        rewriteAfter: { type: Type.STRING },
        targetCharCount: { type: Type.STRING },
      },
      required: ["formula", "reasoning", "rewriteBefore", "rewriteAfter", "targetCharCount"],
      propertyOrdering: ["formula", "reasoning", "rewriteBefore", "rewriteAfter", "targetCharCount"],
    },
    lengthGuidance: {
      type: Type.OBJECT,
      properties: { band: { type: Type.STRING }, reasoning: { type: Type.STRING } },
      required: ["band", "reasoning"],
      propertyOrdering: ["band", "reasoning"],
    },
    timingGuidance: {
      type: Type.OBJECT,
      properties: {
        // No `slot` and no evidence grade: both are computed facts supplied by
        // ChannelIQ, so asking the model for them only creates an opportunity
        // to contradict the analysis. It writes the explanation, nothing else.
        reasoning: { type: Type.STRING },
      },
      required: ["reasoning"],
      propertyOrdering: ["reasoning"],
    },
    // thumbnailGuidance is intentionally absent: it is a computed, pre-hedged
    // sentence supplied by ChannelIQ, so there is nothing for the model to add.
    avoid: {
      type: Type.ARRAY,
      minItems: "1",
      maxItems: "4",
      items: {
        type: Type.OBJECT,
        properties: { what: { type: Type.STRING }, why: { type: Type.STRING } },
        required: ["what", "why"],
        propertyOrdering: ["what", "why"],
      },
    },
    nextUploadChecklist: { type: Type.ARRAY, items: { type: Type.STRING }, minItems: "3", maxItems: "7" },
  },
  required: [
    "diagnosis",
    "headline",
    "concepts",
    "titleFormula",
    "lengthGuidance",
    "timingGuidance",
    "avoid",
    "nextUploadChecklist",
  ],
  propertyOrdering: [
    "diagnosis",
    "headline",
    "concepts",
    "titleFormula",
    "lengthGuidance",
    "timingGuidance",
    "avoid",
    "nextUploadChecklist",
  ],
};

// ---------------------------------------------------------------------------
// The numeric claim guard
// ---------------------------------------------------------------------------

/**
 * Collect every number the model is allowed to say, by walking the briefing it
 * was given. Includes formatted variants, because the model will quite
 * reasonably write "137K" for 137248.
 */
/**
 * ONE number-extraction implementation, shared by the allow-list collector and
 * the verifier.
 *
 * This being a single function is load-bearing. When the two sides parsed
 * numbers differently, the guard produced false positives that depended on how
 * a given model happened to format its output — which is a bug that only
 * appears when you swap providers, and which looks exactly like the model
 * hallucinating. Same parser both sides, or the guard cannot be trusted.
 *
 * Handles: plain integers and decimals, grouped thousands (3,800,000),
 * K/M/B suffixes, percentages, and x-multipliers.
 */
export interface ExtractedNumber {
  /** Numeric value, with any suffix expanded. */
  value: number;
  /** The literal text matched, for error messages. */
  raw: string;
  /** Value BEFORE suffix expansion, e.g. 3.8 from "3.8M". */
  mantissa: number;
}

const NUMBER_RE = /(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(k|m|b|x|%)?/gi;

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [raw, digits, suffix] = m;
    // Grouped thousands only: "3,800" -> 3800. A lone "3,8" is not a group and
    // is left alone rather than guessed at as a European decimal.
    const normalised = /^\-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits) ? digits.replace(/,/g, "") : digits;
    const mantissa = Number(normalised);
    if (!Number.isFinite(mantissa)) continue;

    const multiplier =
      suffix?.toLowerCase() === "k" ? 1_000 : suffix?.toLowerCase() === "m" ? 1_000_000 : suffix?.toLowerCase() === "b" ? 1_000_000_000 : 1;

    out.push({ value: mantissa * multiplier, raw: raw.trim(), mantissa });
  }
  return out;
}

/**
 * Collect every number the model is allowed to say, by walking the briefing it
 * was given. Includes formatted variants, because the model will quite
 * reasonably write "137K" for 137248.
 */
/**
 * Every legitimate way a writer might render one number.
 *
 * This ENUMERATES renderings rather than accepting anything within a
 * percentage band of a real figure. That distinction is the guard's whole
 * accuracy story, and it was found the hard way.
 *
 * The original implementation accepted a value if it fell within 2% of any
 * allowed figure. With a briefing containing dozens of view counts, those bands
 * merge into near-continuous coverage of the number line, and a fabricated
 * figure only has to land near one of them. In live testing a number derived by
 * arithmetic from two real figures (9298) sailed through, because some unrelated
 * real figure happened to sit within 2% of it. A guard with that property gives
 * false assurance, which is worse than no guard.
 *
 * Enumeration is strict: 9298 is not a rounding of anything in the briefing, so
 * it is now caught, while "6.8K", "7K", "137,000" and "2x" all still pass
 * because each is genuinely a rendering of a real figure.
 */
function renderings(value: number): number[] {
  const out: number[] = [];
  const abs = Math.abs(value);
  if (!Number.isFinite(abs)) return out;

  const push = (x: number) => {
    if (Number.isFinite(x)) out.push(Number(x.toFixed(4)));
  };

  // Round, floor AND ceil at each precision.
  //
  // Floor and ceil are not paranoia — they absorb double-rounding. The briefing
  // may carry a like rate as 6.45 (already rounded to 2dp from 6.4487), while
  // prose elsewhere renders the raw value to 1dp as "6.4". Rounding 6.45 to 1dp
  // gives 6.5, so a round-only enumeration rejects "6.4" as fabricated. It is
  // not fabricated; it is the same number rounded once instead of twice.
  const atPrecision = (v: number, dp: number) => {
    const f = 10 ** dp;
    push(Number(v.toFixed(dp)));
    push(Math.floor(v * f) / f);
    push(Math.ceil(v * f) / f);
  };

  push(abs);
  for (const dp of [0, 1, 2]) atPrecision(abs, dp);

  // Abbreviated scales. Both the mantissa ("137" in "137K") and the expanded
  // rounding ("137,000") are legitimate, so both are enumerated.
  for (const scale of [1e3, 1e6, 1e9]) {
    if (abs < scale) break;
    const scaled = abs / scale;
    for (const dp of [0, 1, 2]) {
      const f = 10 ** dp;
      for (const m of [Number(scaled.toFixed(dp)), Math.floor(scaled * f) / f, Math.ceil(scaled * f) / f]) {
        push(m);
        push(m * scale);
      }
    }
  }

  // A lift of +102% is often restated as "2x" or "2.0x".
  push(Number((1 + abs / 100).toFixed(1)));
  push(Number((1 + abs / 100).toFixed(2)));
  push(Number((abs / 100).toFixed(1)));
  push(Number((abs / 100).toFixed(2)));

  return out;
}

/**
 * Collect every number the model is allowed to say, by walking the briefing it
 * was given, expanded into all legitimate renderings of each figure.
 */
/**
 * Assert the response schema is internally consistent.
 *
 * `propertyOrdering` and `required` are plain string arrays, so TypeScript
 * cannot tell when they name a property that no longer exists. Removing
 * `thumbnailGuidance` from `properties` while leaving it in `propertyOrdering`
 * produced an invalid schema that the API rejected with a bare 404 — an error
 * that looks exactly like "your model id is wrong" and sent me looking in
 * entirely the wrong place. Cheap to check, so it is checked.
 */
export function validateResponseSchema(schema: Schema = RESPONSE_SCHEMA): string[] {
  const problems: string[] = [];

  const walk = (node: Schema, path: string) => {
    if (node.type === Type.OBJECT) {
      const keys = Object.keys(node.properties ?? {});
      for (const name of node.propertyOrdering ?? []) {
        if (!keys.includes(name)) problems.push(`${path}.propertyOrdering names "${name}", which is not in properties`);
      }
      for (const name of node.required ?? []) {
        if (!keys.includes(name)) problems.push(`${path}.required names "${name}", which is not in properties`);
      }
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        walk(child as Schema, `${path}.${name}`);
      }
    }
    if (node.type === Type.ARRAY && node.items) walk(node.items as Schema, `${path}[]`);
  };

  walk(schema, "schema");
  return problems;
}

export function collectAllowedNumbers(briefing: unknown): Set<number> {
  const allowed = new Set<number>();

  const add = (n: number) => {
    for (const r of renderings(n)) allowed.add(r);
  };

  const walk = (node: unknown) => {
    if (typeof node === "number") return add(node);
    if (typeof node === "string") {
      // Numbers embedded in pre-computed evidence strings and in real video
      // titles are fair game — the model is quoting, not inventing.
      for (const n of extractNumbers(node)) {
        add(n.value);
        add(n.mantissa);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") return Object.values(node).forEach(walk);
  };

  walk(briefing);

  // Structural numbers that are never factual claims about the channel:
  // list positions, ranks, small counts, and calendar years.
  for (let i = 1; i <= 12; i++) allowed.add(i);
  for (let y = 2020; y <= 2035; y++) allowed.add(y);
  // Title-length band boundaries, which the model quotes as character targets.
  for (const n of [15, 20, 29, 30, 44, 45, 59, 60, 74, 75, 90, 100]) allowed.add(n);

  return allowed;
}

/**
 * Membership test. Exact, against the enumerated renderings — no tolerance
 * band. See the note on renderings() for why a band was actively harmful.
 */
function isAllowed(value: number, allowed: Set<number>): boolean {
  return allowed.has(Number(Math.abs(value).toFixed(4)));
}

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

/** Check every number in the model's prose against the allowed set. */
export function verifyNumericClaims(report: StrategyReport, allowed: Set<number>): GuardResult {
  const violations: string[] = [];

  const texts: Array<[string, string]> = [
    ["diagnosis", report.diagnosis],
    ["headline", report.headline],
    ["titleFormula.reasoning", report.titleFormula?.reasoning ?? ""],
    ["lengthGuidance.reasoning", report.lengthGuidance?.reasoning ?? ""],
    ["timingGuidance.reasoning", report.timingGuidance?.reasoning ?? ""],
    ["thumbnailGuidance", report.thumbnailGuidance ?? ""],
  ];
  report.concepts?.forEach((c, i) => {
    texts.push([`concepts[${i}].rationale`, c.rationale]);
    (c.evidence ?? []).forEach((e, j) => texts.push([`concepts[${i}].evidence[${j}]`, e]));
  });
  report.avoid?.forEach((a, i) => texts.push([`avoid[${i}].why`, a.why]));
  report.nextUploadChecklist?.forEach((s, i) => texts.push([`nextUploadChecklist[${i}]`, s]));

  for (const [field, text] of texts) {
    if (!text) continue;
    for (const n of extractNumbers(text)) {
      // Accept either reading: "3.8M" is fine if the briefing contains 3800000
      // (expanded) or 3.8 (the mantissa, e.g. from a ratio).
      if (isAllowed(n.value, allowed) || isAllowed(n.mantissa, allowed)) continue;
      violations.push(`${field}: "${n.raw}" is not a figure from the briefing`);
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** Coerce whatever the model returned into a StrategyReport, or fail loudly. */
function validateShape(parsed: unknown, fallback: StrategyReport): StrategyReport {
  if (!parsed || typeof parsed !== "object") throw new Error("model did not return a JSON object");
  const p = parsed as Record<string, any>;

  const diagnosis = str(p.diagnosis);
  const headline = str(p.headline);
  if (!diagnosis || !headline) throw new Error("model output is missing diagnosis or headline");

  const rawConcepts = Array.isArray(p.concepts) ? p.concepts : [];
  const concepts: VideoConcept[] = rawConcepts
    .map((c: Record<string, any>, i: number): VideoConcept => ({
      rank: typeof c?.rank === "number" ? c.rank : i + 1,
      title: str(c?.title),
      rationale: str(c?.rationale),
      evidence: Array.isArray(c?.evidence) ? c.evidence.map((e: unknown) => str(e)).filter(Boolean) : [],
      suggestedLengthMinutes: str(c?.suggestedLengthMinutes, fallback.concepts[0]?.suggestedLengthMinutes ?? ""),
      format: str(c?.format, fallback.concepts[0]?.format ?? ""),
      kind: ["proven_vein", "whitespace", "underserved_topic"].includes(c?.kind) ? c.kind : "proven_vein",
    }))
    .filter((c) => c.title && c.rationale);

  if (concepts.length === 0) throw new Error("model output contained no usable video concepts");

  const tf = p.titleFormula ?? {};
  const lg = p.lengthGuidance ?? {};
  const tg = p.timingGuidance ?? {};

  return {
    diagnosis,
    headline,
    concepts: concepts.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1 })),
    titleFormula: {
      formula: str(tf.formula, fallback.titleFormula.formula),
      reasoning: str(tf.reasoning, fallback.titleFormula.reasoning),
      // The "before" must be a real title from this channel. If the model
      // paraphrased it, use ours — a fabricated "before" makes the whole
      // rewrite demo worthless.
      rewriteBefore: fallback.titleFormula.rewriteBefore,
      rewriteAfter: str(tf.rewriteAfter, fallback.titleFormula.rewriteAfter),
      targetCharCount: str(tf.targetCharCount, fallback.titleFormula.targetCharCount),
    },
    lengthGuidance: {
      band: str(lg.band, fallback.lengthGuidance.band),
      reasoning: str(lg.reasoning, fallback.lengthGuidance.reasoning),
    },
    timingGuidance: {
      // Both the slot label and the evidence grade are COMPUTED facts, not
      // prose, so both come from our own derivation and neither is accepted
      // from the model. The model only contributes `reasoning`.
      //
      // Live output showed why the label had to be pinned: on a channel where
      // the data supports a weekday but explicitly does NOT support an hour, the
      // model returned "Thursday morning", inventing a time of day.
      //
      // The evidence grade had the same problem one level down. It used to be
      // `fallback.isHeuristic || tg.isHeuristic === true`, which let the model
      // move the flag whenever our own value was false — so two channels in the
      // identical situation got different flags depending on what the model felt
      // like returning. Reading it from the model at all was the bug.
      slot: fallback.timingGuidance.slot,
      reasoning: str(tg.reasoning, fallback.timingGuidance.reasoning),
      evidence: fallback.timingGuidance.evidence,
    },
    // Pinned to ours, never taken from the model.
    //
    // The thumbnail sentence is already hedged to match the strength of the
    // evidence behind it (see ThumbnailReport.strength). Accepting the model's
    // rewrite reopened the exact laundering path that was closed for the timing
    // slot: a "worth testing, the data is thin" finding could come back as a
    // flat instruction, with no way to tell from the output that it had been
    // hardened.
    thumbnailGuidance: fallback.thumbnailGuidance,
    avoid: Array.isArray(p.avoid)
      ? p.avoid
          .map((a: Record<string, any>) => ({ what: str(a?.what), why: str(a?.why) }))
          .filter((a: { what: string; why: string }) => a.what && a.why)
          .slice(0, 4)
      : fallback.avoid,
    nextUploadChecklist: Array.isArray(p.nextUploadChecklist)
      ? p.nextUploadChecklist.map((s: unknown) => str(s)).filter(Boolean).slice(0, 7)
      : fallback.nextUploadChecklist,
    generatedBy: "llm",
    modelNote: "",
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Recover the outermost object if the model wrapped it in commentary.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("model output was not parseable JSON");
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface WriteOptions {
  onLog?: (message: string) => void;
  /** Force the deterministic writer even if a key is present. */
  disableLlm?: boolean;
  /**
   * Skip the narration cache and force a real model call.
   *
   * Used by the guard test suite: a cached report would make the live assertions
   * pass without ever exercising fresh model output, which would quietly turn
   * the most important test in the project into a no-op.
   */
  bypassCache?: boolean;
}

export async function writeStrategy(
  signals: PatternSignals,
  whitespace: WhitespaceReport,
  thumbnails: ThumbnailReport,
  options: WriteOptions = {},
): Promise<StrategyReport> {
  const log = options.onLog ?? (() => {});

  // The deterministic report is built FIRST, always. It is the fallback for
  // every failure path below, and it supplies defaults for any field the model
  // omits, so there is no code path that can render a partial report.
  const baseline = writeStrategyDeterministic(signals, whitespace, thumbnails);

  // disableLlm is an explicit instruction to use the deterministic writer, so it
  // short-circuits everything — including the precomputed tier, which would
  // otherwise return LLM prose to a caller that asked not to have any.
  if (options.disableLlm) {
    log("LLM narration disabled for this run — using the deterministic strategy writer.");
    return {
      ...baseline,
      modelNote:
        "Generated without an LLM by request. The analysis is identical either way; only the prose differs.",
    };
  }

  let noKey = false;
  if (!hasLlmKey()) {
    noKey = true;
  }

  const briefing = buildBriefing(signals, whitespace, thumbnails);
  const allowed = collectAllowedNumbers(briefing);
  const briefingHash = hashString(JSON.stringify(briefing));

  /*
   * TIER 1 — a committed, precomputed narration.
   *
   * Checked first, and deliberately checked BEFORE the API-key gate, because
   * this tier is neither a network call nor a cache: it is data compiled into
   * the bundle. That makes it the only tier that survives a cold serverless
   * instance, and it also means a deployment with NO Gemini key still serves the
   * narrated report for the demo channels rather than templated prose.
   *
   * Safety comes from re-verification, not from trust. See
   * data/precomputed/index.ts for the full reasoning.
   */
  if (!options.bypassCache) {
    const baked = precomputedFor(signals.channel.channelId);
    if (baked) {
      if (baked.briefingHash === briefingHash) {
        log("Using the precomputed narration for this channel (inputs unchanged, no API call).");
        return baked.report;
      }
      // Inputs have drifted — usually just elapsed days moving the "last
      // covered N days ago" figures. Re-verify rather than assume.
      const recheck = verifyNumericClaims(baked.report, allowed);
      if (recheck.ok) {
        log(
          `Reusing the precomputed narration: its figures still check out against today's signals. ` +
            `(briefing ${briefingHash} vs baked ${baked.briefingHash})`,
        );
        return {
          ...baked.report,
          modelNote: `${baked.report.modelNote} It was precomputed on ${baked.bakedAt.slice(0, 10)} and every figure was re-verified against the current analysis before being shown.`,
        };
      }
      log(
        `Discarded the precomputed narration — ${recheck.violations.length} figure(s) no longer match the current analysis.`,
      );
    }
  }

  // No key, and no usable precomputed narration: the deterministic writer is
  // the answer, and it is a complete one.
  if (noKey) {
    log("No GEMINI_API_KEY set — using the deterministic strategy writer.");
    return {
      ...baseline,
      modelNote:
        "Generated without an LLM. ChannelIQ's deterministic writer templates the report directly from the computed signals, so the analysis is identical — only the prose is less fluent. Set GEMINI_API_KEY for the narrated version.",
    };
  }

  /*
   * TIER 2 — the runtime cache.
   *
   * Reliable locally (one long-lived process, persistent .cache/ directory),
   * opportunistic in production (per-instance memory, ephemeral /tmp). Worth
   * having either way: it saves quota on repeat runs within a warm instance and
   * makes local development fast. It is just not something to depend on.
   *
   * Keying on the briefing hash rather than the channel name is what makes it
   * safe: if any computed figure changes the hash changes and the model is
   * called again, so a stale report is not a possible outcome.
   */
  const cacheKey = `llm:strategy:${PRIMARY_MODEL}:${briefingHash}`;
  const cachedReport = options.bypassCache ? null : cacheGet<StrategyReport>(cacheKey);
  if (cachedReport) {
    log("Reusing a cached narration for an identical briefing (no API call).");
    return cachedReport;
  }

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

  // Gemini takes a flat contents array; a correction turn is appended as a
  // further user message after the model's own reply, same as a chat history.
  const contents: GeminiTurn[] = [
    {
      role: "user",
      parts: [
        {
          text: `Here is the computed briefing for this channel. Write the strategy report.\n\n${JSON.stringify(briefing, null, 1)}`,
        },
      ],
    },
  ];

  let lastError = "";

  // Up to 2 attempts: the second one is a targeted correction, not a blind retry.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log(attempt === 1 ? `Writing strategy with ${PRIMARY_MODEL}...` : "Correcting unverifiable figures...");
      const { text, model: usedModel } = await callModel(client, contents);
      if (usedModel !== PRIMARY_MODEL) {
        log(`${PRIMARY_MODEL} was unavailable; used ${usedModel} instead.`);
      }
      const report = validateShape(extractJson(text), baseline);
      const guard = verifyNumericClaims(report, allowed);

      if (guard.ok) {
        log(`Strategy written and all figures verified against the computed signals.`);
        const verified: StrategyReport = {
          ...report,
          // Names the model that ACTUALLY produced this, not the configured
          // default — the candidate walk means those can differ.
          modelNote: `Narrated by ${usedModel} from ${briefing.rankedFindings.length} pre-computed findings. Every figure in this report was checked against the analysis output before rendering.`,
        };
        // Only ever cache a report that passed the guard.
        cacheSet(cacheKey, verified, 24 * 60 * 60 * 1000);
        return verified;
      }

      log(`Numeric guard rejected ${guard.violations.length} figure(s); asking for a correction.`);
      if (attempt === 2) {
        lastError = `numeric guard failed twice: ${guard.violations.slice(0, 3).join("; ")}`;
        break;
      }
      contents.push({ role: "model", parts: [{ text }] });
      contents.push({
        role: "user",
        parts: [
          {
            text:
              `Your output contained figures that do not appear in the briefing:\n` +
              guard.violations.map((v) => `- ${v}`).join("\n") +
              `\n\nRewrite the complete report. Every number must be copied from the briefing rather than derived from it. If you cannot support a claim with a briefing figure, remove the claim rather than estimating.`,
          },
        ],
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`Strategy writer attempt ${attempt} failed: ${lastError}`);
      if (attempt === 2) break;
      // A malformed-output failure is worth one retry; an auth failure is not.
      if (/api key|authentication|401|403/i.test(lastError)) break;
    }
  }

  log("Falling back to the deterministic strategy writer.");
  return {
    ...baseline,
    modelNote: `The LLM narration step did not run (${humaniseError(lastError || "unknown error")}), so ChannelIQ fell back to its deterministic writer. The underlying analysis is unchanged — only the prose differs.`,
  };
}

interface GeminiTurn {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/**
 * True when walking to the next candidate model could plausibly help.
 *
 * Covers two distinct cases:
 *
 *  - The model id is unusable by this key (retired, not rolled out, no access).
 *
 *  - Rate limit / quota exhaustion. This one is not obvious but matters a lot:
 *    the Gemini free tier meters requests PER MODEL PER DAY
 *    (`GenerateRequestsPerDayPerProjectPerModel`, 20/day), so a 429 on
 *    gemini-3.6-flash says nothing about gemini-3.5-flash's budget. Walking the
 *    candidate list therefore multiplies the free-tier allowance by the number
 *    of candidates instead of falling straight back to templated prose. This
 *    was found by exhausting the real quota during testing.
 */
function isModelAvailabilityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /NOT_FOUND|is not found|not supported|does not exist|unsupported model|404/i.test(msg) ||
    isQuotaError(err) ||
    isTransientError(err)
  );
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /RESOURCE_EXHAUSTED|429|exceeded your current quota|rate limit/i.test(msg);
}

/**
 * Transient server-side conditions: worth retrying the same model shortly, and
 * worth trying a different one if it persists. Gemini returns 503 with "high
 * demand" reasonably often on popular models, and falling straight through to
 * templated prose over a blip would be a poor trade during a live demo.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNAVAILABLE|503|high demand|overloaded|INTERNAL|500|deadline|ETIMEDOUT|ECONNRESET/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provider errors arrive as a wall of JSON. That is fine in a log and wrong in
 * a report footer, so collapse the common ones to a sentence.
 */
function humaniseError(message: string): string {
  if (/RESOURCE_EXHAUSTED|429|exceeded your current quota/i.test(message)) {
    return "the Gemini API daily free-tier request quota is exhausted for every configured model";
  }
  if (/UNAVAILABLE|503|high demand|overloaded/i.test(message)) {
    return "every configured Gemini model is temporarily overloaded";
  }
  if (/INTERNAL|500/i.test(message)) return "the Gemini API returned a server error";
  if (/API key|401|403|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
    return "the Gemini API key was rejected";
  }
  if (/token ceiling|MAX_TOKENS/i.test(message)) return "the model returned a truncated response";
  if (/parseable JSON|Expected/i.test(message)) return "the model returned malformed JSON";
  if (/numeric guard/i.test(message)) return message;
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/** Try the configured model, then known-good fallbacks if it is unavailable. */
async function callModel(
  client: GoogleGenAI,
  contents: GeminiTurn[],
): Promise<{ text: string; model: string }> {
  let lastErr: unknown;

  for (const model of MODEL_CANDIDATES) {
    // Two attempts per model for transient conditions before moving on. A 503
    // "high demand" is usually over in a second or two, and burning the whole
    // candidate list on a blip would leave a demo on templated prose for no
    // reason. Quota errors are NOT retried here — they need a different model,
    // not a second attempt at the same one.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.4,
          // Generous ceiling. On Gemini 3.x, reasoning tokens are drawn from the
          // SAME budget as the visible output, so a ceiling sized for the report
          // alone gets consumed by thinking and the JSON is truncated
          // mid-array. That surfaced as a bare "Expected ',' or ']'" parse error
          // on two of three test channels — a confusing symptom for a simple
          // cause, which is why the truncation check below is explicit.
          maxOutputTokens: 16384,
          // This is narration of findings that are already computed and already
          // ranked. It does not need deep deliberation, and extended thinking
          // here mostly buys latency and truncation risk.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          // Server-enforced JSON. Removes malformed-shape failures entirely.
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      const finishReason = String(res.candidates?.[0]?.finishReason ?? "");
      const text = res.text ?? "";

      // Truncation must be named, not left to surface as a JSON syntax error.
      if (/MAX_TOKENS/i.test(finishReason)) {
        throw new Error(
          `${model} hit the output token ceiling and returned truncated JSON. Raise maxOutputTokens or lower thinkingLevel.`,
        );
      }
      if (!text.trim()) {
        // An empty body with a non-STOP finish reason is usually a safety block,
        // and is worth surfacing rather than retrying blind.
        throw new Error(`empty response from ${model} (finishReason: ${finishReason || "unknown"})`);
      }
        return { text, model };
      } catch (err) {
        lastErr = err;
        // Auth errors and bad requests fail identically on every candidate, so
        // there is nothing to gain from retrying or walking.
        if (!isModelAvailabilityError(err)) throw err;
        if (isTransientError(err) && attempt === 1) {
          await sleep(1500);
          continue;
        }
        break; // move to the next candidate model
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("no usable Gemini model");
}
