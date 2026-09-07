/**
 * AGENT 3b — THUMBNAIL SIGNAL PASS  (P1, optional)
 *
 * The one place a multimodal model earns its keep: turning images into
 * structured traits that the deterministic layer can then correlate.
 *
 * Note the division of labour, which is the same discipline as the rest of the
 * pipeline. The LLM does ONLY perception ("is there a human face in this
 * image?"). It is never asked "which thumbnail performed better" — it has no
 * idea, and letting it guess would produce confident nonsense. The correlation
 * between traits and performance is computed here, in code, from view data.
 *
 * Wholly optional and wholly non-fatal: no API key, a slow CDN, or a refused
 * image download all degrade to `attempted: false` and the report renders
 * without a thumbnail section.
 */

import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";

import { cacheGet, cacheSet } from "@/lib/cache";
import {
  CONFIDENCE_WEIGHT,
  formatPct,
  gradeConfidence,
  liftPct,
  median,
  probabilityOfSuperiority,
} from "@/lib/stats";
import type {
  GuidanceStrength,
  PatternSignals,
  ScoredVideo,
  ThumbnailReport,
  ThumbnailTraitSegment,
} from "@/lib/types";
import { GEMINI_MODEL_CANDIDATES, PRIMARY_MODEL, hasLlmKey, isModelAvailabilityError } from "./strategyWriter";

/*
 * 16, not 12, for a specific arithmetic reason.
 *
 * gradeConfidence() only returns "high" when the cohort has >= 6 members and the
 * remainder has >= 8 — 14 videos minimum. At a 12-thumbnail sample those two
 * conditions cannot both hold, so "high" was unreachable by construction and the
 * best any thumbnail trait could ever earn was "medium". Since a directive now
 * requires clearing the confidence bar, sampling below 14 would permanently cap
 * the evidence available to the one card that was previously over-claiming.
 */
const MAX_SAMPLE = 16;
const IMAGE_TIMEOUT_MS = 6_000;

/** Traits we ask the vision model to detect. Kept small, visual and objective. */
const TRAITS = [
  { key: "face", label: "A human face is visible" },
  { key: "text_overlay", label: "Large text is overlaid on the thumbnail" },
  { key: "high_contrast", label: "High colour contrast / bold saturated colours" },
  { key: "cluttered", label: "Three or more competing focal points (cluttered)" },
  { key: "screenshot", label: "Mostly a screenshot or UI capture" },
] as const;

type TraitKey = (typeof TRAITS)[number]["key"];

const EMPTY: ThumbnailReport = {
  attempted: false,
  ok: false,
  sampled: 0,
  traits: [],
  guidance: null,
  strength: "inconclusive",
  note: null,
};

export interface ThumbnailOptions {
  onLog?: (message: string) => void;
  disable?: boolean;
  /** Absolute wall-clock deadline (ms since epoch) for the vision pass. */
  deadlineAt?: number;
}

/**
 * Budget policy for this stage, and the reasoning behind the numbers.
 *
 * A vision call over 15 images measures at 15-21s, which is a large slice of a
 * ~45s request. It also feeds the least reliable section of the report. So it is
 * explicitly subordinate to the narration: it only starts when there is enough
 * time left for BOTH it and a full narration, and its own call is capped well
 * below what it might want.
 *
 * This ordering was learned the hard way. With a 20s cap and a 20s entry
 * requirement, a real run spent 21.4s here, aborted with nothing, and left the
 * narration too little time — so the report fell back to templated prose to pay
 * for a thumbnail section that did not exist.
 *
 * The cap must also be generous enough for the call to actually COMPLETE.
 * Measured completions are 15-21s, so a 14s cap guaranteed an abort: 15s spent
 * for no result at all, which is strictly worse than not running. Either give it
 * room to finish or stand it down — never both halves of the cost.
 */
export const THUMBNAIL_MIN_BUDGET_MS = 40_000;
const VISION_MAX_CALL_MS = 22_000;

async function downloadImage(url: string): Promise<{ media_type: string; data: string } | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Inline image data has a request-size ceiling; YouTube thumbnails are far
    // smaller than it, so anything this large is a redirect to an error page
    // rather than an actual thumbnail.
    if (buf.byteLength === 0 || buf.byteLength > 4_500_000) return null;
    return { media_type: type, data: buf.toString("base64") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sample the extremes plus the middle. Comparing only winners against only
 * losers would inflate every effect; we need spread across the performance
 * range for the correlation to mean anything.
 */
function sampleVideos(signals: PatternSignals): ScoredVideo[] {
  const sorted = [...signals.scoredVideos].sort((a, b) => b.adjustedIndex - a.adjustedIndex);
  if (sorted.length <= MAX_SAMPLE) return sorted;

  const take = Math.floor(MAX_SAMPLE / 3);
  const mid = Math.floor(sorted.length / 2);
  return [
    ...sorted.slice(0, take),
    ...sorted.slice(mid - Math.floor(take / 2), mid - Math.floor(take / 2) + take),
    ...sorted.slice(-take),
  ].slice(0, MAX_SAMPLE);
}

export async function analyzeThumbnails(
  signals: PatternSignals,
  options: ThumbnailOptions = {},
): Promise<ThumbnailReport> {
  const log = options.onLog ?? (() => {});

  if (options.disable) return { ...EMPTY, note: "Thumbnail analysis was disabled for this run." };
  if (!hasLlmKey()) {
    return {
      ...EMPTY,
      note: "Thumbnail analysis needs GEMINI_API_KEY (it uses a multimodal model to detect visual traits). The rest of the report is unaffected.",
    };
  }

  const sample = sampleVideos(signals);
  if (sample.length < 6) {
    return { ...EMPTY, attempted: true, note: "Too few videos to correlate thumbnail traits against performance." };
  }

  log(`Downloading ${sample.length} thumbnails...`);
  const images: Array<{ video: ScoredVideo; image: { media_type: string; data: string } }> = [];
  const downloads = await Promise.all(sample.map((v) => downloadImage(v.thumbnailUrl)));
  downloads.forEach((img, i) => {
    if (img) images.push({ video: sample[i], image: img });
  });

  if (images.length < 6) {
    return {
      ...EMPTY,
      attempted: true,
      note: `Only ${images.length} of ${sample.length} thumbnails could be downloaded, which is too few to correlate. Skipped.`,
    };
  }

  // Cache the perception result against the exact set of video ids inspected.
  // Vision is the more expensive half of the pipeline's LLM budget (12 images
  // per call, and the free tier allows only 20 requests per model per day), and
  // the traits of a fixed set of thumbnails cannot change between runs.
  const visionKey = `llm:thumbs:${PRIMARY_MODEL}:${images.map((i) => i.video.id).join(",")}`;
  const cachedFlags = cacheGet<Record<TraitKey, boolean>[]>(visionKey);

  let flags: Record<TraitKey, boolean>[] = [];
  try {
    if (cachedFlags && cachedFlags.length === images.length) {
      log(`Reusing cached thumbnail traits for these ${images.length} videos (no API call).`);
      flags = cachedFlags;
    } else {
      log(`Running a vision pass over ${images.length} thumbnails...`);
      flags = await classifyThumbnails(images.map((i) => i.image), options.deadlineAt);
      cacheSet(visionKey, flags, 7 * 24 * 60 * 60 * 1000);
    }
  } catch (err) {
    return {
      ...EMPTY,
      attempted: true,
      note: thumbnailFailureNote(err),
    };
  }

  if (flags.length !== images.length) {
    return {
      ...EMPTY,
      attempted: true,
      note: `Vision pass returned ${flags.length} results for ${images.length} thumbnails, so the correlation was discarded rather than guessed at.`,
    };
  }

  // ---- correlate, in code, from real view data --------------------------
  const traits: ThumbnailTraitSegment[] = [];
  for (const trait of TRAITS) {
    const withTrait = images.filter((_, i) => flags[i][trait.key]).map((i) => i.video);
    const without = images.filter((_, i) => !flags[i][trait.key]).map((i) => i.video);
    if (withTrait.length < 3 || without.length < 3) continue;

    const a = withTrait.map((v) => v.adjustedIndex);
    const b = without.map((v) => v.adjustedIndex);
    const mi = median(a);
    const lp = liftPct(mi, median(b));
    const p = probabilityOfSuperiority(a, b);

    traits.push({
      id: `thumb:${trait.key}`,
      trait: trait.key,
      label: trait.label,
      videoCount: withTrait.length,
      medianIndex: mi,
      liftPct: lp,
      medianViews: median(withTrait.map((v) => v.views)),
      confidence: gradeConfidence(withTrait.length, without.length, lp, p),
      pSuperiority: p,
      examples: [...withTrait]
        .sort((x, y) => y.adjustedIndex - x.adjustedIndex)
        .slice(0, 2)
        .map((v) => ({ title: v.title, views: v.views, performanceIndex: v.performanceIndex })),
    });
  }

  const summary = summariseTraits(traits, images.length);

  return {
    attempted: true,
    ok: true,
    sampled: images.length,
    traits: summary.traits,
    guidance: summary.guidance,
    strength: summary.strength,
    // `note` is for operational problems only. The analytical outcome —
    // including "nothing conclusive here" — is always carried by `guidance`, so
    // there is one place to read it from and no way for the two to disagree.
    note:
      traits.length === 0
        ? `The vision pass classified all ${images.length} thumbnails identically for every trait, so there was nothing to correlate against.`
        : null,
  };
}

/**
 * Rank the traits and turn the winner into one sentence, hedged to match how
 * much evidence is actually behind it.
 *
 * Pure and exported so the wording rules can be tested against constructed edge
 * cases instead of whatever a live channel happens to produce. The bug this
 * replaces was invisible precisely because it only showed up on real data.
 */
/** Turn a vision-pass failure into something a reader can act on. */
function thumbnailFailureNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(message)) {
    return "The thumbnail pass was skipped because the Gemini API daily free-tier quota is exhausted. The rest of the report is unaffected.";
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return "The thumbnail pass was cut short to keep the analysis inside its time budget. The rest of the report is unaffected.";
  }
  return `Thumbnail pass failed (${message.slice(0, 140)}). The rest of the report is unaffected.`;
}

export function summariseTraits(
  input: ThumbnailTraitSegment[],
  sampled: number,
): { traits: ThumbnailTraitSegment[]; guidance: string; strength: GuidanceStrength } {
  /*
   * Rank by EVIDENCE WEIGHT, not by raw effect size.
   *
   * Sorting on |liftPct| alone is what let a 3-thumbnail noise spike become the
   * headline finding. On a real channel it surfaced "cluttered, n=3, -62%, low
   * confidence" ahead of "high contrast, n=6, medium confidence" — the smaller,
   * less reliable cohort won purely because noise is larger at n=3. Weighting by
   * cohort size and confidence is the same ranking the Pattern Analysis Agent
   * uses, and it puts the better-evidenced trait first.
   */
  const traits = [...input].sort(
    (a, b) =>
      Math.abs(b.liftPct) * Math.log1p(b.videoCount) * CONFIDENCE_WEIGHT[b.confidence] -
      Math.abs(a.liftPct) * Math.log1p(a.videoCount) * CONFIDENCE_WEIGHT[a.confidence],
  );

  /*
   * A trait may only be phrased as an instruction if it clears the confidence
   * bar AND at least 5 thumbnails back it. A large effect that fails either test
   * is a test to run, not a rule.
   *
   * The cohort floor matters because gradeConfidence() awards "medium" from a
   * cohort of 4, and 4 of 16 thumbnails is a thin basis for telling a creator to
   * change how they make thumbnails. Requiring 5 keeps imperatives to traits
   * backed by roughly a third of the sample. It makes directives rarer, which is
   * the correct direction: this card was previously issuing them unconditionally.
   */
  const MIN_COHORT_FOR_DIRECTIVE = 5;
  const directive = traits.find(
    (t) => t.confidence !== "low" && Math.abs(t.liftPct) >= 15 && t.videoCount >= MIN_COHORT_FOR_DIRECTIVE,
  );
  const tentative = directive ? undefined : traits.find((t) => Math.abs(t.liftPct) >= 25);

  if (directive) {
    return {
      traits,
      strength: "directive",
      guidance:
        `Thumbnails where ${directive.label.toLowerCase()} run ${formatPct(directive.liftPct)} against the rest of the sampled set ` +
        `(${directive.videoCount} of ${sampled} thumbnails, ${directive.confidence} confidence) — ` +
        `${directive.liftPct > 0 ? "lean into it" : "cut it"}.`,
    };
  }

  if (tentative) {
    return {
      traits,
      strength: "tentative",
      guidance:
        `Thumbnails where ${tentative.label.toLowerCase()} run ${formatPct(tentative.liftPct)} against the rest of the sampled set, ` +
        `but only ${tentative.videoCount} of ${sampled} sampled thumbnails back that and it does not clear the confidence bar. ` +
        `Worth testing deliberately across your next few uploads rather than treating as a rule.`,
    };
  }

  return {
    traits,
    strength: "inconclusive",
    guidance:
      `Across ${sampled} sampled thumbnails, no visual trait separates strongly enough to act on. ` +
      `That is useful in itself: thumbnail style is not this channel's bottleneck, so packaging effort is better spent on titles and topic choice.`,
  };
}

/** One multi-image call. The model does perception only, never judgement. */
async function classifyThumbnails(
  images: Array<{ media_type: string; data: string }>,
  deadlineAt?: number,
): Promise<Record<TraitKey, boolean>[]> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

  // Schema-enforced output: an array of exactly one object per image, each with
  // the same boolean keys. Guarantees the length and key set line up with the
  // images we sent, which is what the caller checks before correlating.
  const traitProperties: Record<string, Schema> = {};
  for (const t of TRAITS) traitProperties[t.key] = { type: Type.BOOLEAN, description: t.label };

  const schema: Schema = {
    type: Type.ARRAY,
    minItems: String(images.length),
    maxItems: String(images.length),
    items: {
      type: Type.OBJECT,
      properties: traitProperties,
      required: TRAITS.map((t) => t.key),
      propertyOrdering: TRAITS.map((t) => t.key),
    },
  };

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text:
        `You will see ${images.length} YouTube thumbnails, in order, labelled 1 to ${images.length}.\n\n` +
        `For each one, report only what is VISIBLE. Do not guess how well the video performed — you have no information about that and it is not what is being asked.\n\n` +
        `Traits:\n` +
        TRAITS.map((t) => `- "${t.key}": ${t.label}`).join("\n") +
        `\n\nReturn an array of ${images.length} objects in the same order as the images.`,
    },
  ];

  images.forEach((img, i) => {
    parts.push({ text: `Thumbnail ${i + 1}:` });
    parts.push({ inlineData: { mimeType: img.media_type, data: img.data } });
  });

  // Same candidate walk as the Strategy Writer. It matters most for quota:
  // the free tier meters requests per model per day, so a 429 on the primary
  // model is not a 429 on the next one.
  let res: Awaited<ReturnType<typeof client.models.generateContent>> | null = null;
  let lastErr: unknown;

  for (const model of GEMINI_MODEL_CANDIDATES) {
    try {
      res = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          // Bounded so a slow vision call cannot eat the narration's budget.
          abortSignal: AbortSignal.timeout(
            Math.min(VISION_MAX_CALL_MS, Math.max(5_000, deadlineAt ? deadlineAt - Date.now() : VISION_MAX_CALL_MS)),
          ),
          temperature: 0,
          // Same trap as the Strategy Writer: reasoning tokens come out of this
          // budget, so a ceiling sized for the JSON alone gets eaten by thinking
          // and the response is truncated. This failed on a real channel with a
          // bare "Expected double-quoted property name" parse error.
          maxOutputTokens: 8192,
          // Pure perception — "is there a face in this image" needs no
          // deliberation, and MINIMAL keeps a 12-image call from dominating the
          // pipeline's runtime.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });
      break;
    } catch (err) {
      lastErr = err;
      if (!isModelAvailabilityError(err)) throw err;
    }
  }

  if (!res) throw lastErr instanceof Error ? lastErr : new Error("no usable Gemini model for the vision pass");

  const finishReason = String(res.candidates?.[0]?.finishReason ?? "");
  const text = (res.text ?? "").trim();

  if (/MAX_TOKENS/i.test(finishReason)) {
    throw new Error("vision pass hit the output token ceiling and returned truncated JSON");
  }
  if (!text) {
    throw new Error(`empty vision response (finishReason: ${finishReason || "unknown"})`);
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  if (!Array.isArray(parsed)) throw new Error("vision pass did not return an array");

  return parsed.map((row: Record<string, unknown>) => {
    const out = {} as Record<TraitKey, boolean>;
    for (const t of TRAITS) out[t.key] = row?.[t.key] === true;
    return out;
  });
}
