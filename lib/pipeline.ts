/**
 * PIPELINE ORCHESTRATOR
 *
 * Runs the four agents in order and yields events as it goes, so the UI can
 * show the architecture executing in real time rather than a generic spinner.
 *
 *   [input] -> Data Collector -> Pattern Analysis -> Whitespace -> Thumbnails
 *                                                              -> Strategy Writer -> report
 *
 * Failure policy, which is the whole point of structuring it this way:
 *
 *   - Data Collector failing is FATAL. Without data there is nothing to say,
 *     and the user gets a specific, actionable error (plus demo suggestions).
 *   - Pattern Analysis failing is FATAL for the same reason.
 *   - Whitespace and Thumbnails failing are NON-FATAL. They are marked skipped
 *     or failed, and the P0 report renders complete without them.
 *   - Strategy Writer failing is NON-FATAL: it falls back to its deterministic
 *     twin internally, so it always returns something renderable.
 *
 * Net effect: there is no single point of failure that produces a blank screen.
 */

import { CollectorError, collectChannelData } from "./agents/dataCollector";
import { analyzePatterns } from "./agents/patternAnalyzer";
import { THUMBNAIL_MIN_BUDGET_MS, analyzeThumbnails } from "./agents/thumbnailAgent";
import { PRIMARY_MODEL, hasLlmKey, writeStrategy } from "./agents/strategyWriter";
import { findWhitespace } from "./agents/whitespaceAgent";
import { QuotaMeter, hasApiKey } from "./youtube";
import type {
  ChannelIQReport,
  PipelineEvent,
  ThumbnailReport,
  WhitespaceReport,
} from "./types";

export const REPORT_VERSION = "1.0.0";

/**
 * Total wall-clock budget for one analysis.
 *
 * Sized to sit safely inside the 60s serverless function ceiling declared in
 * app/api/analyze/route.ts, leaving headroom for streaming the response and any
 * platform overhead.
 *
 * This exists because the pipeline was unbounded. A real fresh run on a live
 * channel took 119.5s end to end — 101s of it inside the narration stage, where
 * the model walk on quota errors, 503 backoffs and the correction retry compose
 * multiplicatively. On a deployed function that request is simply killed, and
 * the user gets an error instead of a report.
 *
 * The budget makes the worst case bounded and the outcome always a report: the
 * optional stages stand down when there is no time for them, and the narration
 * falls back to the deterministic writer.
 */
export const PIPELINE_BUDGET_MS = 45_000;

export interface PipelineInput {
  channel: string;
  /** Absolute wall-clock deadline. Defaults to now + PIPELINE_BUDGET_MS. */
  deadlineAt?: number;
  /** Load the bundled snapshot instead of hitting the API. */
  preferSeed?: boolean;
  /** Competitor handles/URLs the user supplied. */
  competitors?: string[];
  sampleSize?: number;
  includeWhitespace?: boolean;
  includeThumbnails?: boolean;
  disableLlm?: boolean;
}

const NO_WHITESPACE: WhitespaceReport = {
  attempted: false,
  ok: false,
  competitors: [],
  gaps: [],
  sharedTopics: [],
  quotaUnits: 0,
  note: null,
};

const NO_THUMBNAILS: ThumbnailReport = {
  attempted: false,
  ok: false,
  sampled: 0,
  traits: [],
  guidance: null,
  strength: "inconclusive",
  note: null,
};

export async function* runPipeline(input: PipelineInput): AsyncGenerator<PipelineEvent> {
  const deadlineAt = input.deadlineAt ?? Date.now() + PIPELINE_BUDGET_MS;
  const remainingMs = () => deadlineAt - Date.now();

  const meter = new QuotaMeter();
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const logs: string[] = [];

  const log = (message: string) => {
    logs.push(message);
  };

  // ---- Stage 1: Data Collector (fatal on failure) ------------------------
  yield { type: "stage", stage: "collect", status: "start", detail: "Resolving the channel and pulling recent uploads" };
  let t0 = Date.now();

  let dataset;
  try {
    dataset = await collectChannelData(input.channel, {
      sampleSize: input.sampleSize,
      preferSeed: input.preferSeed,
      meter,
      onLog: log,
    });
  } catch (err) {
    if (err instanceof CollectorError) {
      yield { type: "stage", stage: "collect", status: "failed", detail: err.message, ms: Date.now() - t0 };
      yield { type: "error", message: err.message, recoverable: err.kind !== "empty_input" };
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "stage", stage: "collect", status: "failed", detail: message, ms: Date.now() - t0 };
    yield { type: "error", message: `Could not collect channel data: ${message}`, recoverable: true };
    return;
  }

  timings.collect = Date.now() - t0;
  warnings.push(...dataset.warnings);
  for (const m of logs.splice(0)) yield { type: "log", message: m };
  yield {
    type: "stage",
    stage: "collect",
    status: "ok",
    detail:
      `${dataset.videos.length} uploads from ${dataset.channel.title}` +
      (dataset.source === "seed" ? " (bundled snapshot)" : ` (live, ${meter.units} quota units)`),
    ms: timings.collect,
  };

  // ---- Stage 2: Pattern Analysis (fatal on failure) ---------------------
  yield {
    type: "stage",
    stage: "analyze",
    status: "start",
    detail: "Correlating titles, length, timing and topics against normalised performance",
  };
  t0 = Date.now();

  let signals;
  try {
    signals = analyzePatterns(dataset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "stage", stage: "analyze", status: "failed", detail: message, ms: Date.now() - t0 };
    yield { type: "error", message: `Pattern analysis failed: ${message}`, recoverable: true };
    return;
  }

  timings.analyze = Date.now() - t0;
  warnings.push(...signals.warnings.filter((w) => !warnings.includes(w)));
  yield {
    type: "stage",
    stage: "analyze",
    status: "ok",
    detail: `${signals.rankedFindings.length} findings across ${signals.topics.length} topic clusters`,
    ms: timings.analyze,
  };

  // ---- Stage 3: Competitor Whitespace (non-fatal) -----------------------
  let whitespace = NO_WHITESPACE;
  const wantWhitespace = input.includeWhitespace !== false;

  if (!wantWhitespace) {
    yield { type: "stage", stage: "whitespace", status: "skipped", detail: "Competitor scan turned off for this run" };
  } else {
    yield { type: "stage", stage: "whitespace", status: "start", detail: "Scanning adjacent channels for uncovered topics" };
    t0 = Date.now();
    try {
      whitespace = await findWhitespace(dataset, signals, {
        competitorInputs: input.competitors,
        seedSlugs: dataset.suggestedCompetitorSlugs,
        meter,
        onLog: log,
      });
      timings.whitespace = Date.now() - t0;
      for (const m of logs.splice(0)) yield { type: "log", message: m };
      yield {
        type: "stage",
        stage: "whitespace",
        status: whitespace.ok ? "ok" : "skipped",
        detail: whitespace.ok
          ? `${whitespace.gaps.length} gap${whitespace.gaps.length === 1 ? "" : "s"} across ${whitespace.competitors.length} competitor channel${whitespace.competitors.length === 1 ? "" : "s"}`
          : (whitespace.note ?? "Competitor scan unavailable"),
        ms: timings.whitespace,
      };
    } catch (err) {
      // Belt and braces: findWhitespace handles its own errors, but a crash here
      // must never take the report down.
      timings.whitespace = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      whitespace = { ...NO_WHITESPACE, attempted: true, note: `Competitor scan failed: ${message}` };
      yield { type: "stage", stage: "whitespace", status: "failed", detail: message, ms: timings.whitespace };
    }
  }

  // ---- Stage 3b: Thumbnails (non-fatal) ---------------------------------
  let thumbnails = NO_THUMBNAILS;
  const enoughTimeForThumbnails = remainingMs() >= THUMBNAIL_MIN_BUDGET_MS;
  const wantThumbnails =
    input.includeThumbnails !== false && !input.disableLlm && hasLlmKey() && enoughTimeForThumbnails;

  // The thumbnail pass is the most expensive optional stage (~15s for a vision
  // call over 15 images) and it feeds the lowest-confidence section of the
  // report. If the earlier stages have already used the budget, standing it down
  // to protect the narration is the right trade.
  if (hasLlmKey() && !input.disableLlm && input.includeThumbnails !== false && !enoughTimeForThumbnails) {
    thumbnails = {
      ...NO_THUMBNAILS,
      attempted: true,
      note: `The thumbnail pass was skipped to stay inside this request's time budget (${(remainingMs() / 1000).toFixed(0)}s left). Everything else in the report is unaffected.`,
    };
    yield {
      type: "stage",
      stage: "thumbnails",
      status: "skipped",
      detail: "Skipped to protect the request time budget",
    };
  } else if (!wantThumbnails) {
    thumbnails = {
      ...NO_THUMBNAILS,
      note: hasLlmKey()
        ? "Thumbnail analysis was turned off for this run."
        : "Thumbnail analysis needs GEMINI_API_KEY (it uses a multimodal model to detect visual traits).",
    };
    yield {
      type: "stage",
      stage: "thumbnails",
      status: "skipped",
      detail: hasLlmKey() ? "Turned off for this run" : "No GEMINI_API_KEY",
    };
  } else {
    yield { type: "stage", stage: "thumbnails", status: "start", detail: "Vision pass over a spread of thumbnails" };
    t0 = Date.now();
    try {
      // Reserve 18s of the budget for the narration, which matters more.
      thumbnails = await analyzeThumbnails(signals, { onLog: log, deadlineAt: deadlineAt - 18_000 });
      timings.thumbnails = Date.now() - t0;
      for (const m of logs.splice(0)) yield { type: "log", message: m };
      yield {
        type: "stage",
        stage: "thumbnails",
        status: thumbnails.ok ? "ok" : "skipped",
        detail: thumbnails.ok
          ? `${thumbnails.traits.length} trait${thumbnails.traits.length === 1 ? "" : "s"} correlated across ${thumbnails.sampled} thumbnails`
          : (thumbnails.note ?? "Thumbnail pass unavailable"),
        ms: timings.thumbnails,
      };
    } catch (err) {
      timings.thumbnails = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      thumbnails = { ...NO_THUMBNAILS, attempted: true, note: `Thumbnail pass failed: ${message}` };
      yield { type: "stage", stage: "thumbnails", status: "failed", detail: message, ms: timings.thumbnails };
    }
  }

  // ---- Stage 4: Strategy Writer (self-healing) --------------------------
  yield {
    type: "stage",
    stage: "write",
    status: "start",
    detail: input.disableLlm || !hasLlmKey() ? "Composing the action plan" : `Narrating the action plan with ${PRIMARY_MODEL}`,
  };
  t0 = Date.now();

  let strategy;
  try {
    strategy = await writeStrategy(signals, whitespace, thumbnails, {
      onLog: log,
      disableLlm: input.disableLlm,
      deadlineAt,
    });
  } catch (err) {
    // writeStrategy is designed never to throw. If it somehow does, fall back
    // to the deterministic writer directly rather than losing the whole report.
    const message = err instanceof Error ? err.message : String(err);
    const { writeStrategyDeterministic } = await import("./agents/strategyWriter");
    strategy = writeStrategyDeterministic(
      signals,
      whitespace,
      thumbnails,
      `The narration step crashed (${message}); this report was written deterministically from the same signals.`,
    );
  }

  timings.write = Date.now() - t0;
  for (const m of logs.splice(0)) yield { type: "log", message: m };
  yield {
    type: "stage",
    stage: "write",
    status: "ok",
    detail:
      strategy.generatedBy === "llm"
        ? `${strategy.concepts.length} concepts, all figures verified against the analysis`
        : `${strategy.concepts.length} concepts (deterministic writer)`,
    ms: timings.write,
  };

  // ---- Assemble ----------------------------------------------------------
  if (dataset.synthetic) {
    warnings.unshift(
      `${dataset.channel.title} is a bundled sample channel with synthetic data, included so ChannelIQ runs with no API keys. The analysis is real; the channel is not.`,
    );
  }
  if (dataset.source === "live" && !hasApiKey()) {
    warnings.push("Live mode ran without a verified API key.");
  }

  timings.total = Object.values(timings).reduce((a, b) => a + b, 0);

  const report: ChannelIQReport = {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    dataset: {
      channel: dataset.channel,
      source: dataset.source,
      fetchedAt: dataset.fetchedAt,
      sampleSize: signals.sampleSize,
      windowStart: signals.windowStart,
      windowEnd: signals.windowEnd,
      quotaUnits: meter.units,
    },
    signals,
    whitespace,
    thumbnails,
    strategy,
    warnings: [...new Set(warnings)],
    timings,
  };

  yield { type: "report", report };
  yield { type: "stage", stage: "done", status: "ok", detail: `Report ready in ${(timings.total / 1000).toFixed(1)}s`, ms: timings.total };
}

/** Convenience wrapper for non-streaming callers (scripts, tests). */
export async function runPipelineToCompletion(input: PipelineInput): Promise<ChannelIQReport> {
  let report: ChannelIQReport | null = null;
  let error: string | null = null;

  for await (const event of runPipeline(input)) {
    if (event.type === "report") report = event.report;
    if (event.type === "error") error = event.message;
  }

  if (!report) throw new Error(error ?? "Pipeline produced no report");
  return report;
}
