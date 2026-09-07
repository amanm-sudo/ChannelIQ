"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import ChannelInput, { type Capabilities } from "@/components/ChannelInput";
import PipelineProgress, { STAGE_ORDER, type StageState } from "@/components/PipelineProgress";
import ReportView from "@/components/ReportView";
import { Callout } from "@/components/ui";
import type { ChannelIQReport, PipelineEvent } from "@/lib/types";

type Phase = "idle" | "running" | "done" | "error";

interface ErrorState {
  message: string;
  recoverable: boolean;
}

export default function Home() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [report, setReport] = useState<ChannelIQReport | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setCapabilities(data as Capabilities);
      })
      .catch(() => {
        // A failed capability probe must not block the app: fall back to a
        // conservative assumption (demo-only) rather than showing nothing.
        if (!cancelled) {
          setCapabilities({
            liveMode: false,
            llmNarration: false,
            thumbnailPass: false,
            model: null,
            demoChannels: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setStages({});
    setLogs([]);
    setReport(null);
    setError(null);
  }, []);

  const analyze = useCallback(
    async (channel: string, options: { preferSeed: boolean; competitors: string[] }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      /*
       * Client-side ceiling, independent of the server's own time budget.
       *
       * Defensive rather than a fix for anything observed. The server bounds its
       * own work, but nothing here bounds the WAIT, so a stalled connection — a
       * killed function, a dropped socket, an intermediary holding the stream
       * open with no data — would leave the pipeline animation running forever.
       * A stuck spinner is the worst state this UI can be in, so the client
       * enforces its own limit and falls into the error state with one-click
       * demo recovery.
       *
       * 90s sits well above the server's ~48s budget, so a legitimately slow
       * analysis is never cut off by the client first.
       */
      const hardStop = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), 90_000);

      setPhase("running");
      setStages(Object.fromEntries(STAGE_ORDER.map((s) => [s, { status: "pending", detail: "" }])));
      setLogs([]);
      setReport(null);
      setError(null);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel,
            preferSeed: options.preferSeed,
            competitors: options.competitors,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `The server returned ${res.status}.`);
        }
        if (!res.body) throw new Error("The server sent an empty response.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalReport: ChannelIQReport | null = null;
        let streamError: ErrorState | null = null;

        const handle = (event: PipelineEvent) => {
          if (event.type === "stage") {
            if (event.stage === "done") return;
            setStages((prev) => ({
              ...prev,
              [event.stage]: { status: event.status, detail: event.detail, ms: event.ms },
            }));
          } else if (event.type === "log") {
            setLogs((prev) => [...prev, event.message]);
          } else if (event.type === "report") {
            finalReport = event.report;
          } else if (event.type === "error") {
            streamError = { message: event.message, recoverable: event.recoverable };
          }
        };

        // NDJSON: one JSON object per line, so we buffer until a newline.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handle(JSON.parse(line) as PipelineEvent);
            } catch {
              // A partial or malformed line is skipped rather than killing the
              // whole run; the terminal event still decides the outcome.
            }
          }
        }
        if (buffer.trim()) {
          try {
            handle(JSON.parse(buffer) as PipelineEvent);
          } catch {
            /* ignore trailing fragment */
          }
        }

        if (finalReport) {
          setReport(finalReport);
          setPhase("done");
        } else {
          setError(
            streamError ?? {
              message: "The analysis finished without producing a report. Try a bundled demo channel.",
              recoverable: true,
            },
          );
          setPhase("error");
        }
      } catch (err) {
        // A deliberate abort (user started another run, or navigated) is silent.
        // A timeout is not: it needs to surface as a recoverable error.
        if (err instanceof DOMException && err.name === "AbortError") return;

        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        setError({
          message: timedOut
            ? "The analysis took too long to respond and was stopped. This usually means the live YouTube or Gemini API is being slow. A bundled demo channel runs the identical pipeline instantly."
            : err instanceof Error
              ? err.message
              : "Something went wrong running the analysis.",
          recoverable: true,
        });
        setPhase("error");
      } finally {
        clearTimeout(hardStop);
      }
    },
    [],
  );

  const showReport = phase === "done" && report;

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
      {/* ------------------------------------------------------------- */}
      {/* Masthead — hidden once a report is on screen so the report is  */}
      {/* the whole page.                                               */}
      {/* ------------------------------------------------------------- */}
      {!showReport && (
        <header className="mb-8">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="h-6 w-1.5 rounded-full bg-accent" />
            <span className="text-lg font-semibold tracking-tight text-slate-50">ChannelIQ</span>
            <span className="chip border-ink-600 bg-ink-850 text-slate-400">AI content strategist</span>
          </div>

          <h1 className="mt-6 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-slate-50 sm:text-4xl">
            Stop guessing what to make next.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-400">
            Paste in a YouTube channel. ChannelIQ runs four agents over its real upload history and a live scan of the
            creators beating it, then hands back a numbered, justified plan for the next video — the kind of thing a
            consultant charges for, in under a minute.
          </p>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            It is not a dashboard. There are charts, but they are the proof, not the product.
          </p>
        </header>
      )}

      {!showReport && (
        <div className="card mb-8">
          <ChannelInput capabilities={capabilities} running={phase === "running"} onAnalyze={analyze} />
        </div>
      )}

      {phase === "running" && <PipelineProgress stages={stages} logs={logs} />}

      {phase === "error" && error && (
        <div className="space-y-4">
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-5">
            <div className="label text-rose-300/70">Could not produce a report</div>
            <p className="mt-2 text-[15px] leading-relaxed text-rose-100">{error.message}</p>
          </div>

          {(capabilities?.demoChannels.length ?? 0) > 0 && (
            <div className="card">
              <p className="text-sm text-slate-400">
                Every bundled demo channel runs the identical pipeline with no API calls, so you can always get to a
                full report:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {capabilities?.demoChannels.map((d) => (
                  <button
                    key={d.slug}
                    type="button"
                    onClick={() => analyze(d.slug, { preferSeed: true, competitors: [] })}
                    className="rounded-full border border-ink-600 bg-ink-850 px-3 py-1.5 text-xs text-slate-300 transition hover:border-accent/50 hover:text-accent"
                  >
                    Run {d.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {stages.collect?.status === "failed" && (
            <PipelineProgress stages={stages} logs={logs} />
          )}
        </div>
      )}

      {showReport && report && <ReportView report={report} onReset={reset} />}

      {phase === "idle" && (
        <section className="mt-10 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <HowItWorks
              step="01"
              title="Collect"
              body="Resolves the channel and pulls up to 50 recent uploads with stats, on the 3-quota-unit path rather than the 150-unit one."
            />
            <HowItWorks
              step="02"
              title="Analyse"
              body="Pure computation, no LLM. Scores every video against its nearest neighbours in time, then correlates titles, runtime, topics and posting slots against it."
            />
            <HowItWorks
              step="03"
              title="Write"
              body="One LLM call narrates the pre-computed findings. Every figure it prints is verified against the analysis before it reaches the page."
            />
          </div>

          <Callout tone="note">
            Bundled demo channels are synthetic sample data, clearly labelled as such in the report, so the app runs
            end-to-end with no API keys. Live mode analyses any real channel you paste in.
          </Callout>
        </section>
      )}
    </main>
  );
}

function HowItWorks({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <div className="card-tight">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-accent">{step}</span>
        <span className="text-sm font-medium text-slate-200">{title}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}
