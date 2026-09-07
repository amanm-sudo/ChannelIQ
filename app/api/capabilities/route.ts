/**
 * GET /api/capabilities
 *
 * Tells the client what this deployment can actually do, so the UI can be
 * honest up front instead of letting a user type a channel name and then
 * discover live mode is unavailable. Never leaks key values.
 */

import { DEMO_CHANNELS } from "@/data/seed";
import { PRIMARY_MODEL, hasLlmKey } from "@/lib/agents/strategyWriter";
import { hasApiKey } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    liveMode: hasApiKey(),
    llmNarration: hasLlmKey(),
    thumbnailPass: hasLlmKey(),
    // The model id is not a secret and letting the UI name it is more honest
    // than a generic "AI narration" badge.
    model: hasLlmKey() ? PRIMARY_MODEL : null,
    demoChannels: DEMO_CHANNELS.map((c) => ({
      slug: c.slug,
      title: c.title,
      handle: c.handle,
      niche: c.niche,
      subscribers: c.subscribers,
      videoCount: c.videoCount,
      competitorCount: c.competitors.length,
    })),
  });
}
