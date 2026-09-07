"use client";

/**
 * Live view of the agent pipeline.
 *
 * This is not a decorative spinner: every row is driven by a real event
 * streamed from the server as that agent starts and finishes, including the
 * elapsed milliseconds and whether a stage was skipped and why. It doubles as
 * the architecture diagram — a viewer understands the system by watching it
 * run — and it means a slow stage looks like progress rather than a hang.
 */

import type { PipelineStageId } from "@/lib/types";

export interface StageState {
  status: "pending" | "start" | "ok" | "skipped" | "failed";
  detail: string;
  ms?: number;
}

export const STAGE_ORDER: PipelineStageId[] = ["collect", "analyze", "whitespace", "thumbnails", "write"];

export const STAGE_META: Record<PipelineStageId, { name: string; agent: string; llm: boolean }> = {
  collect: { name: "Fetching uploads", agent: "Data Collector Agent", llm: false },
  analyze: { name: "Analysing patterns", agent: "Pattern Analysis Agent", llm: false },
  whitespace: { name: "Scanning competitors", agent: "Whitespace Agent", llm: false },
  thumbnails: { name: "Reading thumbnails", agent: "Thumbnail Agent", llm: true },
  write: { name: "Writing strategy", agent: "Strategy Writer Agent", llm: true },
  done: { name: "Done", agent: "", llm: false },
};

const ICON: Record<StageState["status"], string> = {
  pending: "○",
  start: "◔",
  ok: "●",
  skipped: "◌",
  failed: "✕",
};

const COLOR: Record<StageState["status"], string> = {
  pending: "text-slate-600",
  start: "text-accent animate-ciq-pulse",
  ok: "text-accent",
  skipped: "text-slate-500",
  failed: "text-rose-400",
};

export default function PipelineProgress({
  stages,
  logs,
}: {
  stages: Record<string, StageState>;
  logs: string[];
}) {
  return (
    <div className="card animate-ciq-rise" role="status" aria-live="polite">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Agent pipeline</h2>
        <span className="font-mono text-[11px] text-slate-500">4 agents · 1 LLM call at the end</span>
      </div>

      <ol className="space-y-0">
        {STAGE_ORDER.map((id, i) => {
          const state = stages[id] ?? { status: "pending" as const, detail: "" };
          const meta = STAGE_META[id];
          return (
            <li key={id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={`font-mono text-sm leading-6 ${COLOR[state.status]}`} aria-hidden>
                  {ICON[state.status]}
                </span>
                {i < STAGE_ORDER.length - 1 && (
                  <span
                    aria-hidden
                    className={`w-px flex-1 ${state.status === "ok" ? "bg-accent/30" : "bg-ink-700"}`}
                  />
                )}
              </div>

              <div className="flex-1 pb-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={`text-sm font-medium ${
                      state.status === "pending" ? "text-slate-600" : "text-slate-200"
                    }`}
                  >
                    {meta.name}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">{meta.agent}</span>
                  {meta.llm && (
                    <span className="chip border-violet-500/30 bg-violet-500/10 text-violet-300">LLM</span>
                  )}
                  {state.ms !== undefined && (
                    <span className="ml-auto font-mono text-[11px] text-slate-500">{state.ms}ms</span>
                  )}
                </div>
                {state.detail && (
                  <p
                    className={`mt-0.5 text-[13px] leading-snug ${
                      state.status === "failed" ? "text-rose-300" : "text-slate-500"
                    }`}
                  >
                    {state.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {logs.length > 0 && (
        <div className="mt-1 max-h-28 overflow-y-auto rounded-md border border-ink-700 bg-ink-950 p-3">
          {logs.slice(-6).map((line, i) => (
            <p key={i} className="font-mono text-[11px] leading-relaxed text-slate-500">
              <span className="text-slate-700">$ </span>
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
