/**
 * Render a report as Markdown.
 *
 * Why Markdown rather than a PDF-generation dependency: it is the format a
 * creator actually wants — pasteable into Notion, a Google Doc, a Discord
 * message to an editor, or an email to a client. Combined with the print
 * stylesheet (which turns Ctrl+P into a clean PDF), it covers sharing and
 * export with zero extra dependencies and nothing that can fail at demo time.
 */

import { formatCount, formatMultiple, formatPct } from "./stats";
import type { ChannelIQReport } from "./types";

export function reportToMarkdown(report: ChannelIQReport): string {
  const { dataset, signals, strategy, whitespace, thumbnails } = report;
  const L: string[] = [];

  L.push(`# ChannelIQ — ${dataset.channel.title}`);
  L.push("");
  L.push(
    `**${strategy.headline}**`,
  );
  L.push("");
  L.push(
    `Analysis of the last ${dataset.sampleSize} uploads (${dataset.windowStart.slice(0, 10)} to ${dataset.windowEnd.slice(0, 10)}) · ` +
      `${formatCount(dataset.channel.subscribers)} subscribers · median ${formatCount(signals.medianViews)} views per video · ` +
      `generated ${report.generatedAt.slice(0, 10)}`,
  );
  L.push("");

  L.push(`## Diagnosis`);
  L.push("");
  L.push(strategy.diagnosis);
  L.push("");

  L.push(`## What to make next`);
  L.push("");
  for (const c of strategy.concepts) {
    L.push(`### ${c.rank}. ${c.title}`);
    L.push("");
    L.push(c.rationale);
    L.push("");
    if (c.evidence.length) {
      for (const e of c.evidence) L.push(`- ${e}`);
      L.push("");
    }
    L.push(`*Target length: ${c.suggestedLengthMinutes} · Format: ${c.format}*`);
    L.push("");
  }

  L.push(`## Packaging`);
  L.push("");
  L.push(`**Title formula:** ${strategy.titleFormula.formula}`);
  L.push("");
  L.push(strategy.titleFormula.reasoning);
  L.push("");
  L.push(`| | Title |`);
  L.push(`| --- | --- |`);
  L.push(`| Before | ${escapePipes(strategy.titleFormula.rewriteBefore)} |`);
  L.push(`| After | ${escapePipes(strategy.titleFormula.rewriteAfter)} |`);
  L.push("");
  L.push(`**Length:** ${strategy.lengthGuidance.band} — ${strategy.lengthGuidance.reasoning}`);
  L.push("");
  const timingCaveat: Record<typeof strategy.timingGuidance.evidence, string> = {
    day_and_hour: "",
    day_only: " *(the day comes from this channel's data; the hour is a general heuristic)*",
    heuristic: " *(general heuristic, not from this channel's data)*",
  };
  L.push(
    `**Timing:** ${strategy.timingGuidance.slot}${timingCaveat[strategy.timingGuidance.evidence]} — ${strategy.timingGuidance.reasoning}`,
  );
  L.push("");
  // Prefer the freshly computed guidance: a precomputed narration may have been
  // baked without a thumbnail pass, leaving the strategy copy null.
  const thumbGuidance = thumbnails.guidance ?? strategy.thumbnailGuidance;
  if (thumbGuidance) {
    const thumbCaveat: Record<typeof thumbnails.strength, string> = {
      directive: "",
      tentative: " *(a large effect, but too few thumbnails back it to clear the confidence bar)*",
      inconclusive: "",
    };
    L.push(`**Thumbnails:** ${thumbGuidance}${thumbnails.ok ? thumbCaveat[thumbnails.strength] : ""}`);
    L.push("");
  }

  if (strategy.avoid.length) {
    L.push(`## Stop doing`);
    L.push("");
    for (const a of strategy.avoid) L.push(`- **${a.what}** — ${a.why}`);
    L.push("");
  }

  L.push(`## Checklist for the next upload`);
  L.push("");
  strategy.nextUploadChecklist.forEach((c, i) => L.push(`${i + 1}. ${c}`));
  L.push("");

  L.push(`## Evidence`);
  L.push("");
  L.push(`### Title structures`);
  L.push("");
  L.push(`| Structure | Videos | Lift | Median views | Confidence |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const t of signals.titlePatterns) {
    L.push(`| ${t.label} | ${t.videoCount} | ${formatPct(t.liftPct)} | ${formatCount(t.medianViews)} | ${t.confidence} |`);
  }
  L.push("");

  L.push(`### Video length`);
  L.push("");
  L.push(`| Band | Videos | Lift | Median views | Confidence |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const b of signals.lengthBuckets) {
    L.push(`| ${b.label} | ${b.videoCount} | ${formatPct(b.liftPct)} | ${formatCount(b.medianViews)} | ${b.confidence} |`);
  }
  L.push("");

  L.push(`### Topics`);
  L.push("");
  L.push(`| Topic | Videos | Lift | Median views | Last covered | Confidence |`);
  L.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const t of signals.topics) {
    L.push(
      `| ${t.label} | ${t.videoCount} | ${formatPct(t.liftPct)} | ${formatCount(t.medianViews)} | ${t.daysSinceLastCovered ?? "—"} days ago | ${t.confidence} |`,
    );
  }
  L.push("");

  if (whitespace.ok) {
    L.push(`## Competitor whitespace`);
    L.push("");
    for (const c of whitespace.competitors) {
      L.push(
        `- **${c.title}** — ${formatCount(c.subscribers)} subscribers, median ${formatCount(c.medianViews)} views (${formatMultiple(c.viewRatio)} this channel's median), ${c.sampleSize} videos sampled`,
      );
    }
    L.push("");
    for (const g of whitespace.gaps) {
      L.push(`### Gap: ${g.topic}`);
      L.push("");
      L.push(g.evidence);
      L.push("");
      L.push(`Their best in this topic: "${g.exampleTitle}" — ${formatCount(g.exampleViews)} views on ${g.exampleChannel}.`);
      L.push("");
    }
    if (whitespace.note) {
      L.push(`*${whitespace.note}*`);
      L.push("");
    }
  }

  if (thumbnails.ok && thumbnails.traits.length) {
    L.push(`## Thumbnail traits`);
    L.push("");
    L.push(`| Trait | Thumbnails | Lift | Confidence |`);
    L.push(`| --- | --- | --- | --- |`);
    for (const t of thumbnails.traits) {
      L.push(`| ${t.label} | ${t.videoCount} | ${formatPct(t.liftPct)} | ${t.confidence} |`);
    }
    L.push("");
  }

  L.push(`## Method and caveats`);
  L.push("");
  L.push(
    `Performance is measured as an index: a video's views divided by the median views of its nearest neighbours by publish date. ` +
      `1.00 means typical for this channel at that moment, which removes the bias from video age and channel growth. ` +
      `Comparisons between title structures, topics and posting times also divide out the channel's video-length effect, ` +
      `because runtime is usually the strongest confounder. Lift figures are correlations within this channel's own history, not proven causes.`,
  );
  L.push("");
  L.push(
    `Timing uses ${signals.timezone.label}, inferred from ${signals.timezone.inferredFrom}.`,
  );
  L.push("");
  if (report.warnings.length) {
    for (const w of report.warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push(`Data source: ${dataset.source === "live" ? `live YouTube Data API v3 (${dataset.quotaUnits} quota units)` : "bundled snapshot"}. ${strategy.modelNote}`);
  L.push("");
  L.push(`---`);
  L.push(`Generated by ChannelIQ v${report.version}.`);

  return L.join("\n");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}
