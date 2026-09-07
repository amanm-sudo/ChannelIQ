"use client";

import { useState } from "react";

export interface DemoChannel {
  slug: string;
  title: string;
  handle: string;
  niche: string;
  subscribers: number;
  videoCount: number;
  competitorCount: number;
}

export interface Capabilities {
  liveMode: boolean;
  llmNarration: boolean;
  thumbnailPass: boolean;
  /** Model id in use, or null when running without an LLM key. */
  model: string | null;
  demoChannels: DemoChannel[];
}

interface Props {
  capabilities: Capabilities | null;
  running: boolean;
  onAnalyze: (channel: string, options: { preferSeed: boolean; competitors: string[] }) => void;
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export default function ChannelInput({ capabilities, running, onAnalyze }: Props) {
  const [value, setValue] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const liveMode = capabilities?.liveMode ?? false;
  const demos = capabilities?.demoChannels ?? [];

  const submit = (channel: string, preferSeed: boolean) => {
    const trimmed = channel.trim();
    if (!trimmed || running) return;
    onAnalyze(trimmed, {
      preferSeed,
      competitors: competitors
        .split(/[,\n]/)
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3),
    });
  };

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value, false);
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <div className="relative flex-1">
          <label htmlFor="channel" className="sr-only">
            YouTube channel handle or URL
          </label>
          <input
            id="channel"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={running}
            placeholder={liveMode ? "@handle, channel URL, or a bundled demo channel" : "Try a bundled demo channel below"}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-3 text-[15px] text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={running || !value.trim()}
          className="rounded-lg bg-accent px-6 py-3 text-[15px] font-semibold text-ink-950 transition hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Analysing..." : "Analyse channel"}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Or run a bundled demo channel:</span>
        {demos.map((d) => (
          <button
            key={d.slug}
            type="button"
            disabled={running}
            onClick={() => {
              setValue(d.slug);
              submit(d.slug, true);
            }}
            title={`${d.niche} · ${d.videoCount} uploads · ${d.competitorCount} competitor snapshots`}
            className="rounded-full border border-ink-600 bg-ink-850 px-3 py-1.5 text-xs text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
          >
            {d.title}
            <span className="ml-1.5 text-slate-500">{formatSubs(d.subscribers)}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Capability on={liveMode} onLabel="Live YouTube API" offLabel="Live API off (no YOUTUBE_API_KEY)" />
        <Capability
          on={capabilities?.llmNarration ?? false}
          onLabel={`${capabilities?.model ?? "Gemini"} narration`}
          offLabel="Deterministic writer (no GEMINI_API_KEY)"
        />
        <Capability on={capabilities?.thumbnailPass ?? false} onLabel="Thumbnail vision pass" offLabel="Thumbnail pass off" />

        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="ml-auto text-slate-500 underline decoration-dotted underline-offset-4 hover:text-slate-300"
        >
          {showAdvanced ? "Hide" : "Name competitors"}
        </button>
      </div>

      {showAdvanced && (
        <div className="mt-3 animate-ciq-rise">
          <label htmlFor="competitors" className="label">
            Competitor channels (optional, up to 3, comma separated)
          </label>
          <input
            id="competitors"
            type="text"
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
            disabled={running}
            placeholder="@competitor1, @competitor2"
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Leave this blank and ChannelIQ picks adjacent channels itself. Naming them is cheaper on API quota and
            usually more accurate, since you know your niche better than a keyword search does.
          </p>
        </div>
      )}
    </div>
  );
}

function Capability({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-500">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${on ? "bg-accent" : "bg-slate-600"}`}
      />
      <span className={on ? "text-slate-400" : "text-slate-600"}>{on ? onLabel : offLabel}</span>
    </span>
  );
}
