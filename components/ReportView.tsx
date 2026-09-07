"use client";

/**
 * The deliverable.
 *
 * Reading order is the whole design: ANSWER -> PLAN -> PROOF.
 *   1. Headline + diagnosis   — what to change, in plain English.
 *   2. What to make next      — three numbered, justified concepts.
 *   3. Packaging              — title formula with a rewrite of their own title.
 *   4. Stop doing / checklist — the prescription.
 *   5. Evidence               — the charts, for anyone who wants to audit it.
 *   6. Method and caveats     — how the numbers were derived, honestly.
 *
 * Charts sit near the bottom on purpose. A creator opening this does not want to
 * interpret a chart, they want to be told what to do and then be able to check
 * the working.
 */

import { useState } from "react";

import { LiftBars, PerformanceScatter, WeekdayColumns, type LiftRow } from "./charts";
import { Callout, ConfidenceChip, SectionHeading, Stat } from "./ui";
import { formatCount, formatDuration, formatMultiple, formatPct } from "@/lib/stats";
import { reportToMarkdown } from "@/lib/reportMarkdown";
import type { ChannelIQReport, VideoConcept } from "@/lib/types";

const KIND_LABEL: Record<VideoConcept["kind"], { text: string; className: string }> = {
  proven_vein: {
    text: "Proven on your channel",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  whitespace: {
    text: "Competitor gap",
    className: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  },
  underserved_topic: {
    text: "Underserved",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  },
};

export default function ReportView({ report, onReset }: { report: ChannelIQReport; onReset: () => void }) {
  const { dataset, signals, strategy, whitespace, thumbnails } = report;
  const [copied, setCopied] = useState(false);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  const titleRows: LiftRow[] = signals.titlePatterns.map((t) => ({
    label: t.label,
    liftPct: t.liftPct,
    videoCount: t.videoCount,
    confidence: t.confidence,
    note: `median ${formatCount(t.medianViews)} views · ${Math.round(t.pSuperiority * 100)}% of head-to-head comparisons favour it`,
  }));

  const lengthRows: LiftRow[] = signals.lengthBuckets.map((b) => ({
    label: b.label,
    liftPct: b.liftPct,
    videoCount: b.videoCount,
    confidence: b.confidence,
    note: `median ${formatCount(b.medianViews)} views`,
  }));

  const topicRows: LiftRow[] = signals.topics.slice(0, 8).map((t) => ({
    label: t.label,
    liftPct: t.liftPct,
    videoCount: t.videoCount,
    confidence: t.confidence,
    note:
      `median ${formatCount(t.medianViews)} views` +
      (t.daysSinceLastCovered !== null ? ` · last covered ${t.daysSinceLastCovered} days ago` : ""),
  }));

  return (
    <div className="space-y-10">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">Content strategy report</span>
              <span
                className={`chip ${
                  dataset.source === "live"
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-slate-500/40 bg-slate-500/10 text-slate-400"
                }`}
              >
                {dataset.source === "live" ? "Live YouTube data" : "Bundled snapshot"}
              </span>
              <span
                className={`chip ${
                  strategy.generatedBy === "llm"
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                    : "border-slate-500/40 bg-slate-500/10 text-slate-400"
                }`}
                title={strategy.modelNote}
              >
                {strategy.generatedBy === "llm" ? "LLM narration, figures verified" : "Deterministic writer"}
              </span>
            </div>
            <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-slate-50">
              {dataset.channel.title}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Last {dataset.sampleSize} uploads · {dataset.windowStart.slice(0, 10)} to{" "}
              {dataset.windowEnd.slice(0, 10)} · {formatCount(dataset.channel.subscribers)} subscribers
              {dataset.source === "live" && ` · ${dataset.quotaUnits} API quota units`}
            </p>
          </div>

          <div className="no-print flex shrink-0 gap-2">
            <button
              type="button"
              onClick={copyMarkdown}
              className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
            >
              {copied ? "Copied to clipboard" : "Copy as Markdown"}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
            >
              Save as PDF
            </button>
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
            >
              New analysis
            </button>
          </div>
        </div>

        {report.warnings.length > 0 && (
          <div className="mt-4 space-y-2">
            {report.warnings.map((w, i) => (
              <Callout key={i} tone={i === 0 && dataset.source === "seed" ? "info" : "note"}>
                {w}
              </Callout>
            ))}
          </div>
        )}
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* 1. The answer                                                    */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-6">
          <div className="label text-accent/70">The one thing to change</div>
          <p className="mt-2 text-xl font-medium leading-snug text-slate-50">{strategy.headline}</p>
          <div className="mt-4 border-t border-accent/20 pt-4 prose-report">
            <p>{strategy.diagnosis}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Median views"
            value={formatCount(signals.medianViews)}
            hint="Median across the analysed window. Medians, not averages — one viral video would distort a mean badly."
          />
          <Stat
            label="Trend"
            value={`${signals.trend.direction} ${formatPct(signals.trend.changePct)}`}
            hint={`Newest third of the window (${formatCount(signals.trend.recentMedianViews)} median) against the oldest third (${formatCount(signals.trend.earlierMedianViews)}), adjusted for the fact that older videos have had longer to accumulate views. Confidence: ${signals.trend.confidence}.`}
          />
          <Stat
            label="Cadence"
            value={`${signals.cadence.uploadsPerMonth}/mo`}
            hint={`Median ${signals.cadence.medianDaysBetweenUploads} days between uploads, longest gap ${signals.cadence.longestGapDays} days, schedule consistency ${signals.cadence.consistencyScore} of 1.00.`}
          />
          <Stat
            label="Engagement"
            value={`${(signals.medianLikeRate * 100).toFixed(1)}% likes`}
            hint={`Median like rate. Median comment rate is ${(signals.medianCommentRate * 100).toFixed(2)}%.`}
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. What to make next                                             */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          index="01"
          title="What to make next"
          subtitle="Ranked by how much evidence sits behind them. Every rationale cites figures computed from this channel's own uploads."
        />

        <div className="space-y-4">
          {strategy.concepts.map((c) => {
            const kind = KIND_LABEL[c.kind];
            return (
              <article key={c.rank} className="card">
                <div className="flex items-start gap-4">
                  <span className="mt-0.5 shrink-0 font-mono text-2xl font-semibold text-accent/40">
                    {String(c.rank).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`chip ${kind.className}`}>{kind.text}</span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {c.suggestedLengthMinutes} · {c.format}
                      </span>
                    </div>
                    <h3 className="mt-2 text-lg font-medium leading-snug text-slate-50">{c.title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{c.rationale}</p>

                    {c.evidence.length > 0 && (
                      <ul className="mt-3 space-y-1 border-l-2 border-ink-700 pl-3">
                        {c.evidence.map((e, i) => (
                          <li key={i} className="font-mono text-[11.5px] leading-relaxed text-slate-500">
                            {e}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Packaging                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          index="02"
          title="How to package it"
          subtitle="Title structure, runtime and publish slot — each derived from what has already worked on this channel."
        />

        <div className="card">
          <div className="label">Title formula</div>
          <p className="mt-1.5 font-mono text-[15px] text-accent">{strategy.titleFormula.formula}</p>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-300">{strategy.titleFormula.reasoning}</p>

          <div className="mt-4 overflow-hidden rounded-lg border border-ink-700">
            <div className="border-b border-ink-700 bg-ink-850 px-4 py-3">
              <div className="label">One of your own recent titles</div>
              <p className="mt-1 text-[15px] text-slate-400 line-through decoration-rose-500/60">
                {strategy.titleFormula.rewriteBefore}
              </p>
            </div>
            <div className="bg-ink-900 px-4 py-3">
              <div className="label text-accent/70">Rewritten with your winning formula</div>
              <p className="mt-1 text-[15px] font-medium text-slate-50">{strategy.titleFormula.rewriteAfter}</p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Target length: {strategy.titleFormula.targetCharCount} · this channel&apos;s median title is{" "}
            {signals.titleLength.channelMedianChars} characters
          </p>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="card">
            <div className="label">Runtime</div>
            <p className="mt-1.5 text-lg font-medium text-slate-50">{strategy.lengthGuidance.band}</p>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-400">{strategy.lengthGuidance.reasoning}</p>
          </div>

          <div className="card">
            <div className="flex items-start justify-between gap-2">
              <div className="label">Publish slot</div>
              {/* Three states, three labels. A single "is/is not a heuristic"
                  chip could not describe the common middle case, where the day
                  is a real finding but the hour is not. */}
              {strategy.timingGuidance.evidence === "heuristic" && (
                <span
                  className="chip border-amber-500/40 bg-amber-500/10 text-amber-300"
                  title="This channel's uploads are spread too thinly across the week to identify a winning slot from its own history."
                >
                  general heuristic
                </span>
              )}
              {strategy.timingGuidance.evidence === "day_only" && (
                <span
                  className="chip border-amber-500/40 bg-amber-500/10 text-amber-300"
                  title="The day is supported by this channel's own data. The time of day is not — there are too few uploads per time-of-day slot to separate one window from another."
                >
                  day from your data, hour is a heuristic
                </span>
              )}
              {strategy.timingGuidance.evidence === "day_and_hour" && (
                <span
                  className="chip border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  title="Both the day and the time window come from this channel's own upload history."
                >
                  from your data
                </span>
              )}
            </div>
            <p className="mt-1.5 text-lg font-medium text-slate-50">{strategy.timingGuidance.slot}</p>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-400">{strategy.timingGuidance.reasoning}</p>
          </div>
        </div>

        {/* Rendered whenever the pass ran, even when it found nothing. "We
            looked and your thumbnail style is not the bottleneck" is a useful
            answer; silently omitting the section makes the work invisible and
            leaves the reader unsure whether it ran. */}
        {(strategy.thumbnailGuidance || thumbnails.attempted) && (
          <div className="card mt-4">
            <div className="flex items-start justify-between gap-2">
              <div className="label">Thumbnails</div>
              {/* Same three-state treatment as the publish slot. The wording of
                  the sentence below is already hedged to match this grade; the
                  chip makes the strength scannable rather than something the
                  reader has to infer from tone. */}
              {thumbnails.ok && thumbnails.strength === "tentative" && (
                <span
                  className="chip border-amber-500/40 bg-amber-500/10 text-amber-300"
                  title="A large effect, but too few thumbnails back it to clear the confidence bar. Treat it as a test, not a rule."
                >
                  worth testing, data is thin
                </span>
              )}
              {thumbnails.ok && thumbnails.strength === "inconclusive" && (
                <span
                  className="chip border-slate-500/40 bg-slate-500/10 text-slate-400"
                  title="No visual trait separates strongly enough to act on. That is a real answer, not a missing one."
                >
                  nothing conclusive
                </span>
              )}
              {thumbnails.ok && thumbnails.strength === "directive" && (
                <span
                  className="chip border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  title="This effect clears the confidence bar for the sampled thumbnails."
                >
                  clears the confidence bar
                </span>
              )}
            </div>
            {/* Read from `thumbnails`, not `strategy`. The strategy copy can be
                served from a precomputed narration baked without a thumbnail
                pass, in which case it is null while this request genuinely has
                thumbnail results. The freshly computed value is the truth. */}
            <p className="mt-1.5 text-[15px] leading-relaxed text-slate-300">
              {thumbnails.guidance ??
                strategy.thumbnailGuidance ??
                thumbnails.note ??
                "The thumbnail pass did not run for this report."}
            </p>
            {thumbnails.ok && thumbnails.traits.length > 0 && (
              <div className="mt-4">
                <LiftBars
                  rows={thumbnails.traits.map((t) => ({
                    label: t.label,
                    liftPct: t.liftPct,
                    videoCount: t.videoCount,
                    confidence: t.confidence,
                  }))}
                  emptyMessage="No thumbnail trait split the sample cleanly enough to report."
                />
                <p className="mt-2 text-[11px] text-slate-500">
                  Across {thumbnails.sampled} thumbnails sampled from across the performance range. A multimodal model
                  detected the visual traits; the correlation with views was computed in code.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 4. Stop doing + checklist                                        */}
      {/* ---------------------------------------------------------------- */}
      {(strategy.avoid.length > 0 || strategy.nextUploadChecklist.length > 0) && (
        <section className="grid gap-4 lg:grid-cols-2">
          {strategy.avoid.length > 0 && (
            <div>
              <SectionHeading index="03" title="Stop doing" subtitle="Patterns that measurably cost this channel views." />
              <div className="card space-y-4">
                {strategy.avoid.map((a, i) => (
                  <div key={i} className={i > 0 ? "border-t border-ink-700 pt-4" : ""}>
                    <p className="text-[15px] font-medium text-slate-100">{a.what}</p>
                    <p className="mt-1 text-[14px] leading-relaxed text-slate-400">{a.why}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <SectionHeading index="04" title="Checklist for the next upload" subtitle="Work top to bottom." />
            <ol className="card space-y-3">
              {strategy.nextUploadChecklist.map((c, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-accent">{i + 1}</span>
                  <span className="text-[14px] leading-relaxed text-slate-300">{c}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 5. Competitor whitespace                                         */}
      {/* ---------------------------------------------------------------- */}
      <section className="print-break">
        <SectionHeading
          index="05"
          title="Competitor whitespace"
          subtitle="Topics that out-perform on adjacent channels — measured against their own median, not just their subscriber count — that this channel has never covered."
        />

        {whitespace.ok ? (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              {whitespace.competitors.map((c) => (
                <div key={c.channelId} className="card-tight print-plain">
                  <p className="truncate text-sm font-medium text-slate-100" title={c.title}>
                    {c.title}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    {formatCount(c.subscribers)} subs · median {formatCount(c.medianViews)}
                  </p>
                  <p className="mt-1.5 font-mono text-sm text-slate-300">
                    {formatMultiple(c.viewRatio)}
                    <span className="ml-1 text-[11px] text-slate-500">your median</span>
                  </p>
                </div>
              ))}
            </div>

            {whitespace.gaps.length > 0 ? (
              <div className="space-y-3">
                {whitespace.gaps.map((g) => (
                  <div key={g.id} className="card">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-base font-medium text-slate-50">{g.topic}</h3>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-violet-300">
                          {formatMultiple(g.multipleOfOurMedian)} your median
                        </span>
                        <ConfidenceChip confidence={g.confidence} />
                      </div>
                    </div>
                    <p className="mt-2 text-[14px] leading-relaxed text-slate-300">{g.evidence}</p>
                    <p className="mt-2 border-l-2 border-ink-700 pl-3 text-[13px] text-slate-500">
                      Their best in this topic: &ldquo;{g.exampleTitle}&rdquo; — {formatCount(g.exampleViews)} views on{" "}
                      {g.exampleChannel}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <Callout tone="note">{whitespace.note}</Callout>
            )}

            {whitespace.gaps.length > 0 && whitespace.note && (
              <div className="mt-3">
                <Callout tone="note">{whitespace.note}</Callout>
              </div>
            )}

            {whitespace.sharedTopics.length > 0 && (
              <p className="mt-3 text-[12px] text-slate-500">
                Topics both this channel and its comparison set already cover: {whitespace.sharedTopics.join(", ")}.
                These are shown to confirm the comparison set is genuinely adjacent rather than a random keyword match.
              </p>
            )}
          </>
        ) : (
          <Callout tone="note">
            {whitespace.note ?? "The competitor scan did not run for this report. Everything above is unaffected."}
          </Callout>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 6. Evidence                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section className="print-break">
        <SectionHeading
          index="06"
          title="The evidence"
          subtitle="Every recommendation above traces back to these numbers. Bars show median performance against the rest of the channel; bar opacity reflects how much evidence sits behind each row."
        />

        <div className="card">
          <div className="label mb-3">Performance across the window</div>
          <PerformanceScatter videos={signals.scoredVideos} />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="card">
            <div className="label mb-3">Title structure</div>
            <LiftBars
              rows={titleRows}
              emptyMessage="No title structure appears on enough videos to compare yet. It needs at least 3 uploads per structure."
            />
          </div>

          <div className="card">
            <div className="label mb-3">Video length</div>
            <LiftBars rows={lengthRows} emptyMessage="Not enough uploads per length band to compare." />
          </div>

          <div className="card">
            <div className="label mb-3">Topics</div>
            <LiftBars rows={topicRows} emptyMessage="No topic cluster reached the minimum of 3 videos." />
          </div>

          <div className="card">
            <div className="label mb-3">Upload day</div>
            <WeekdayColumns signals={signals} />
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="card">
            <div className="label mb-3">Best performers</div>
            <VideoTable videos={signals.topPerformers} />
          </div>
          <div className="card">
            <div className="label mb-3">Weakest performers</div>
            <VideoTable videos={signals.underPerformers} />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 7. Method                                                        */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading index="07" title="Method and caveats" />
        <div className="card space-y-3 text-[13px] leading-relaxed text-slate-400">
          <p>
            <span className="font-medium text-slate-300">Performance index.</span> A video&apos;s views divided by the
            median views of its 8-12 nearest neighbours by publish date. 1.00 means typical for this channel at that
            moment. This cancels out two biases that would otherwise dominate: older videos have had longer to
            accumulate views, and the channel was a different size when they went out.
          </p>
          <p>
            <span className="font-medium text-slate-300">Confounder control.</span> Comparisons between title
            structures, topics and posting slots are computed after dividing out this channel&apos;s video-length
            effect. Runtime is usually the strongest driver of performance and it correlates with everything else, so
            without this step &ldquo;long videos win&rdquo; can masquerade as &ldquo;this topic wins&rdquo;.
          </p>
          <p>
            <span className="font-medium text-slate-300">Confidence.</span> Graded from cohort size and a rank-based
            effect size (the share of head-to-head comparisons a cohort wins), not from a p-value. Anything under 3
            videos is never reported. Low-confidence findings are shown but flagged, because a confident
            recommendation drawn from 3 uploads is worse than no recommendation.
          </p>
          <p>
            <span className="font-medium text-slate-300">These are correlations.</span> Within one channel&apos;s
            history, with no control group. They describe what has coincided with better performance here, which is a
            reasonable basis for what to test next — not proof of cause.
          </p>
          <p>
            <span className="font-medium text-slate-300">Timing.</span> All weekday and hour figures use{" "}
            {signals.timezone.label}, inferred from {signals.timezone.inferredFrom}.
          </p>
          <p className="border-t border-ink-700 pt-3 text-[12px] text-slate-500">
            {strategy.modelNote} Data source:{" "}
            {dataset.source === "live"
              ? `live YouTube Data API v3, ${dataset.quotaUnits} quota units, fetched ${dataset.fetchedAt.slice(0, 16).replace("T", " ")}Z`
              : "bundled snapshot"}
            . Pipeline completed in {(report.timings.total / 1000).toFixed(1)}s. ChannelIQ v{report.version}.
          </p>
        </div>
      </section>
    </div>
  );
}

function VideoTable({ videos }: { videos: ChannelIQReport["signals"]["scoredVideos"] }) {
  if (videos.length === 0) return <p className="text-[13px] text-slate-500">No videos to show.</p>;
  return (
    <ul className="space-y-2.5">
      {videos.map((v) => (
        <li key={v.id} className="flex items-start gap-3">
          <span
            className={`mt-0.5 w-12 shrink-0 text-right font-mono text-[12px] font-semibold ${
              v.performanceIndex >= 1 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {v.performanceIndex.toFixed(2)}x
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] text-slate-300" title={v.title}>
              {v.title}
            </p>
            <p className="font-mono text-[11px] text-slate-500">
              {formatCount(v.views)} views · {formatDuration(v.durationSeconds)} ·{" "}
              {v.publishedAt.slice(0, 10)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
