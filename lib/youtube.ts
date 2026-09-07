/**
 * Thin YouTube Data API v3 client.
 *
 * QUOTA STRATEGY (this is the part that matters):
 *   search.list costs 100 units per call. channels.list / playlistItems.list /
 *   videos.list cost 1 unit each. So the cheap path is always:
 *
 *     channels.list(forHandle|id)      1 unit  -> uploads playlist id
 *     playlistItems.list(playlistId)   1 unit  -> up to 50 video ids
 *     videos.list(id=<50 ids>)         1 unit  -> stats for all 50 at once
 *
 *   Total for a 50-video analysis: 3 units. The naive implementation
 *   (search.list + one videos.list per video) costs 150. We only fall back to
 *   search.list when the user gives us a free-text channel name we cannot
 *   resolve any other way, and we cache that resolution aggressively.
 *
 * Auth: API key only. No OAuth, no user data, public endpoints exclusively.
 */

import { cacheGet, cacheSet } from "./cache";
import type { ChannelRecord, VideoRecord } from "./types";

const API = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 12_000;

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly kind: "no_key" | "not_found" | "quota" | "forbidden" | "network" | "bad_response",
    readonly status?: number,
  ) {
    super(message);
    this.name = "YouTubeError";
  }
}

export function hasApiKey(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_API_KEY.trim());
}

/** Tracks quota spend for one pipeline run so the UI can show the real cost. */
export class QuotaMeter {
  units = 0;
  calls: Array<{ endpoint: string; units: number }> = [];
  spend(endpoint: string, units: number) {
    this.units += units;
    this.calls.push({ endpoint, units });
  }
}

const COST: Record<string, number> = {
  channels: 1,
  playlistItems: 1,
  videos: 1,
  search: 100,
};

async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  meter?: QuotaMeter,
): Promise<T> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new YouTubeError("YOUTUBE_API_KEY is not configured", "no_key");

  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, cache: "no-store" });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new YouTubeError(
      aborted ? `YouTube API timed out on ${endpoint}` : `Network error calling ${endpoint}`,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }

  meter?.spend(endpoint, COST[endpoint] ?? 1);

  if (!res.ok) {
    let reason = "";
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? "";
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 403 && /quota/i.test(reason)) {
      throw new YouTubeError("YouTube API daily quota exceeded", "quota", 403);
    }
    if (res.status === 403) {
      throw new YouTubeError(`YouTube API rejected the key (${reason || "forbidden"})`, "forbidden", 403);
    }
    if (res.status === 404) {
      throw new YouTubeError("Channel not found", "not_found", 404);
    }
    throw new YouTubeError(`YouTube API error ${res.status}${reason ? `: ${reason}` : ""}`, "bad_response", res.status);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export interface ParsedChannelInput {
  kind: "id" | "handle" | "legacy_username" | "query" | "video";
  value: string;
}

/**
 * Accepts anything a creator might paste:
 *   UC1234...                          -> id
 *   @mkbhd / mkbhd                     -> handle
 *   youtube.com/@mkbhd                 -> handle
 *   youtube.com/channel/UC...          -> id
 *   youtube.com/c/Name, /user/Name     -> legacy username
 *   youtube.com/watch?v=...            -> video (we resolve to its channel)
 *   "some channel name"                -> query (expensive path)
 */
export function parseChannelInput(raw: string): ParsedChannelInput {
  const input = raw.trim();
  if (!input) throw new YouTubeError("Please enter a channel handle or URL", "not_found");

  const looksLikeUrl = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(input);

  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(input.startsWith("http") ? input : `https://${input}`);
    } catch {
      throw new YouTubeError("That does not look like a valid YouTube URL", "not_found");
    }
    const segments = url.pathname.split("/").filter(Boolean);

    if (url.hostname.includes("youtu.be") && segments[0]) return { kind: "video", value: segments[0] };
    if (segments[0] === "watch") {
      const v = url.searchParams.get("v");
      if (v) return { kind: "video", value: v };
    }
    if (segments[0] === "shorts" && segments[1]) return { kind: "video", value: segments[1] };
    if (segments[0] === "channel" && segments[1]) return { kind: "id", value: segments[1] };
    if (segments[0] === "user" && segments[1]) return { kind: "legacy_username", value: segments[1] };
    if (segments[0] === "c" && segments[1]) return { kind: "legacy_username", value: segments[1] };
    if (segments[0]?.startsWith("@")) return { kind: "handle", value: segments[0].slice(1) };
    if (segments[0]) return { kind: "query", value: decodeURIComponent(segments[0]) };
    throw new YouTubeError("Could not find a channel in that URL", "not_found");
  }

  if (/^UC[\w-]{20,24}$/.test(input)) return { kind: "id", value: input };
  if (input.startsWith("@")) return { kind: "handle", value: input.slice(1) };
  // A bare token with no spaces is almost always a handle on modern YouTube.
  if (/^[\w.-]{3,60}$/.test(input)) return { kind: "handle", value: input };
  return { kind: "query", value: input };
}

// ---------------------------------------------------------------------------
// API shapes (only the fields we actually read)
// ---------------------------------------------------------------------------

interface ChannelsListResponse {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      description?: string;
      customUrl?: string;
      publishedAt?: string;
      country?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    statistics?: { viewCount?: string; subscriberCount?: string; videoCount?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
}

interface VideosListResponse {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      tags?: string[];
      channelId?: string;
      thumbnails?: Record<string, { url?: string; width?: number }>;
    };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

interface SearchListResponse {
  items?: Array<{
    id?: { channelId?: string; videoId?: string };
    snippet?: { channelId?: string; channelTitle?: string; title?: string };
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bestThumb(thumbs: Record<string, { url?: string; width?: number }> | undefined): string {
  if (!thumbs) return "";
  const order = ["maxres", "standard", "high", "medium", "default"];
  for (const k of order) if (thumbs[k]?.url) return thumbs[k].url as string;
  return Object.values(thumbs)[0]?.url ?? "";
}

/** ISO-8601 duration (PT1H2M3S) -> seconds. */
export function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0));
}

function toChannelRecord(item: NonNullable<ChannelsListResponse["items"]>[number]): ChannelRecord {
  const customUrl = item.snippet?.customUrl ?? null;
  return {
    channelId: item.id,
    handle: customUrl ? customUrl.replace(/^@/, "") : null,
    title: item.snippet?.title ?? "Unknown channel",
    description: item.snippet?.description ?? "",
    subscribers: Number(item.statistics?.subscriberCount ?? 0),
    totalViews: Number(item.statistics?.viewCount ?? 0),
    videoCount: Number(item.statistics?.videoCount ?? 0),
    thumbnailUrl: bestThumb(item.snippet?.thumbnails),
    publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
    country: item.snippet?.country ?? null,
  };
}

const CHANNEL_TTL = 24 * 60 * 60 * 1000;
const VIDEO_TTL = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface ResolvedChannel {
  record: ChannelRecord;
  uploadsPlaylistId: string | null;
}

async function channelsList(
  params: Record<string, string>,
  meter?: QuotaMeter,
): Promise<ResolvedChannel | null> {
  const res = await apiGet<ChannelsListResponse>(
    "channels",
    { part: "snippet,statistics,contentDetails", ...params },
    meter,
  );
  const item = res.items?.[0];
  if (!item) return null;
  return {
    record: toChannelRecord(item),
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

/** Resolve any user input to a channel, taking the cheapest path available. */
export async function resolveChannel(raw: string, meter?: QuotaMeter): Promise<ResolvedChannel> {
  const parsed = parseChannelInput(raw);
  const cacheKey = `yt:resolve:${parsed.kind}:${parsed.value.toLowerCase()}`;
  const hit = cacheGet<ResolvedChannel>(cacheKey);
  if (hit) return hit;

  let resolved: ResolvedChannel | null = null;

  switch (parsed.kind) {
    case "id":
      resolved = await channelsList({ id: parsed.value }, meter);
      break;

    case "handle":
      // forHandle is the modern 1-unit lookup for @handles.
      resolved = await channelsList({ forHandle: parsed.value }, meter);
      // A bare token might actually be a legacy username, so try that next.
      if (!resolved) resolved = await channelsList({ forUsername: parsed.value }, meter);
      break;

    case "legacy_username":
      resolved = await channelsList({ forUsername: parsed.value }, meter);
      if (!resolved) resolved = await channelsList({ forHandle: parsed.value }, meter);
      break;

    case "video": {
      const vres = await apiGet<VideosListResponse>("videos", { part: "snippet", id: parsed.value }, meter);
      const channelId = vres.items?.[0]?.snippet?.channelId;
      if (channelId) resolved = await channelsList({ id: channelId }, meter);
      break;
    }

    case "query":
      break; // handled below
  }

  // Last resort: the 100-unit fuzzy search.
  //
  // ONLY for free-text input. If the user gave us something that looks like a
  // specific identifier — an @handle, a /channel/UC… URL, a video link — and it
  // did not resolve, then it is wrong, and the honest answer is "not found".
  //
  // Falling back to search here was actively harmful: a mistyped handle
  // resolved to whatever channel the keyword search happened to rank first, and
  // the user got a complete, confident, professional-looking strategy report
  // about a channel they had never heard of. A clear error is strictly better
  // than a plausible wrong answer.
  if (!resolved && parsed.kind === "query") {
    const sres = await apiGet<SearchListResponse>(
      "search",
      { part: "snippet", type: "channel", maxResults: "1", q: parsed.value },
      meter,
    );
    const channelId = sres.items?.[0]?.id?.channelId ?? sres.items?.[0]?.snippet?.channelId;
    if (channelId) resolved = await channelsList({ id: channelId }, meter);
  }

  if (!resolved) {
    throw new YouTubeError(`No YouTube channel matched "${raw.trim()}"`, "not_found");
  }

  cacheSet(cacheKey, resolved, CHANNEL_TTL);
  return resolved;
}

/** Page the uploads playlist for the newest `limit` video ids. 1 unit / 50. */
export async function listRecentVideoIds(
  uploadsPlaylistId: string,
  limit: number,
  meter?: QuotaMeter,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const params: Record<string, string> = {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, limit - ids.length)),
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await apiGet<PlaylistItemsResponse>("playlistItems", params, meter);
    const page = (res.items ?? [])
      .map((i) => i.contentDetails?.videoId)
      .filter((v): v is string => Boolean(v));
    ids.push(...page);

    if (!res.nextPageToken || page.length === 0) break;
    pageToken = res.nextPageToken;
  }

  return ids.slice(0, limit);
}

/** videos.list in batches of 50 — never one call per video. 1 unit / batch. */
export async function fetchVideoDetails(ids: string[], meter?: QuotaMeter): Promise<VideoRecord[]> {
  const out: VideoRecord[] = [];

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await apiGet<VideosListResponse>(
      "videos",
      { part: "snippet,statistics,contentDetails", id: batch.join(",") },
      meter,
    );
    for (const item of res.items ?? []) {
      out.push({
        id: item.id,
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? "",
        publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
        durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        views: Number(item.statistics?.viewCount ?? 0),
        likes: Number(item.statistics?.likeCount ?? 0),
        comments: Number(item.statistics?.commentCount ?? 0),
        thumbnailUrl: bestThumb(item.snippet?.thumbnails),
        tags: item.snippet?.tags ?? [],
      });
    }
  }

  return out;
}

/** Full cheap-path fetch: channel + its newest N videos with stats. */
export async function fetchChannelVideos(
  raw: string,
  limit: number,
  meter?: QuotaMeter,
): Promise<{ record: ChannelRecord; videos: VideoRecord[] }> {
  const resolved = await resolveChannel(raw, meter);
  const cacheKey = `yt:videos:${resolved.record.channelId}:${limit}`;
  const hit = cacheGet<VideoRecord[]>(cacheKey);
  if (hit) return { record: resolved.record, videos: hit };

  if (!resolved.uploadsPlaylistId) {
    throw new YouTubeError(
      `"${resolved.record.title}" has no public uploads playlist to analyse`,
      "not_found",
    );
  }

  const ids = await listRecentVideoIds(resolved.uploadsPlaylistId, limit, meter);
  if (ids.length === 0) {
    throw new YouTubeError(`"${resolved.record.title}" has no public videos to analyse`, "not_found");
  }

  const videos = await fetchVideoDetails(ids, meter);
  videos.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  cacheSet(cacheKey, videos, VIDEO_TTL);
  return { record: resolved.record, videos };
}

/**
 * Suggest adjacent channels for the whitespace scan.
 * Costs 100 units, so it is cached for a day and only used when the user does
 * not name competitors themselves.
 */
export async function suggestCompetitorChannels(
  seedQuery: string,
  excludeChannelId: string,
  wanted: number,
  meter?: QuotaMeter,
): Promise<string[]> {
  const cacheKey = `yt:competitors:${excludeChannelId}:${seedQuery.toLowerCase()}:${wanted}`;
  const hit = cacheGet<string[]>(cacheKey);
  if (hit) return hit;

  const res = await apiGet<SearchListResponse>(
    "search",
    {
      part: "snippet",
      type: "video",
      order: "viewCount",
      maxResults: "25",
      relevanceLanguage: "en",
      q: seedQuery,
    },
    meter,
  );

  const seen = new Map<string, number>();
  for (const item of res.items ?? []) {
    const cid = item.snippet?.channelId;
    if (!cid || cid === excludeChannelId) continue;
    seen.set(cid, (seen.get(cid) ?? 0) + 1);
  }

  // A channel that shows up once in a keyword search is noise — the search
  // returns whatever is POPULAR for those words, not what is topically
  // adjacent. Requiring at least two hits filters most of that out, at the
  // cost of sometimes returning nothing, which is the right trade: a bad
  // competitor produces confidently wrong recommendations.
  const ranked = [...seen.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, wanted)
    .map(([cid]) => cid);

  cacheSet(cacheKey, ranked, CHANNEL_TTL);
  return ranked;
}
