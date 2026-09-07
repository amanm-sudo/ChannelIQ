/**
 * ChannelIQ — shared contracts between agents.
 *
 * The whole pipeline is a chain of pure-ish transforms over these types:
 *
 *   ChannelDataset  -> (Pattern Analysis)  -> PatternSignals
 *   PatternSignals   -> (Whitespace)        -> WhitespaceReport
 *   both             -> (Strategy Writer)   -> StrategyReport
 *
 * Keeping the contracts in one file means the Strategy Writer Agent can be
 * handed a *typed, computed* payload — never a raw API dump. That is the
 * single most important design decision in this codebase: the LLM narrates
 * numbers, it never invents them.
 */

// ---------------------------------------------------------------------------
// Layer 1: raw-ish data (Data Collector Agent output)
// ---------------------------------------------------------------------------

export interface VideoRecord {
  id: string;
  title: string;
  description: string;
  /** ISO-8601 UTC */
  publishedAt: string;
  durationSeconds: number;
  views: number;
  likes: number;
  comments: number;
  thumbnailUrl: string;
  tags: string[];
}

export interface ChannelRecord {
  channelId: string;
  handle: string | null;
  title: string;
  description: string;
  subscribers: number;
  /** Lifetime views across the channel. 0 if the channel hides them. */
  totalViews: number;
  videoCount: number;
  thumbnailUrl: string;
  publishedAt: string;
  /** ISO 3166-1 alpha-2, when the channel declares one. Used for timezone. */
  country: string | null;
}

export type DataSource = "live" | "cache" | "seed";

export interface ChannelDataset {
  channel: ChannelRecord;
  /** Newest first. */
  videos: VideoRecord[];
  source: DataSource;
  fetchedAt: string;
  /** Rough YouTube Data API quota units burned producing this dataset. */
  quotaUnits: number;
  /** Non-fatal problems worth surfacing in the UI. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Layer 2: computed signals (Pattern Analysis Agent output) — no LLM involved
// ---------------------------------------------------------------------------

/** How much evidence sits behind a claim. Drives hedging language downstream. */
export type Confidence = "high" | "medium" | "low";

export interface ScoredVideo extends VideoRecord {
  /**
   * Views relative to the channel's local baseline at the time of publishing
   * (1.0 == exactly typical). See patternAnalyzer.ts for why this is a
   * rolling-neighbour median rather than a raw view count.
   */
  performanceIndex: number;
  /**
   * performanceIndex with the channel's own video-length effect divided out.
   * Used for every non-length comparison (titles, topics, timing) so that a
   * channel whose long videos happen to be its Docker videos does not get told
   * "Docker wins" when the real driver was runtime. See patternAnalyzer.ts.
   */
  adjustedIndex: number;
  /** Baseline the index was measured against, in absolute views. */
  baselineViews: number;
  ageDays: number;
  likeRate: number;
  commentRate: number;
  /** Composite engagement percentile within this channel's own sample, 0-100. */
  engagementPercentile: number;
  titlePatterns: TitlePatternId[];
  lengthBucket: LengthBucketId;
  /** Local weekday 0-6 (Sun-Sat) using the channel's inferred timezone. */
  localWeekday: number;
  localHour: number;
}

export type TitlePatternId =
  | "question"
  | "how_to"
  | "number_led"
  | "listicle"
  | "bracketed"
  | "colon_split"
  | "superlative"
  | "first_person"
  | "plain_statement";

export type LengthBucketId = "short_form" | "under_5" | "5_to_10" | "10_to_20" | "over_20";

/** A generic "cohort of videos vs the rest" comparison. */
export interface Segment {
  id: string;
  label: string;
  videoCount: number;
  /** Median performanceIndex inside the cohort. */
  medianIndex: number;
  /** Percentage lift vs the median of every *other* video. e.g. +43 => 43% better. */
  liftPct: number;
  medianViews: number;
  confidence: Confidence;
  /**
   * Probability that a random video in this cohort beats a random video outside
   * it (0.5 = no effect). Rank-based, so a single viral outlier cannot fake it.
   */
  pSuperiority: number;
  /** Up to 2 real titles from this cohort, for the report to quote. */
  examples: Array<{ title: string; views: number; performanceIndex: number }>;
}

export interface TimingSlot {
  weekday: number;
  weekdayLabel: string;
  /** Bucketed 3-hour window start, local time. */
  hourStart: number;
  videoCount: number;
  medianIndex: number;
  liftPct: number;
  confidence: Confidence;
  medianViews: number;
}

export interface TopicCluster {
  id: string;
  /** Human label, e.g. "docker + compose". */
  label: string;
  keywords: string[];
  videoCount: number;
  medianIndex: number;
  liftPct: number;
  medianViews: number;
  confidence: Confidence;
  pSuperiority: number;
  lastCoveredAt: string | null;
  daysSinceLastCovered: number | null;
  examples: Array<{ title: string; views: number; performanceIndex: number }>;
}

export interface ChannelTrend {
  /** Median index of the newest third vs the oldest third of the sample. */
  direction: "improving" | "declining" | "flat";
  recentMedianViews: number;
  earlierMedianViews: number;
  changePct: number;
  confidence: Confidence;
}

export interface CadenceStats {
  medianDaysBetweenUploads: number;
  uploadsPerMonth: number;
  /** 0-1, higher = more regular schedule. 1 - (IQR / median gap). */
  consistencyScore: number;
  longestGapDays: number;
}

export interface PatternSignals {
  channel: ChannelRecord;
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
  /** Timezone used for all weekday/hour maths, plus how we picked it. */
  timezone: { label: string; utcOffsetHours: number; inferredFrom: string };
  medianViews: number;
  medianLikeRate: number;
  medianCommentRate: number;
  scoredVideos: ScoredVideo[];
  topPerformers: ScoredVideo[];
  underPerformers: ScoredVideo[];
  titlePatterns: Segment[];
  titleLength: {
    /** Best-performing character-count band. */
    bestBand: Segment | null;
    bands: Segment[];
    channelMedianChars: number;
  };
  lengthBuckets: Segment[];
  timing: {
    bestSlots: TimingSlot[];
    worstSlots: TimingSlot[];
    weekdayTotals: Array<{
      weekday: number;
      label: string;
      videoCount: number;
      medianIndex: number;
      liftPct: number;
    }>;
    /** True when the channel posts on too few distinct slots to conclude much. */
    dataThin: boolean;
  };
  topics: TopicCluster[];
  trend: ChannelTrend;
  cadence: CadenceStats;
  /** Every notable finding, pre-ranked by |liftPct| * evidence weight. */
  rankedFindings: Finding[];
  warnings: string[];
}

/**
 * A Finding is the atomic unit passed to the LLM. Each one is fully
 * self-describing and carries its own numbers so the writer can cite them
 * without needing to recompute anything.
 */
export interface Finding {
  id: string;
  category: "title" | "length" | "timing" | "topic" | "engagement" | "cadence" | "trend" | "thumbnail" | "whitespace";
  /** Terse, factual, already contains the numbers. */
  statement: string;
  liftPct: number;
  videoCount: number;
  confidence: Confidence;
  /** Internal ranking score; not shown to users. */
  weight: number;
}

// ---------------------------------------------------------------------------
// Layer 3: competitor whitespace (P1)
// ---------------------------------------------------------------------------

export interface CompetitorSummary {
  channelId: string;
  title: string;
  handle: string | null;
  subscribers: number;
  thumbnailUrl: string;
  sampleSize: number;
  medianViews: number;
  /** Competitor median views divided by ours. >1 means they out-draw us. */
  viewRatio: number;
}

export interface GapOpportunity {
  id: string;
  topic: string;
  keywords: string[];
  /** Which competitors are winning here. */
  competitorTitles: string[];
  competitorVideoCount: number;
  competitorMedianViews: number;
  /** How many times bigger their median is than our channel median. */
  multipleOfOurMedian: number;
  /** Best real competitor title in the topic, for the report to reference. */
  exampleTitle: string;
  exampleViews: number;
  exampleChannel: string;
  /** One line the report can print verbatim. Fully number-backed. */
  evidence: string;
  confidence: Confidence;
}

export interface WhitespaceReport {
  attempted: boolean;
  ok: boolean;
  competitors: CompetitorSummary[];
  gaps: GapOpportunity[];
  /** Topics both sides cover — useful context, shows we're not just guessing. */
  sharedTopics: string[];
  quotaUnits: number;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Layer 3b: thumbnail signals (P1)
// ---------------------------------------------------------------------------

export interface ThumbnailTraitSegment extends Segment {
  trait: string;
}

/**
 * How strongly the thumbnail guidance may be worded.
 *
 * Exists for the same reason `TimingEvidence` does: prose was being written at a
 * fixed level of certainty regardless of the evidence under it. A trait backed
 * by 8 of 12 thumbnails at low confidence was rendered as a bare imperative
 * ("cut it") — identical in tone to findings with real sample sizes behind them.
 *
 *   directive     — clears the confidence bar; safe to phrase as an instruction
 *   tentative     — a large effect that does NOT clear the bar; phrase as a test
 *   inconclusive  — nothing separates enough to act on, which is itself useful
 */
export type GuidanceStrength = "directive" | "tentative" | "inconclusive";

export interface ThumbnailReport {
  attempted: boolean;
  ok: boolean;
  sampled: number;
  traits: ThumbnailTraitSegment[];
  /**
   * One sentence of guidance, number-backed and already hedged to match
   * `strength`. Non-null whenever `ok` is true, including the inconclusive case.
   */
  guidance: string | null;
  /** Governs how the guidance is allowed to be worded. */
  strength: GuidanceStrength;
  /** Operational problems only (skips, failures, partial downloads). */
  note: string | null;
}

// ---------------------------------------------------------------------------
// Layer 4: the deliverable (Strategy Writer Agent output)
// ---------------------------------------------------------------------------

export interface VideoConcept {
  rank: number;
  title: string;
  /** Why this, for this channel, right now. Must cite channel numbers. */
  rationale: string;
  /** Which computed signal(s) back it. */
  evidence: string[];
  suggestedLengthMinutes: string;
  format: string;
  /** "proven_vein" = double down on what works. "whitespace" = competitor gap. */
  kind: "proven_vein" | "whitespace" | "underserved_topic";
}

export interface TitleFormula {
  formula: string;
  reasoning: string;
  /** Rewrite of one of the channel's own recent titles using the formula. */
  rewriteBefore: string;
  rewriteAfter: string;
  targetCharCount: string;
}

/**
 * How much of the timing recommendation actually came from the channel's data.
 *
 * This is three states rather than a boolean on purpose. It was a boolean
 * (`isHeuristic`) and that was a modelling error: the derivation has always had
 * three outcomes, and the middle one — the weekday is supported by the data but
 * there are too few uploads per time-of-day slot to call an hour — cannot be
 * expressed as either "is a heuristic" or "is not". Forced into `false`, the
 * flag directly contradicted the prose beside it, which said the hour was a
 * general heuristic. Forced into `true`, a real weekday finding would have been
 * disclaimed away.
 *
 *   day_and_hour — both the day and the 3-hour window are from this channel
 *   day_only     — the day is from this channel; the hour is a general heuristic
 *   heuristic    — neither is; the whole recommendation is a starting point
 */
export type TimingEvidence = "day_and_hour" | "day_only" | "heuristic";

export interface TimingGuidance {
  /** The actionable slot only. Caveats belong in `evidence`, not in this string. */
  slot: string;
  reasoning: string;
  evidence: TimingEvidence;
}

export interface StrategyReport {
  /** 2-3 plain-English sentences. The only thing many users will read. */
  diagnosis: string;
  /** A single punchy line: the one thing to change. */
  headline: string;
  concepts: VideoConcept[];
  titleFormula: TitleFormula;
  lengthGuidance: { band: string; reasoning: string };
  timingGuidance: TimingGuidance;
  thumbnailGuidance: string | null;
  /** Things the channel should stop doing, with evidence. */
  avoid: Array<{ what: string; why: string }>;
  /** Ordered checklist for the next upload. */
  nextUploadChecklist: string[];
  generatedBy: "llm" | "deterministic";
  modelNote: string;
}

// ---------------------------------------------------------------------------
// The full artifact the UI renders
// ---------------------------------------------------------------------------

export interface ChannelIQReport {
  version: string;
  generatedAt: string;
  dataset: {
    channel: ChannelRecord;
    source: DataSource;
    fetchedAt: string;
    sampleSize: number;
    windowStart: string;
    windowEnd: string;
    quotaUnits: number;
  };
  signals: PatternSignals;
  whitespace: WhitespaceReport;
  thumbnails: ThumbnailReport;
  strategy: StrategyReport;
  warnings: string[];
  timings: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pipeline streaming events (UI shows the architecture as it runs)
// ---------------------------------------------------------------------------

export type PipelineStageId =
  | "collect"
  | "analyze"
  | "whitespace"
  | "thumbnails"
  | "write"
  | "done";

export type PipelineEvent =
  | { type: "stage"; stage: PipelineStageId; status: "start" | "ok" | "skipped" | "failed"; detail: string; ms?: number }
  | { type: "log"; message: string }
  | { type: "report"; report: ChannelIQReport }
  | { type: "error"; message: string; recoverable: boolean };
