"use client";

/**
 * Evidence visualisations.
 *
 * Deliberate split:
 *   - The lift comparisons are rendered as plain CSS/SVG bars. They are simple
 *     diverging bars; a charting library would add bundle weight and a React
 *     compatibility surface for no benefit, and CSS bars print cleanly in the
 *     PDF export where canvas-based charts often do not.
 *   - The performance scatter uses Recharts, because a real x/y plot with axes
 *     and a reference line is where a chart library actually earns its place.
 *
 * These charts are supporting evidence, not the product. They sit BELOW the
 * action plan on purpose: the creator gets the answer first and the proof
 * second.
 */

import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { WEEKDAY_SHORT, formatCount } from "@/lib/stats";
import type { Confidence, PatternSignals, ScoredVideo } from "@/lib/types";

// ---------------------------------------------------------------------------
// Diverging lift bars
// ---------------------------------------------------------------------------

export interface LiftRow {
  label: string;
  liftPct: number;
  videoCount: number;
  confidence: Confidence;
  note?: string;
}

const CONF_OPACITY: Record<Confidence, string> = {
  high: "opacity-100",
  medium: "opacity-70",
  low: "opacity-40",
};

export function LiftBars({ rows, emptyMessage }: { rows: LiftRow[]; emptyMessage: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] leading-relaxed text-slate-500">{emptyMessage}</p>;
  }

  const max = Math.max(30, ...rows.map((r) => Math.abs(r.liftPct)));

  return (
    <div className="space-y-2.5">
      {rows.map((row) => {
        const pct = (Math.abs(row.liftPct) / max) * 50; // % of full width, half each side
        const positive = row.liftPct >= 0;
        return (
          <div key={row.label} className="grid grid-cols-[1fr_auto] items-center gap-3">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] text-slate-300" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">n={row.videoCount}</span>
              </div>

              <div className="relative mt-1 h-3 rounded bg-ink-850" title={`${row.confidence} confidence`}>
                {/* Centre line = the rest of the channel. */}
                <div aria-hidden className="absolute left-1/2 top-0 h-full w-px bg-ink-600" />
                <div
                  className={`absolute top-0 h-full rounded ${
                    positive ? "bg-emerald-500" : "bg-rose-500"
                  } ${CONF_OPACITY[row.confidence]}`}
                  style={
                    positive
                      ? { left: "50%", width: `${pct}%` }
                      : { right: "50%", width: `${pct}%` }
                  }
                />
              </div>
              {row.note && <p className="mt-1 text-[11px] text-slate-500">{row.note}</p>}
            </div>

            <span
              className={`w-16 shrink-0 text-right font-mono text-[13px] font-semibold ${
                positive ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {positive ? "+" : ""}
              {row.liftPct.toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekday columns
// ---------------------------------------------------------------------------

export function WeekdayColumns({ signals }: { signals: PatternSignals }) {
  const rows = signals.timing.weekdayTotals;
  const max = Math.max(1.2, ...rows.map((r) => r.medianIndex));

  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height: 96 }}>
        {rows.map((row) => {
          const h = row.videoCount === 0 ? 0 : Math.max(3, (row.medianIndex / max) * 100);
          const strong = row.medianIndex >= 1.15 && row.videoCount >= 3;
          const weak = row.medianIndex < 0.85 && row.videoCount >= 3;
          return (
            <div key={row.weekday} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="font-mono text-[10px] text-slate-500">
                {row.videoCount ? row.medianIndex.toFixed(2) : "—"}
              </span>
              <div
                className={`w-full rounded-t ${
                  row.videoCount === 0
                    ? "bg-ink-800"
                    : strong
                      ? "bg-emerald-500/80"
                      : weak
                        ? "bg-rose-500/70"
                        : "bg-slate-600"
                }`}
                style={{ height: `${h}%` }}
                title={`${row.label}: ${row.videoCount} uploads, median index ${row.medianIndex.toFixed(2)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {rows.map((row) => (
          <div key={row.weekday} className="flex-1 text-center">
            <div className="text-[11px] text-slate-400">{WEEKDAY_SHORT[row.weekday]}</div>
            <div className="font-mono text-[10px] text-slate-600">{row.videoCount}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Median performance index per upload day in {signals.timezone.label}. 1.00 is a typical video for this channel
        at that point in time. Bars with fewer than 3 uploads are not conclusive.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Performance scatter — the chart that shows the normalisation working
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
  z: number;
  title: string;
  views: number;
  date: string;
}

export function PerformanceScatter({ videos }: { videos: ScoredVideo[] }) {
  const data: Point[] = videos.map((v) => ({
    x: Date.parse(v.publishedAt),
    y: Number(v.performanceIndex.toFixed(2)),
    z: Math.max(40, Math.min(400, v.views / 400)),
    title: v.title,
    views: v.views,
    date: v.publishedAt.slice(0, 10),
  }));

  const maxY = Math.max(2, ...data.map((d) => d.y));

  return (
    <div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
            <CartesianGrid stroke="#232833" strokeDasharray="2 4" />
            <XAxis
              type="number"
              dataKey="x"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) =>
                new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" })
              }
              tick={{ fill: "#64748b", fontSize: 11 }}
              stroke="#333a48"
              minTickGap={40}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, Math.ceil(maxY * 10) / 10]}
              tick={{ fill: "#64748b", fontSize: 11 }}
              stroke="#333a48"
              tickFormatter={(v: number) => `${v.toFixed(1)}x`}
            />
            <ZAxis type="number" dataKey="z" range={[24, 220]} />
            <ReferenceLine
              y={1}
              stroke="#4ade80"
              strokeDasharray="4 4"
              label={{ value: "typical", fill: "#4ade80", fontSize: 10, position: "insideTopRight" }}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Point;
                return (
                  <div className="max-w-xs rounded-lg border border-ink-600 bg-ink-950 p-3 shadow-xl">
                    <p className="text-[12px] font-medium leading-snug text-slate-100">{p.title}</p>
                    <p className="mt-1.5 font-mono text-[11px] text-slate-400">
                      {formatCount(p.views)} views · {p.y.toFixed(2)}x typical · {p.date}
                    </p>
                  </div>
                );
              }}
            />
            <Scatter data={data} fill="#60a5fa" fillOpacity={0.65} stroke="#93c5fd" strokeOpacity={0.5} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Every upload in the window, scored against the median of its nearest neighbours by publish date. Bubble size is
        raw views. Because each video is compared to its own moment in the channel&apos;s history, a 400-day-old video and
        a 4-day-old one sit on the same scale — which is the only way a title or topic effect becomes visible instead of
        being drowned out by video age.
      </p>
    </div>
  );
}
