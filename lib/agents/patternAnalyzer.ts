/**
 * AGENT 2 — PATTERN ANALYSIS
 *
 * Pure computation. No LLM, no network, no randomness. Given a ChannelDataset
 * it produces PatternSignals: a ranked set of number-backed findings about what
 * correlates with performance on *this specific channel*.
 *
 * This is the agent that makes ChannelIQ more than a chart wrapper. Everything
 * the user eventually reads is traceable to a number computed in this file.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL PROBLEM: raw view counts are not comparable
 * ---------------------------------------------------------------------------
 * A video published 400 days ago has had 100x longer to accumulate views than
 * one published 4 days ago. At the same time the channel itself was smaller
 * back then. Those two biases point in opposite directions, and naively
 * correlating "views" against "title style" mostly measures *when* a video was
 * published rather than anything about the video.
 *
 * Fix: score every video against a LOCAL baseline — the median views of its
 * nearest neighbours in publication order (excluding itself). Because
 * neighbours share roughly the same age and roughly the same channel size,
 * dividing by that baseline cancels both biases at once.
 *
 *   performanceIndex = views / median(views of k nearest-in-time neighbours)
 *
 * Chosen over fitting a global views~age regression because:
 *   - it needs no functional form for the view curve (which differs per niche),
 *   - it is robust to outliers (median, not mean),
 *   - it automatically tracks channel growth instead of assuming it away,
 *   - it behaves sanely at n=20, where a regression would be over-fit.
 *
 * The cost is that it cannot detect a *global* trend (by construction the index
 * averages to ~1.0 over time), which is why the trend metric below is computed
 * separately from raw view medians.
 */

import {
  CONFIDENCE_WEIGHT,
  WEEKDAY_LABELS,
  clamp,
  formatCount,
  formatHourWindow,
  formatPct,
  gradeConfidence,
  liftPct,
  median,
  percentiles,
  probabilityOfSuperiority,
  quantile,
} from "@/lib/stats";
import type {
  CadenceStats,
  ChannelDataset,
  ChannelTrend,
  Confidence,
  Finding,
  LengthBucketId,
  PatternSignals,
  ScoredVideo,
  Segment,
  TimingSlot,
  TitlePatternId,
  TopicCluster,
  VideoRecord,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Timezone inference
// ---------------------------------------------------------------------------

/**
 * Representative UTC offsets for the countries that dominate YouTube.
 * Approximate on purpose — we only bucket into 3-hour windows, so being an
 * hour out from DST does not change any conclusion. Reported to the user with
 * its provenance so nobody mistakes it for the channel's real timezone.
 */
const COUNTRY_UTC_OFFSET: Record<string, number> = {
  US: -6, CA: -5, MX: -6, BR: -3, AR: -3, CL: -4, CO: -5, PE: -5,
  GB: 0, IE: 0, PT: 0, ES: 1, FR: 1, DE: 1, IT: 1, NL: 1, BE: 1, CH: 1,
  AT: 1, SE: 1, NO: 1, DK: 1, PL: 1, CZ: 1, HU: 1, RO: 2, GR: 2, FI: 2,
  UA: 2, TR: 3, RU: 3, SA: 3, AE: 4, PK: 5, IN: 5.5, BD: 6, TH: 7, VN: 7,
  ID: 7, MY: 8, SG: 8, PH: 8, CN: 8, HK: 8, TW: 8, KR: 9, JP: 9,
  AU: 10, NZ: 12, ZA: 2, NG: 1, KE: 3, EG: 2, IL: 2,
};

interface TimezoneInfo {
  label: string;
  utcOffsetHours: number;
  inferredFrom: string;
}

function inferTimezone(dataset: ChannelDataset): TimezoneInfo {
  const country = dataset.channel.country;
  if (country && country in COUNTRY_UTC_OFFSET) {
    const offset = COUNTRY_UTC_OFFSET[country];
    return {
      label: `UTC${offset >= 0 ? "+" : ""}${offset}`,
      utcOffsetHours: offset,
      inferredFrom: `the channel's declared country (${country})`,
    };
  }

  // No declared country. Creators overwhelmingly schedule uploads during their
  // own waking hours, so the modal upload hour is a usable proxy: assume the
  // busiest publishing hour corresponds to a mid-morning local slot (10am).
  const hours = dataset.videos.map((v) => new Date(v.publishedAt).getUTCHours());
  if (hours.length >= 8) {
    const counts = new Array(24).fill(0) as number[];
    for (const h of hours) counts[h] += 1;
    // Smooth over a 3-hour window so a single upload cannot pick the mode.
    let bestHour = 0;
    let bestScore = -1;
    for (let h = 0; h < 24; h++) {
      const score = counts[h] + counts[(h + 1) % 24] + counts[(h + 23) % 24];
      if (score > bestScore) {
        bestScore = score;
        bestHour = h;
      }
    }
    const offset = ((10 - bestHour + 12 + 24) % 24) - 12; // nearest offset in -11..12
    return {
      label: `UTC${offset >= 0 ? "+" : ""}${offset}`,
      utcOffsetHours: offset,
      inferredFrom: "the channel's most common publishing hour (no country is declared)",
    };
  }

  return { label: "UTC", utcOffsetHours: 0, inferredFrom: "UTC (no country or reliable upload pattern available)" };
}

function localParts(iso: string, offsetHours: number): { weekday: number; hour: number } {
  const shifted = new Date(Date.parse(iso) + offsetHours * 3_600_000);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

// ---------------------------------------------------------------------------
// Title pattern detection
// ---------------------------------------------------------------------------

export const TITLE_PATTERN_LABELS: Record<TitlePatternId, string> = {
  question: "Question titles",
  how_to: '"How to" titles',
  number_led: "Number-led titles",
  listicle: "Listicle titles",
  bracketed: "Titles with [brackets] or (parens)",
  colon_split: "Colon-split titles",
  superlative: "Superlative / definitive titles",
  first_person: "First-person titles",
  plain_statement: "Plain statement titles",
};

/**
 * A title can match several patterns at once (e.g. "7 Docker Mistakes (2026)"
 * is number-led, a listicle AND bracketed). We deliberately do NOT force a
 * single label: overlapping cohorts are fine because each is compared against
 * its own complement, and forcing exclusivity would hide real effects.
 */
export function detectTitlePatterns(title: string): TitlePatternId[] {
  const t = title.trim();
  const out: TitlePatternId[] = [];

  if (/\?\s*$/.test(t) || /^(is|are|why|what|how|should|do|does|can|will|which|who|when)\b.*\?/i.test(t)) {
    out.push("question");
  }
  if (/^how\s+(to|i|we|you)\b/i.test(t) || /\bhow\s+to\b/i.test(t)) out.push("how_to");
  if (/^\s*\d+\b/.test(t)) out.push("number_led");
  if (/\b\d+\s+[\w-]+(\s+[\w-]+)?\s*(mistakes|ways|tips|tricks|things|reasons|tools|habits|shortcuts|lessons|steps|rules|myths)\b/i.test(t)) {
    out.push("listicle");
  }
  if (/\[[^\]]+\]|\([^)]+\)/.test(t)) out.push("bracketed");
  if (/\S\s*[:|｜|]\s*\S/.test(t) && !/^\s*https?:/.test(t)) out.push("colon_split");
  if (/\b(best|worst|ultimate|fastest|only|never|always|stop|must|definitive|perfect|complete)\b/i.test(t)) {
    out.push("superlative");
  }
  if (/^(i|i'm|i've|my|we|we're|our)\b/i.test(t)) out.push("first_person");

  if (out.length === 0) out.push("plain_statement");
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Length buckets
// ---------------------------------------------------------------------------

export const LENGTH_BUCKETS: Array<{ id: LengthBucketId; label: string; min: number; max: number }> = [
  { id: "short_form", label: "Shorts (under 60s)", min: 0, max: 60 },
  { id: "under_5", label: "Under 5 min", min: 61, max: 300 },
  { id: "5_to_10", label: "5-10 min", min: 301, max: 600 },
  { id: "10_to_20", label: "10-20 min", min: 601, max: 1200 },
  { id: "over_20", label: "Over 20 min", min: 1201, max: Number.POSITIVE_INFINITY },
];

export function lengthBucketOf(seconds: number): LengthBucketId {
  for (const b of LENGTH_BUCKETS) if (seconds >= b.min && seconds <= b.max) return b.id;
  return "over_20";
}

// ---------------------------------------------------------------------------
// Title length bands
// ---------------------------------------------------------------------------

const TITLE_LENGTH_BANDS: Array<{ id: string; label: string; min: number; max: number }> = [
  { id: "t_very_short", label: "Under 30 characters", min: 0, max: 29 },
  { id: "t_short", label: "30-44 characters", min: 30, max: 44 },
  { id: "t_medium", label: "45-59 characters", min: 45, max: 59 },
  { id: "t_long", label: "60-74 characters", min: 60, max: 74 },
  { id: "t_very_long", label: "75+ characters", min: 75, max: Number.POSITIVE_INFINITY },
];

// ---------------------------------------------------------------------------
// Keyword / topic extraction
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those with without for from into onto out up down over under again
   more most some such only own same so too very can will just should now i me my we our you your it its he she they them
   what which who whom when where why how all any both each few other as at by of on in to is are was were be been being
   do does did doing have has had having not no nor s t don should ve ll re m d o y about after before during through
   above below between out off here there once new best top guide tutorial video ep episode part full watch subscribe
   explained explaining worth matter matters sooner nobody warns warned stealing steal wish knew properly correctly
   easy easier hard harder simple simply real truth honest review reviewed update updated versus deep dive walkthrough
   beginners beginner advanced complete definitive ultimate everyone anyone someone probably almost quick quickly
   channel like comment please make made makes making get got getting use using used need needs try trying want know
   things thing way ways tips tip actually really vs versus every everything something anything nothing much many really
   good great better bad worse first last next also still even ever never always today year years time times day days
   minute minutes hour hours week weeks month months lot lots bit little big small stop start why what let lets going go
   goes went come comes came take takes took give gives gave put puts see sees saw look looks looked
   shorts short reel reels livestream stream vlog vlogs podcast series subscribe subscribing sponsor sponsored
   sponsorship merch patreon giveaway discord newsletter affiliate link links coupon promo unboxing collab
   collaboration youtube tiktok instagram twitter announcement recap reaction react
   expensive cheap cheapest free huge tiny massive giant weird crazy craziest insane wild secret hidden perfect
   broken fake biggest smallest fastest slowest scary boring amazing awesome terrible finally already literally
   basically apparently honestly surprisingly` 
    .split(/\s+/)
    .filter(Boolean),
);
/*
 * That last block is platform, format and business-of-YouTube vocabulary. It
 * shows up in titles, tags and description boilerplate on nearly every channel
 * and is never a video TOPIC.
 *
 * It is here because of a real failure. Running against a large tech channel,
 * the Whitespace Agent recommended "make videos about Shorts" — because a
 * competitor tags half their uploads #shorts — and cited a power-washer video
 * as the supporting evidence. The statistics were correct and the advice was
 * garbage, which is the worst combination a tool like this can produce.
 */

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    // Drop hashtags and @mentions entirely, before any other cleanup.
    //
    // These are branding and metadata, never subject matter, and leaving them in
    // produced the worst output this project has generated. Against a real
    // channel the Whitespace Agent recommended making videos about
    // "#ashusir #scienceandfun" — the presenter's own name and channel tag,
    // lifted from a competitor's hashtag spam — and graded one of them HIGH
    // confidence. The statistics were correct; the advice was gibberish.
    //
    // Stripping the whole token matters: keeping "#" as a word character meant
    // "#ashusir" survived tokenisation, and removing only the "#" would have
    // turned it into the equally useless bare word "ashusir".
    .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
    .replace(/[^a-z0-9+.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((w) => w.length >= 3 && w.length <= 24)
    .filter((w) => !STOPWORDS.has(w))
    .filter((w) => !/^\d+$/.test(w));
}

/** Terms present in one video: unigrams + bigrams from title, tags, description head. */
export function videoTerms(video: VideoRecord): Set<string> {
  const titleTokens = tokenize(video.title);
  // Only the head of the description: the tail is links, socials and boilerplate
  // that is identical across every upload and would create fake "topics".
  const descTokens = tokenize(video.description.slice(0, 320));
  const tagTokens = video.tags.flatMap((t) => tokenize(t));

  const terms = new Set<string>([...titleTokens, ...tagTokens]);
  // Description unigrams only count if they also appear in the title or tags,
  // or appear as part of a bigram below — keeps clusters anchored to the topic.
  for (const t of descTokens) if (titleTokens.includes(t) || tagTokens.includes(t)) terms.add(t);

  for (let i = 0; i < titleTokens.length - 1; i++) terms.add(`${titleTokens[i]} ${titleTokens[i + 1]}`);
  for (const tag of video.tags) {
    const tt = tokenize(tag);
    for (let i = 0; i < tt.length - 1; i++) terms.add(`${tt[i]} ${tt[i + 1]}`);
  }
  return terms;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Fraction of `a` that lies inside `b`. Asymmetric, unlike Jaccard. */
function containment<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / a.size;
}

// ---------------------------------------------------------------------------
// Segment construction
// ---------------------------------------------------------------------------

/** Which score a comparison runs on. See the confounding note in analyzePatterns. */
type Metric = (v: ScoredVideo) => number;

const RAW: Metric = (v) => v.performanceIndex;
const ADJ: Metric = (v) => v.adjustedIndex;

function buildSegment(
  id: string,
  label: string,
  cohort: ScoredVideo[],
  rest: ScoredVideo[],
  metric: Metric = ADJ,
): Segment | null {
  if (cohort.length === 0) return null;

  const cohortIdx = cohort.map(metric);
  const restIdx = rest.map(metric);
  const medianIndex = median(cohortIdx);
  const restMedian = rest.length > 0 ? median(restIdx) : 1;
  const p = probabilityOfSuperiority(cohortIdx, restIdx);

  const examples = [...cohort]
    .sort((a, b) => metric(b) - metric(a))
    .slice(0, 2)
    .map((v) => ({ title: v.title, views: v.views, performanceIndex: v.performanceIndex }));

  return {
    id,
    label,
    videoCount: cohort.length,
    medianIndex,
    liftPct: liftPct(medianIndex, restMedian),
    medianViews: median(cohort.map((v) => v.views)),
    confidence: gradeConfidence(cohort.length, rest.length, liftPct(medianIndex, restMedian), p),
    pSuperiority: p,
    examples,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function analyzePatterns(dataset: ChannelDataset): PatternSignals {
  const warnings = [...dataset.warnings];
  const tz = inferTimezone(dataset);

  // Newest first, guaranteed.
  const videos = [...dataset.videos].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const n = videos.length;

  if (n === 0) {
    throw new Error("analyzePatterns received an empty dataset");
  }

  // --- 1. Local baseline scoring -------------------------------------------
  // k scales with sample size: big enough to be a stable median, small enough
  // that the neighbours really are contemporaneous.
  const k = clamp(Math.round(n / 5) * 2, 6, 12);
  const viewsByIndex = videos.map((v) => v.views);

  const scored: ScoredVideo[] = videos.map((video, i) => {
    // Symmetric window around i, clamped at the array edges, excluding self.
    const half = Math.floor(k / 2);
    let lo = i - half;
    let hi = i + half;
    if (lo < 0) {
      hi += -lo;
      lo = 0;
    }
    if (hi > n - 1) {
      lo -= hi - (n - 1);
      hi = n - 1;
    }
    lo = Math.max(0, lo);

    const neighbourViews: number[] = [];
    for (let j = lo; j <= hi; j++) if (j !== i) neighbourViews.push(viewsByIndex[j]);

    const baselineViews = neighbourViews.length > 0 ? median(neighbourViews) : video.views;
    const performanceIndex = baselineViews > 0 ? video.views / baselineViews : 1;
    const { weekday, hour } = localParts(video.publishedAt, tz.utcOffsetHours);

    return {
      ...video,
      performanceIndex,
      baselineViews,
      // Quantised to whole days, deliberately.
      //
      // Sub-day precision in "how old is this video" is meaningless for every
      // calculation here, and letting it vary continuously made the entire
      // downstream briefing change on every single run — which silently
      // defeated the narration cache, since that is keyed on a hash of the
      // briefing. Whole days make the pipeline deterministic within a day.
      ageDays: Math.floor((Date.now() - Date.parse(video.publishedAt)) / 86_400_000),
      adjustedIndex: performanceIndex, // replaced below, once bucket effects are known
      likeRate: video.views > 0 ? video.likes / video.views : 0,
      commentRate: video.views > 0 ? video.comments / video.views : 0,
      engagementPercentile: 0, // filled in below
      titlePatterns: detectTitlePatterns(video.title),
      lengthBucket: lengthBucketOf(video.durationSeconds),
      localWeekday: weekday,
      localHour: hour,
    };
  });

  // --- 1b. Control for the length confound -------------------------------
  //
  // Video length is usually the single strongest driver of performance on a
  // channel, and it is correlated with everything else a creator does: the
  // Docker deep-dives are long, the quick tips are short. Left uncontrolled, a
  // univariate "Docker wins" finding may just be "long videos win" wearing a
  // disguise — and telling a creator to make more Docker videos when the real
  // lever was runtime is exactly the kind of confident-but-wrong advice that
  // makes a tool untrustworthy.
  //
  // So we divide out each video's length-bucket effect before comparing titles,
  // topics or timing. This is a one-way ANOVA-style adjustment, not a full
  // model: it removes the dominant confound cheaply and stays explainable.
  //
  // The bucket effect is shrunk toward 1.0 in proportion to how little data
  // backs it (James-Stein flavoured), so a 3-video bucket cannot swing the
  // adjustment as hard as a 20-video bucket.
  const bucketEffect = new Map<LengthBucketId, number>();
  for (const bucket of LENGTH_BUCKETS) {
    const inBucket = scored.filter((v) => v.lengthBucket === bucket.id);
    if (inBucket.length === 0) continue;
    const raw = median(inBucket.map((v) => v.performanceIndex));
    const shrink = inBucket.length / (inBucket.length + 4);
    bucketEffect.set(bucket.id, 1 + (raw - 1) * shrink);
  }
  for (const v of scored) {
    const effect = bucketEffect.get(v.lengthBucket) ?? 1;
    v.adjustedIndex = effect > 0.05 ? v.performanceIndex / effect : v.performanceIndex;
  }

  // Engagement percentile: blend like-rate and comment-rate ranks. Comments are
  // a stronger signal of a video landing (they cost the viewer more effort) but
  // are noisier, so they get less weight.
  const likeRanks = percentiles(scored.map((v) => v.likeRate));
  const commentRanks = percentiles(scored.map((v) => v.commentRate));
  scored.forEach((v, i) => {
    v.engagementPercentile = 0.6 * likeRanks[i] + 0.4 * commentRanks[i];
  });

  const medianViews = median(scored.map((v) => v.views));
  const medianLikeRate = median(scored.map((v) => v.likeRate));
  const medianCommentRate = median(scored.map((v) => v.commentRate));

  // --- 2. Title patterns ---------------------------------------------------
  const titlePatterns: Segment[] = [];
  const allPatternIds = Object.keys(TITLE_PATTERN_LABELS) as TitlePatternId[];
  for (const pid of allPatternIds) {
    const cohort = scored.filter((v) => v.titlePatterns.includes(pid));
    const rest = scored.filter((v) => !v.titlePatterns.includes(pid));
    // 3 videos is the floor for saying anything at all about a cohort.
    if (cohort.length < 3 || rest.length < 3) continue;
    const seg = buildSegment(`title:${pid}`, TITLE_PATTERN_LABELS[pid], cohort, rest);
    if (seg) titlePatterns.push(seg);
  }
  titlePatterns.sort((a, b) => b.liftPct - a.liftPct);

  // --- 3. Title length ----------------------------------------------------
  const titleBands: Segment[] = [];
  for (const band of TITLE_LENGTH_BANDS) {
    const cohort = scored.filter((v) => v.title.length >= band.min && v.title.length <= band.max);
    const rest = scored.filter((v) => v.title.length < band.min || v.title.length > band.max);
    if (cohort.length < 3 || rest.length < 3) continue;
    const seg = buildSegment(band.id, band.label, cohort, rest);
    if (seg) titleBands.push(seg);
  }
  const bestTitleBand = [...titleBands].sort((a, b) => b.liftPct - a.liftPct)[0] ?? null;

  // --- 4. Video length buckets -------------------------------------------
  const lengthBuckets: Segment[] = [];
  for (const bucket of LENGTH_BUCKETS) {
    const cohort = scored.filter((v) => v.lengthBucket === bucket.id);
    const rest = scored.filter((v) => v.lengthBucket !== bucket.id);
    if (cohort.length < 3 || rest.length < 3) continue;
    // Length is the one comparison that must run on the RAW index — adjusting
    // for the length effect and then measuring the length effect is circular.
    const seg = buildSegment(`length:${bucket.id}`, bucket.label, cohort, rest, RAW);
    if (seg) lengthBuckets.push(seg);
  }
  lengthBuckets.sort((a, b) => b.liftPct - a.liftPct);

  // --- 5. Timing ----------------------------------------------------------
  // 3-hour windows, because nobody can act on "publish at 14:37" and bucketing
  // that finely at n=40 is pure noise mining.
  const slotMap = new Map<string, ScoredVideo[]>();
  for (const v of scored) {
    const hourStart = Math.floor(v.localHour / 3) * 3;
    const key = `${v.localWeekday}:${hourStart}`;
    const arr = slotMap.get(key) ?? [];
    arr.push(v);
    slotMap.set(key, arr);
  }

  const slots: TimingSlot[] = [];
  for (const [key, cohort] of slotMap) {
    if (cohort.length < 3) continue;
    const [wd, hs] = key.split(":").map(Number);
    const rest = scored.filter((v) => !cohort.includes(v));
    if (rest.length < 3) continue;
    const cohortIdx = cohort.map(ADJ);
    const restIdx = rest.map(ADJ);
    const mi = median(cohortIdx);
    const lp = liftPct(mi, median(restIdx));
    const p = probabilityOfSuperiority(cohortIdx, restIdx);
    slots.push({
      weekday: wd,
      weekdayLabel: WEEKDAY_LABELS[wd],
      hourStart: hs,
      videoCount: cohort.length,
      medianIndex: mi,
      liftPct: lp,
      confidence: gradeConfidence(cohort.length, rest.length, lp, p),
      medianViews: median(cohort.map((v) => v.views)),
    });
  }
  slots.sort((a, b) => b.liftPct - a.liftPct);

  // Weekday-only view: coarser, so it survives on thin data where slots do not.
  const weekdayTotals = WEEKDAY_LABELS.map((label, wd) => {
    const cohort = scored.filter((v) => v.localWeekday === wd);
    const rest = scored.filter((v) => v.localWeekday !== wd);
    const mi = cohort.length ? median(cohort.map(ADJ)) : 0;
    return {
      weekday: wd,
      label,
      videoCount: cohort.length,
      medianIndex: mi,
      liftPct: cohort.length && rest.length ? liftPct(mi, median(rest.map(ADJ))) : 0,
    };
  });

  const weekdaySegments: Segment[] = [];
  for (const wd of weekdayTotals) {
    const cohort = scored.filter((v) => v.localWeekday === wd.weekday);
    const rest = scored.filter((v) => v.localWeekday !== wd.weekday);
    if (cohort.length < 3 || rest.length < 3) continue;
    const seg = buildSegment(`weekday:${wd.weekday}`, `${wd.label} uploads`, cohort, rest);
    if (seg) weekdaySegments.push(seg);
  }
  weekdaySegments.sort((a, b) => b.liftPct - a.liftPct);

  const timingDataThin = slots.filter((s) => s.confidence !== "low").length === 0;
  if (timingDataThin) {
    warnings.push(
      "Upload timing is spread too thinly across the week to draw a confident slot recommendation from this channel's own data alone.",
    );
  }

  // --- 6. Topic clusters --------------------------------------------------
  const topics = clusterTopics(scored);

  // --- 7. Trend -----------------------------------------------------------
  const trend = computeTrend(scored);

  // --- 8. Cadence ---------------------------------------------------------
  const cadence = computeCadence(scored);

  // --- 9. Rank every finding ---------------------------------------------
  const rankedFindings = rankFindings({
    titlePatterns,
    bestTitleBand,
    lengthBuckets,
    slots,
    weekdaySegments,
    topics,
    trend,
    cadence,
    scored,
    medianLikeRate,
    medianViews,
    tz,
  });

  const sortedByDate = [...scored].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));

  if (n < 15) {
    warnings.push(
      `Only ${n} analysable uploads available, so several findings are marked low confidence. The patterns are directional, not conclusive.`,
    );
  }

  return {
    channel: dataset.channel,
    sampleSize: n,
    windowStart: sortedByDate[0].publishedAt,
    windowEnd: sortedByDate[sortedByDate.length - 1].publishedAt,
    timezone: tz,
    medianViews,
    medianLikeRate,
    medianCommentRate,
    scoredVideos: scored,
    topPerformers: [...scored].sort((a, b) => b.performanceIndex - a.performanceIndex).slice(0, 5),
    underPerformers: [...scored].sort((a, b) => a.performanceIndex - b.performanceIndex).slice(0, 5),
    titlePatterns,
    titleLength: {
      bestBand: bestTitleBand,
      bands: titleBands,
      channelMedianChars: Math.round(median(scored.map((v) => v.title.length))),
    },
    lengthBuckets,
    timing: {
      bestSlots: slots.slice(0, 3),
      worstSlots: slots.slice(-2).reverse(),
      weekdayTotals,
      dataThin: timingDataThin,
    },
    topics,
    trend,
    cadence,
    rankedFindings,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Topic clustering
// ---------------------------------------------------------------------------

function clusterTopics(scored: ScoredVideo[]): TopicCluster[] {
  const n = scored.length;
  const termToVideos = new Map<string, number[]>();

  scored.forEach((v, i) => {
    for (const term of videoTerms(v)) {
      const arr = termToVideos.get(term) ?? [];
      arr.push(i);
      termToVideos.set(term, arr);
    }
  });

  // A term is a topic candidate if it appears in enough videos to compare, but
  // not so many that it is just the channel's own name or niche boilerplate.
  const minDocs = Math.max(3, Math.ceil(n * 0.07));
  const maxDocs = Math.max(minDocs + 1, Math.floor(n * 0.6));

  interface Candidate {
    term: string;
    indices: number[];
    set: Set<number>;
    medianIndex: number;
    liftPct: number;
    p: number;
    score: number;
    isBigram: boolean;
  }

  const candidates: Candidate[] = [];
  for (const [term, indices] of termToVideos) {
    if (indices.length < minDocs || indices.length > maxDocs) continue;
    const set = new Set(indices);
    const cohort = indices.map((i) => scored[i].adjustedIndex);
    const rest = scored.filter((_, i) => !set.has(i)).map((v) => v.adjustedIndex);
    if (rest.length < 3) continue;
    const mi = median(cohort);
    const lp = liftPct(mi, median(rest));
    const p = probabilityOfSuperiority(cohort, rest);
    const isBigram = term.includes(" ");
    candidates.push({
      term,
      indices,
      set,
      medianIndex: mi,
      liftPct: lp,
      p,
      // Bigrams get a bonus: "docker compose" is a more useful topic label than
      // "docker" or "compose" alone, and specificity is what makes the final
      // recommendation actionable.
      score: Math.abs(lp) * Math.sqrt(indices.length) * (isBigram ? 1.25 : 1),
      isBigram,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Greedy merge: terms whose video sets overlap heavily describe the same
  // topic, so fold them into one cluster rather than reporting near-duplicates.
  const clusters: Array<{ terms: string[]; set: Set<number>; lead: Candidate }> = [];
  for (const cand of candidates) {
    // Merge on containment as well as similarity. "docker compose" sits almost
    // entirely inside "docker", and reporting both as separate topics is noise
    // dressed up as insight. Candidates arrive sorted by score, so the stronger
    // term forms the cluster and the narrower one is kept as a keyword — which
    // is what the label prefers, so the user still sees the specific phrasing.
    const host = clusters.find((c) => jaccard(c.set, cand.set) >= 0.5 || containment(cand.set, c.set) >= 0.65);
    if (host) {
      if (host.terms.length < 4) host.terms.push(cand.term);
      continue;
    }
    if (clusters.length >= 10) continue;
    clusters.push({ terms: [cand.term], set: new Set(cand.set), lead: cand });
  }

  return clusters.map((c, idx) => {
    const indices = [...c.set];
    const cohort = indices.map((i) => scored[i]);
    const cohortIdx = cohort.map((v) => v.adjustedIndex);
    const rest = scored.filter((_, i) => !c.set.has(i));
    const restIdx = rest.map((v) => v.adjustedIndex);
    const mi = median(cohortIdx);
    const lp = rest.length ? liftPct(mi, median(restIdx)) : 0;
    const p = probabilityOfSuperiority(cohortIdx, restIdx);

    const newest = cohort.reduce(
      (acc, v) => (Date.parse(v.publishedAt) > Date.parse(acc.publishedAt) ? v : acc),
      cohort[0],
    );

    // Label from the most specific terms available, skipping near-duplicates.
    // Without the substring check a cluster labels itself
    // "software engineering + software engineer", which reads like a bug.
    const ranked = c.terms
      .slice()
      .sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);
    const labelParts: string[] = [];
    for (const term of ranked) {
      if (labelParts.length >= 2) break;
      if (labelParts.some((p) => p.includes(term) || term.includes(p))) continue;
      labelParts.push(term);
    }
    const label = labelParts.join(" + ") || ranked[0] || "misc";

    return {
      id: `topic:${idx}`,
      label,
      keywords: c.terms,
      videoCount: cohort.length,
      medianIndex: mi,
      liftPct: lp,
      medianViews: median(cohort.map((v) => v.views)),
      confidence: gradeConfidence(cohort.length, rest.length, lp, p),
      pSuperiority: p,
      lastCoveredAt: newest.publishedAt,
      daysSinceLastCovered: Math.round((Date.now() - Date.parse(newest.publishedAt)) / 86_400_000),
      examples: [...cohort]
        .sort((a, b) => b.adjustedIndex - a.adjustedIndex)
        .slice(0, 2)
        .map((v) => ({ title: v.title, views: v.views, performanceIndex: v.performanceIndex })),
    } satisfies TopicCluster;
  });
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * Trend has to be measured on RAW views, not on performanceIndex: the index is
 * defined relative to a local baseline, so it is trend-free by construction.
 * Comparing the newest third against the oldest third of the window is crude
 * but robust, and importantly it is a statement about views rather than about
 * our own normalisation.
 */
function computeTrend(scored: ScoredVideo[]): ChannelTrend {
  const byDate = [...scored].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const third = Math.max(3, Math.floor(byDate.length / 3));
  if (byDate.length < 9) {
    return {
      direction: "flat",
      recentMedianViews: median(byDate.map((v) => v.views)),
      earlierMedianViews: median(byDate.map((v) => v.views)),
      changePct: 0,
      confidence: "low",
    };
  }

  const earlier = byDate.slice(0, third);
  const recent = byDate.slice(-third);

  // Older videos have had longer to accumulate views, which biases this test
  // AGAINST finding growth. We correct by discounting the recent cohort's
  // apparent shortfall using the median age gap between the two cohorts.
  const earlierMedian = median(earlier.map((v) => v.views));
  const recentRaw = median(recent.map((v) => v.views));
  const recentAge = median(recent.map((v) => v.ageDays));
  const earlierAge = median(earlier.map((v) => v.ageDays));

  // Views roughly follow log growth after the first burst; scale the recent
  // cohort up to what it would plausibly reach at the earlier cohort's age.
  const maturity = (age: number) => Math.log1p(Math.max(1, age)) / Math.log1p(Math.max(1, earlierAge));
  const recentMedian = recentAge < earlierAge ? recentRaw / Math.max(0.35, maturity(recentAge)) : recentRaw;

  const changePct = liftPct(recentMedian, earlierMedian);
  const p = probabilityOfSuperiority(
    recent.map((v) => v.views / Math.max(0.35, maturity(v.ageDays))),
    earlier.map((v) => v.views),
  );

  return {
    direction: changePct > 12 ? "improving" : changePct < -12 ? "declining" : "flat",
    recentMedianViews: Math.round(recentMedian),
    earlierMedianViews: Math.round(earlierMedian),
    changePct,
    confidence: gradeConfidence(recent.length, earlier.length, changePct, p),
  };
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

function computeCadence(scored: ScoredVideo[]): CadenceStats {
  const times = scored.map((v) => Date.parse(v.publishedAt)).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 86_400_000);

  if (gaps.length === 0) {
    return { medianDaysBetweenUploads: 0, uploadsPerMonth: 0, consistencyScore: 0, longestGapDays: 0 };
  }

  const med = median(gaps);
  const iqr = quantile(gaps, 0.75) - quantile(gaps, 0.25);
  return {
    medianDaysBetweenUploads: Number(med.toFixed(1)),
    uploadsPerMonth: Number((30 / Math.max(0.5, med)).toFixed(1)),
    // 1 means metronomic; 0 means the gaps vary as much as the gap itself.
    consistencyScore: Number(clamp(1 - iqr / Math.max(1, med), 0, 1).toFixed(2)),
    longestGapDays: Math.round(Math.max(...gaps)),
  };
}

// ---------------------------------------------------------------------------
// Finding ranking
// ---------------------------------------------------------------------------

interface RankInput {
  titlePatterns: Segment[];
  bestTitleBand: Segment | null;
  lengthBuckets: Segment[];
  slots: TimingSlot[];
  weekdaySegments: Segment[];
  topics: TopicCluster[];
  trend: ChannelTrend;
  cadence: CadenceStats;
  scored: ScoredVideo[];
  medianLikeRate: number;
  medianViews: number;
  tz: TimezoneInfo;
}

function weigh(liftPctValue: number, count: number, confidence: Confidence): number {
  return Math.abs(liftPctValue) * Math.log1p(count) * CONFIDENCE_WEIGHT[confidence];
}

function rankFindings(input: RankInput): Finding[] {
  const findings: Finding[] = [];

  const push = (
    id: string,
    category: Finding["category"],
    statement: string,
    lift: number,
    count: number,
    confidence: Confidence,
  ) => {
    findings.push({ id, category, statement, liftPct: Number(lift.toFixed(1)), videoCount: count, confidence, weight: weigh(lift, count, confidence) });
  };

  // Title patterns: report both the best and the worst, since "stop doing X" is
  // often more actionable than "do more of Y".
  for (const seg of input.titlePatterns) {
    if (Math.abs(seg.liftPct) < 8) continue;
    push(
      seg.id,
      "title",
      `${seg.label} (${seg.videoCount} videos) run a median ${formatPct(seg.liftPct)} against the rest of the channel; median ${formatCount(seg.medianViews)} views, and ${Math.round(seg.pSuperiority * 100)}% of head-to-head comparisons favour them.`,
      seg.liftPct,
      seg.videoCount,
      seg.confidence,
    );
  }

  if (input.bestTitleBand && Math.abs(input.bestTitleBand.liftPct) >= 8) {
    const b = input.bestTitleBand;
    push(
      `titlelen:${b.id}`,
      "title",
      `Titles of ${b.label.toLowerCase()} (${b.videoCount} videos) run ${formatPct(b.liftPct)} against other title lengths.`,
      b.liftPct,
      b.videoCount,
      b.confidence,
    );
  }

  for (const seg of input.lengthBuckets) {
    if (Math.abs(seg.liftPct) < 8) continue;
    push(
      seg.id,
      "length",
      `${seg.label} videos (${seg.videoCount} of them) run ${formatPct(seg.liftPct)} against every other length, with a median of ${formatCount(seg.medianViews)} views.`,
      seg.liftPct,
      seg.videoCount,
      seg.confidence,
    );
  }

  for (const slot of input.slots.slice(0, 2)) {
    if (slot.liftPct < 10) continue;
    push(
      `slot:${slot.weekday}:${slot.hourStart}`,
      "timing",
      `${slot.weekdayLabel} ${formatHourWindow(slot.hourStart)} ${input.tz.label} (${slot.videoCount} uploads) runs ${formatPct(slot.liftPct)} against all other slots.`,
      slot.liftPct,
      slot.videoCount,
      slot.confidence,
    );
  }

  for (const seg of input.weekdaySegments.slice(0, 2)) {
    if (Math.abs(seg.liftPct) < 12) continue;
    push(
      seg.id,
      "timing",
      `${seg.label} (${seg.videoCount} videos) run ${formatPct(seg.liftPct)} against uploads on other days.`,
      seg.liftPct,
      seg.videoCount,
      seg.confidence,
    );
  }
  const worstWeekday = input.weekdaySegments[input.weekdaySegments.length - 1];
  if (worstWeekday && worstWeekday.liftPct < -12) {
    push(
      `${worstWeekday.id}:worst`,
      "timing",
      `${worstWeekday.label} (${worstWeekday.videoCount} videos) run ${formatPct(worstWeekday.liftPct)} against other days.`,
      worstWeekday.liftPct,
      worstWeekday.videoCount,
      worstWeekday.confidence,
    );
  }

  for (const topic of input.topics) {
    if (Math.abs(topic.liftPct) < 10) continue;
    const staleness =
      topic.liftPct > 0 && topic.daysSinceLastCovered && topic.daysSinceLastCovered > 45
        ? ` Last covered ${topic.daysSinceLastCovered} days ago.`
        : "";
    push(
      topic.id,
      "topic",
      `Videos about "${topic.label}" (${topic.videoCount} videos) run ${formatPct(topic.liftPct)} against the channel's other topics; median ${formatCount(topic.medianViews)} views.${staleness}`,
      topic.liftPct,
      topic.videoCount,
      topic.confidence,
    );
  }

  if (input.trend.direction !== "flat" && input.trend.confidence !== "low") {
    push(
      "trend",
      "trend",
      `Age-adjusted median views are ${input.trend.direction} — the newest third of the window sits at ~${formatCount(input.trend.recentMedianViews)} versus ${formatCount(input.trend.earlierMedianViews)} for the oldest third (${formatPct(input.trend.changePct)}).`,
      input.trend.changePct,
      input.scored.length,
      input.trend.confidence,
    );
  }

  if (input.cadence.consistencyScore < 0.5 && input.scored.length >= 12) {
    push(
      "cadence",
      "cadence",
      `Upload gaps are irregular (median ${input.cadence.medianDaysBetweenUploads} days, longest gap ${input.cadence.longestGapDays} days, consistency ${input.cadence.consistencyScore}/1.00).`,
      -15,
      input.scored.length,
      "medium",
    );
  }

  // Engagement outliers: videos the audience loved but the algorithm ignored are
  // the single most under-exploited signal a small creator has. High engagement
  // with low reach means the topic works and the packaging did not.
  const hiddenGems = input.scored.filter((v) => v.engagementPercentile >= 75 && v.performanceIndex < 0.9);
  if (hiddenGems.length >= 2) {
    const best = hiddenGems.sort((a, b) => b.engagementPercentile - a.engagementPercentile)[0];
    push(
      "engagement:hidden_gems",
      "engagement",
      `${hiddenGems.length} videos sit in the channel's top engagement quartile while under-performing on views — strongest example "${best.title}" (${formatCount(best.views)} views, ${(best.likeRate * 100).toFixed(1)}% like rate vs channel median ${(input.medianLikeRate * 100).toFixed(1)}%). The topic landed; the packaging did not.`,
      35,
      hiddenGems.length,
      hiddenGems.length >= 3 ? "medium" : "low",
    );
  }

  findings.sort((a, b) => b.weight - a.weight);
  return findings;
}
