/**
 * POST /api/analyze
 *
 * Streams newline-delimited JSON PipelineEvents as the agents run, so the
 * client can render the pipeline live and then the report. NDJSON rather than
 * SSE because the payload is one-way, potentially large, and NDJSON is trivial
 * to parse off a fetch ReadableStream with no extra client library.
 *
 * The stream never terminates on an unhandled throw: any error is serialised as
 * a final {type:"error"} event so the UI always has something to render.
 */

import type { NextRequest } from "next/server";

import { runPipeline } from "@/lib/pipeline";
import type { PipelineEvent } from "@/lib/types";

// Node runtime: the pipeline uses node:fs for the disk cache and Buffer for the
// thumbnail vision pass.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 60 seconds, chosen because it is valid on EVERY Vercel plan and compute mode.
 *
 * The Hobby plan caps function duration at 60s (10s default, configurable up to
 * 60). Fluid compute raises that to 300s and is the default for new projects,
 * but a value above the plan's ceiling risks failing the deployment outright —
 * and a deploy that will not build is a far worse outcome than an occasional
 * slow request, so this takes the value that cannot fail.
 *
 * Headroom against measured runtimes:
 *   - bundled demo channels (precomputed narration):  0.1 - 0.7s
 *   - live channel, cached:                           ~2 - 5s
 *   - live channel, fresh LLM + thumbnail vision:     20 - 35s typical
 *   - worst observed (fresh call plus a correction):  ~49s
 *
 * If you are on Fluid compute you can raise this to 300 for more margin on that
 * worst case. Either way a timeout is handled: the client renders the error
 * state with one-click demo-channel recovery rather than hanging.
 */
export const maxDuration = 60;

interface AnalyzeBody {
  channel?: unknown;
  preferSeed?: unknown;
  competitors?: unknown;
  sampleSize?: unknown;
  includeWhitespace?: unknown;
  includeThumbnails?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export async function POST(req: NextRequest) {
  const requestStartedAt = Date.now();
  let body: AnalyzeBody;
  try {
    body = (await req.json()) as AnalyzeBody;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const channel = typeof body.channel === "string" ? body.channel.trim() : "";
  if (!channel) {
    return Response.json({ error: "Provide a channel handle or URL in the `channel` field." }, { status: 400 });
  }
  // Guard against someone pasting an essay into the box.
  if (channel.length > 300) {
    return Response.json({ error: "That input is too long to be a channel handle or URL." }, { status: 400 });
  }

  const sampleSizeRaw = Number(body.sampleSize);
  const sampleSize = Number.isFinite(sampleSizeRaw) ? Math.min(50, Math.max(10, Math.round(sampleSizeRaw))) : undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PipelineEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        for await (const event of runPipeline({
          channel,
          // Derived from maxDuration so the two can never drift apart. The
          // reserve covers streaming the final report and platform overhead.
          deadlineAt: requestStartedAt + (maxDuration - 12) * 1000,
          preferSeed: body.preferSeed === true,
          competitors: asStringArray(body.competitors),
          sampleSize,
          includeWhitespace: body.includeWhitespace !== false,
          includeThumbnails: body.includeThumbnails !== false,
        })) {
          send(event);
        }
      } catch (err) {
        // Last line of defence. The client is guaranteed a terminal event.
        send({
          type: "error",
          message: `The analysis pipeline stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
