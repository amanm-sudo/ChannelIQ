/** Shared presentational atoms. Kept tiny and dependency-free. */

import type { Confidence } from "@/lib/types";

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};

const CONFIDENCE_TITLE: Record<Confidence, string> = {
  high: "Strong evidence: a large cohort, a big effect, and consistent head-to-head wins.",
  medium: "Moderate evidence: the effect is real in this sample but the cohort is small.",
  low: "Weak evidence: too few videos to separate this from chance. Treat it as a test, not a finding.",
};

export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`chip ${CONFIDENCE_STYLE[confidence]}`} title={CONFIDENCE_TITLE[confidence]}>
      {confidence} confidence
    </span>
  );
}

export function LiftBadge({ value, suffix = "" }: { value: number; suffix?: string }) {
  const positive = value >= 0;
  return (
    <span
      className={`font-mono text-sm font-semibold ${positive ? "text-emerald-400" : "text-rose-400"}`}
      title="Median performance of this group versus every video outside it, after normalising for video age, channel growth and runtime."
    >
      {positive ? "+" : ""}
      {value.toFixed(0)}%{suffix}
    </span>
  );
}

export function SectionHeading({
  index,
  title,
  subtitle,
  id,
}: {
  index?: string;
  title: string;
  subtitle?: string;
  id?: string;
}) {
  return (
    <div className="mb-4" id={id}>
      <div className="flex items-baseline gap-3">
        {index && <span className="font-mono text-xs text-accent">{index}</span>}
        <h2 className="text-lg font-semibold tracking-tight text-slate-100">{title}</h2>
      </div>
      {subtitle && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">{subtitle}</p>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card-tight print-plain" title={hint}>
      <div className="label">{label}</div>
      <div className="mt-1.5 font-mono text-base text-slate-100">{value}</div>
    </div>
  );
}

export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "note";
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-sky-500/30 bg-sky-500/[0.07] text-sky-200",
    warn: "border-amber-500/30 bg-amber-500/[0.07] text-amber-200",
    note: "border-ink-700 bg-ink-850 text-slate-400",
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-[13px] leading-relaxed ${styles}`}>{children}</div>;
}
