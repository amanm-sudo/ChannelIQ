/**
 * AGENT 3 — COMPETITOR WHITESPACE  (P1)
 *
 * Question it answers: what is working for the channels beating me, that I have
 * simply never made a video about?
 *
 * This is the part a creator cannot do for themselves in an afternoon, and it
 * is the reason ChannelIQ is not an analytics dashboard. Their own Studio
 * analytics can tell them which of their videos did well. Nothing in Studio can
 * tell them about the video they never made.
 *
 * ---------------------------------------------------------------------------
 * THE TEST FOR A REAL GAP (both conditions must hold)
 * ---------------------------------------------------------------------------
 *  1. RELATIVE: the topic out-performs the competitor's OWN channel median.
 *     Without this, every topic from a bigger channel looks like an opportunity
 *     purely because they have more subscribers than us. That would generate
 *     confident nonsense — "make videos about their sponsor read" — and is the
 *     single most likely way a competitor feature produces garbage.
 *
 *  2. ABSOLUTE: the topic's median beats OUR channel median by a real margin.
 *     A topic that only does 0.4x our median is not an opportunity even if it is
 *     a hit for them; it means their audience is different from ours.
 *
 * Plus a coverage test: we must have essentially not covered it (<= 1 video).
 *
 * Every failure path in here is non-fatal. If the whole agent throws, the P0
 * report still renders — whitespace is additive, never load-bearing.
 */

import { loadSeedCompetitor } from "./dataCollector";
import { tokenize, videoTerms } from "./patternAnalyzer";
import { SEED_DATASETS, seedEntry } from "@/data/seed";
import { formatCount, formatMultiple, gradeConfidence, median, probabilityOfSuperiority } from "@/lib/stats";
import { QuotaMeter, fetchChannelVideos, hasApiKey, suggestCompetitorChannels } from "@/lib/youtube";
import type {
  ChannelDataset,
  CompetitorSummary,
  GapOpportunity,
  PatternSignals,
  VideoRecord,
  WhitespaceReport,
} from "@/lib/types";

const COMPETITOR_SAMPLE = 30;
const MAX_COMPETITORS = 3;

export interface WhitespaceOptions {
  /** Handles/URLs the user typed in. Takes priority over auto-suggestion. */
  competitorInputs?: string[];
  /** Bundled snapshot slugs (demo mode). */
  seedSlugs?: string[];
  meter?: QuotaMeter;
  onLog?: (message: string) => void;
  /** Skip the 100-unit search.list auto-suggestion. */
  disableAutoSuggest?: boolean;
}

const EMPTY: WhitespaceReport = {
  attempted: false,
  ok: false,
  competitors: [],
  gaps: [],
  sharedTopics: [],
  quotaUnits: 0,
  note: null,
};

/** Build term -> video-indices for an arbitrary video list. */
function termIndex(videos: VideoRecord[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  videos.forEach((v, i) => {
    for (const term of videoTerms(v)) {
      const arr = map.get(term) ?? [];
      arr.push(i);
      map.set(term, arr);
    }
  });
  return map;
}

/** How many of OUR videos touch this term at all. */
function ourCoverage(ourTerms: Map<string, number[]>, term: string): number {
  const direct = ourTerms.get(term)?.length ?? 0;
  if (direct > 0) return direct;
  // A bigram we have never used verbatim may still be covered by its parts,
  // e.g. we have "docker" videos and they have "docker compose". Count the
  // rarest component so we do not claim a gap we have actually covered.
  const parts = term.split(" ");
  if (parts.length < 2) return 0;
  const counts = parts.map((p) => ourTerms.get(p)?.length ?? 0);
  return Math.min(...counts);
}

export async function findWhitespace(
  ourDataset: ChannelDataset,
  ourSignals: PatternSignals,
  options: WhitespaceOptions = {},
): Promise<WhitespaceReport> {
  const log = options.onLog ?? (() => {});
  const quotaBefore = options.meter?.units ?? 0;

  // ---- 1. Work out who to compare against ------------------------------
  const targets: Array<{ kind: "seed"; slug: string } | { kind: "live"; input: string }> = [];

  for (const input of options.competitorInputs ?? []) {
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (SEED_DATASETS[trimmed]) targets.push({ kind: "seed", slug: trimmed });
    else targets.push({ kind: "live", input: trimmed });
  }
  for (const slug of options.seedSlugs ?? []) {
    if (targets.length >= MAX_COMPETITORS) break;
    if (SEED_DATASETS[slug]) targets.push({ kind: "seed", slug });
  }

  // Auto-suggest only as a last resort: search.list costs 100 quota units.
  if (targets.length === 0 && hasApiKey() && !options.disableAutoSuggest) {
    try {
      const seedQuery = buildNicheQuery(ourSignals);
      log(`Searching for adjacent channels in "${seedQuery}"...`);
      const ids = await suggestCompetitorChannels(
        seedQuery,
        ourSignals.channel.channelId,
        MAX_COMPETITORS,
        options.meter,
      );
      for (const id of ids) targets.push({ kind: "live", input: id });
    } catch (err) {
      log(`Competitor auto-suggest unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (targets.length === 0) {
    return {
      ...EMPTY,
      attempted: true,
      ok: false,
      note: hasApiKey()
        ? "No competitor channels could be identified for this niche, so the whitespace scan was skipped."
        : "Competitor scanning needs a YOUTUBE_API_KEY, or a demo channel with bundled competitor snapshots.",
    };
  }

  // ---- 2. Load each competitor (independently failable) -----------------
  const loaded: Array<{ summary: CompetitorSummary; videos: VideoRecord[] }> = [];
  const failures: string[] = [];

  for (const target of targets.slice(0, MAX_COMPETITORS)) {
    try {
      let videos: VideoRecord[];
      let channelTitle: string;
      let channelId: string;
      let handle: string | null;
      let subscribers: number;
      let thumbnailUrl: string;

      if (target.kind === "seed") {
        const ds = loadSeedCompetitor(target.slug, COMPETITOR_SAMPLE);
        if (!ds) throw new Error(`unknown snapshot ${target.slug}`);
        videos = ds.videos;
        channelTitle = ds.channel.title;
        channelId = ds.channel.channelId;
        handle = ds.channel.handle;
        subscribers = ds.channel.subscribers;
        thumbnailUrl = ds.channel.thumbnailUrl;
        log(`Loaded competitor snapshot: ${channelTitle} (${videos.length} videos)`);
      } else {
        const res = await fetchChannelVideos(target.input, COMPETITOR_SAMPLE, options.meter);
        videos = res.videos.filter((v) => v.views > 0);
        channelTitle = res.record.title;
        channelId = res.record.channelId;
        handle = res.record.handle;
        subscribers = res.record.subscribers;
        thumbnailUrl = res.record.thumbnailUrl;
        log(`Scanned competitor: ${channelTitle} (${videos.length} videos)`);
      }

      if (videos.length < 6) {
        failures.push(`${channelTitle} has too few public uploads to compare`);
        continue;
      }

      const compMedian = median(videos.map((v) => v.views));
      loaded.push({
        summary: {
          channelId,
          title: channelTitle,
          handle,
          subscribers,
          thumbnailUrl,
          sampleSize: videos.length,
          medianViews: compMedian,
          viewRatio: ourSignals.medianViews > 0 ? compMedian / ourSignals.medianViews : 0,
        },
        videos,
      });
    } catch (err) {
      const name = target.kind === "seed" ? target.slug : target.input;
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (loaded.length === 0) {
    return {
      ...EMPTY,
      attempted: true,
      ok: false,
      quotaUnits: (options.meter?.units ?? 0) - quotaBefore,
      note: `Competitor scan could not complete (${failures.slice(0, 2).join("; ")}). The rest of the report is unaffected.`,
    };
  }

  // ---- 2b. Adjacency gate -----------------------------------------------
  //
  // Auto-suggestion runs a keyword search, and keyword searches return what is
  // POPULAR, not what is adjacent. A real run against a large tech channel
  // pulled in a prank channel and duly reported that channel's own presenter's
  // name as an uncovered "topic" at 3.4x. Statistically true, completely
  // useless.
  //
  // So a competitor has to earn its place: it must demonstrably cover at least
  // one subject this channel also covers. Sharing no topic at all means it is
  // not a competitor, it is just another channel.
  const ourTerms = termIndex(ourDataset.videos);
  const ourMedian = ourSignals.medianViews;
  const ourTopicKeywords = ourSignals.topics
    .slice(0, 8)
    .flatMap((t) => t.keywords.slice(0, 2))
    .filter(Boolean);

  const rejectedAsUnrelated: string[] = [];
  const rejectedAsSmaller: string[] = [];
  const adjacent = loaded.filter(({ summary, videos }) => {
    // User-named competitors are trusted: they know their niche better than a
    // keyword search does, and second-guessing them would be obnoxious.
    const userNamed = (options.competitorInputs ?? []).length > 0;
    if (userNamed) return true;

    /*
     * An auto-suggested channel must actually be OUT-PERFORMING us.
     *
     * The whole premise of this feature is "topics working for the creators
     * beating you". A channel whose median is below ours is not beating us, so
     * its topics are not opportunities — and its best topic can still clear the
     * per-gap 1.3x test on a single outlier, which is how a channel with 0.91x
     * our median ended up supplying three "gap opportunities" to a channel it
     * under-performs.
     *
     * Only applied to auto-suggested channels. If the user names a smaller
     * competitor deliberately, that is a legitimate thing to want.
     */
    if (summary.viewRatio > 0 && summary.viewRatio < 1.15) {
      rejectedAsSmaller.push(summary.title);
      return false;
    }

    const theirTerms = termIndex(videos);
    const shared = new Set(ourTopicKeywords.filter((kw) => (theirTerms.get(kw)?.length ?? 0) >= 2));
    // Two distinct shared subjects, not one. A single overlapping word is
    // routinely coincidence — one generic term was enough to let a prank
    // channel qualify as a competitor to a tech channel.
    if (shared.size < 2) {
      rejectedAsUnrelated.push(summary.title);
      return false;
    }
    return true;
  });

  if (adjacent.length === 0) {
    // State the ACTUAL reason each channel was dropped. An earlier version
    // always blamed topic overlap, which was simply untrue when the real reason
    // was that the channel was not out-performing this one.
    const reasons: string[] = [];
    if (rejectedAsUnrelated.length > 0) {
      reasons.push(
        `${rejectedAsUnrelated.join(", ")} do${rejectedAsUnrelated.length === 1 ? "es" : ""} not cover any subject this channel covers`,
      );
    }
    if (rejectedAsSmaller.length > 0) {
      reasons.push(
        `${rejectedAsSmaller.join(", ")} ${rejectedAsSmaller.length === 1 ? "is" : "are"} not out-performing this channel`,
      );
    }

    return {
      ...EMPTY,
      attempted: true,
      ok: false,
      competitors: loaded.map((l) => l.summary),
      quotaUnits: (options.meter?.units ?? 0) - quotaBefore,
      note:
        reasons.length > 0
          ? `Scanned ${loaded.length} channel${loaded.length === 1 ? "" : "s"} and used none of them: ${reasons.join("; ")}. Comparing against them would produce noise rather than opportunities — name competitors explicitly for a useful whitespace scan.`
          : "No comparable channels could be identified for this niche.",
    };
  }

  interface RawGap {
    term: string;
    competitor: CompetitorSummary;
    videos: VideoRecord[];
    topicMedian: number;
    relativeLift: number;
    multipleOfOurMedian: number;
    score: number;
    pSup: number;
    compRest: number;
  }

  const raw: RawGap[] = [];

  for (const { summary, videos } of adjacent) {
    const theirTerms = termIndex(videos);
    const minDocs = Math.max(3, Math.ceil(videos.length * 0.1));
    const maxDocs = Math.floor(videos.length * 0.7);

    // A channel's own name, handle or presenter's name is never a topic, but it
    // appears in their titles and tags constantly, so it looks exactly like one.
    const selfWords = new Set([
      ...tokenize(summary.title),
      ...tokenize(summary.handle ?? ""),
    ]);
    // Also match the name with spacing removed, because channels tag themselves
    // as one word: "Science and fun" brands itself "scienceandfun", which shares
    // no token with its own title and so slipped past the word-level check.
    const selfCollapsed = [summary.title, summary.handle ?? ""]
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((s) => s.length >= 5);

    for (const [term, indices] of theirTerms) {
      if (indices.length < minDocs || indices.length > maxDocs) continue;

      // Skip anything built entirely out of the competitor's own name.
      if (term.split(" ").every((w) => selfWords.has(w))) continue;
      const termCollapsed = term.replace(/[^a-z0-9]/g, "");
      if (selfCollapsed.some((n) => termCollapsed.includes(n) || n.includes(termCollapsed))) continue;

      // Coverage test: have we made this video already?
      if (ourCoverage(ourTerms, term) > 1) continue;

      const set = new Set(indices);
      const topicViews = indices.map((i) => videos[i].views);
      const restViews = videos.filter((_, i) => !set.has(i)).map((v) => v.views);
      if (restViews.length < 3) continue;

      const topicMedian = median(topicViews);
      const compChannelMedian = median(restViews);

      // Single-word topics are held to a higher standard than multi-word ones.
      //
      // This is not arbitrary. Detection works on vocabulary, so it finds terms
      // a channel has never *typed*, which is not the same as subjects it has
      // never *covered*. A broad channel trips this constantly: running against
      // a large tech reviewer, "tech" surfaced as an uncovered topic at 1.6x —
      // true as vocabulary, absurd as advice. Multi-word terms are inherently
      // more specific and suffer far less from it, so the weak signal gets the
      // strict thresholds and the strong signal keeps the normal ones.
      const isSpecific = term.includes(" ");
      const minRelativeLift = isSpecific ? 15 : 25;
      const minMultiple = isSpecific ? 1.3 : 1.8;

      // Condition 1 — relative: strong for THEM, not just "they are bigger".
      const relativeLift = compChannelMedian > 0 ? (topicMedian / compChannelMedian - 1) * 100 : 0;
      if (relativeLift < minRelativeLift) continue;

      // Condition 2 — absolute: worth more than our own typical video.
      const multipleOfOurMedian = ourMedian > 0 ? topicMedian / ourMedian : 0;
      if (multipleOfOurMedian < minMultiple) continue;

      const pSup = probabilityOfSuperiority(topicViews, restViews);

      raw.push({
        term,
        competitor: summary,
        videos: indices.map((i) => videos[i]),
        topicMedian,
        relativeLift,
        multipleOfOurMedian,
        pSup,
        compRest: restViews.length,
        // Prefer specific multi-word topics and larger evidence bases.
        //
        // The bigram bonus is deliberately large. A gap label becomes a video
        // title downstream, and a single-word topic makes a useless one:
        // "coding agents" is a video somebody can go and make, "agents" is not,
        // and a bare adjective like "expensive" is actively misleading.
        score:
          multipleOfOurMedian *
          Math.sqrt(indices.length) *
          (1 + relativeLift / 100) *
          (term.includes(" ") ? 1.7 : 1),
      });
    }
  }

  raw.sort((a, b) => b.score - a.score);

  // Merge near-duplicate gaps (same topic found under several terms, or by
  // more than one competitor) so the report shows distinct opportunities.
  const gaps: GapOpportunity[] = [];
  const claimedVideoIds = new Set<string>();
  const claimedTopics = new Set<string>();

  for (const g of raw) {
    if (gaps.length >= 4) break;

    const ids = g.videos.map((v) => v.id);
    const overlap = ids.filter((id) => claimedVideoIds.has(id)).length / ids.length;
    if (overlap > 0.5) continue;

    // Roll in evidence for the same topic found under other terms or by other
    // competitors. Two terms describe one topic when they point at mostly the
    // same videos, so we group on video overlap rather than on string equality.
    const idSet = new Set(ids);
    const siblings = raw.filter((r) => {
      if (r.term === g.term) return true;
      const shared = r.videos.filter((v) => idSet.has(v.id)).length;
      return shared / Math.min(r.videos.length, ids.length) >= 0.7;
    });

    // Display the most specific phrasing available: "coding agents" is a video
    // someone can actually make, "agents" is not.
    const displayTerm = [...new Set(siblings.map((s) => s.term))].sort(
      (a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length,
    )[0];

    // Two different term sets can collapse to the same display label. Video
    // overlap alone did not catch it: a real run listed the identical topic
    // twice, with different numbers, which reads as a bug even when both rows
    // are individually correct.
    if (claimedTopics.has(displayTerm)) continue;
    claimedTopics.add(displayTerm);
    const allVideos = [...new Map(siblings.flatMap((s) => s.videos).map((v) => [v.id, v])).values()];
    const competitorTitles = [...new Set(siblings.map((s) => s.competitor.title))];

    const best = allVideos.reduce((acc, v) => (v.views > acc.views ? v : acc), allVideos[0]);
    const bestOwner =
      siblings.find((s) => s.videos.some((v) => v.id === best.id))?.competitor.title ?? g.competitor.title;

    for (const id of ids) claimedVideoIds.add(id);

    const confidence = gradeConfidence(g.videos.length, g.compRest, g.relativeLift, g.pSup);

    // Every figure below must come from the MERGED sibling set, not from the
    // single seed term. Deriving the prose from `g` while deriving the evidence
    // bullets from `allVideos` let the two disagree (the report claimed one
    // median in a sentence and a different one in its own supporting bullet),
    // which is precisely the kind of internal contradiction that makes a reader
    // stop trusting every other number on the page.
    const mergedMedian = Math.round(median(allVideos.map((v) => v.views)));
    const mergedMultiple = ourMedian > 0 ? mergedMedian / ourMedian : 0;

    gaps.push({
      id: `gap:${displayTerm.replace(/\s+/g, "_")}`,
      topic: displayTerm,
      keywords: [...new Set(siblings.flatMap((s) => tokenize(s.term)))].slice(0, 6),
      competitorTitles,
      competitorVideoCount: allVideos.length,
      competitorMedianViews: mergedMedian,
      multipleOfOurMedian: Number(mergedMultiple.toFixed(2)),
      exampleTitle: best.title,
      exampleViews: best.views,
      exampleChannel: bestOwner,
      evidence: buildEvidence(
        {
          term: displayTerm,
          relativeLift: g.relativeLift,
          topicMedian: mergedMedian,
          multipleOfOurMedian: mergedMultiple,
        },
        competitorTitles,
        allVideos.length,
        ourMedian,
      ),
      confidence,
    });
  }

  // Shared topics: context that shows the comparison set is actually adjacent.
  const sharedTopics: string[] = [];
  for (const topic of ourSignals.topics.slice(0, 8)) {
    const primary = topic.keywords[0];
    if (!primary) continue;
    const covered = adjacent.some(({ videos }) => {
      const t = termIndex(videos);
      return (t.get(primary)?.length ?? 0) >= 2;
    });
    if (covered) sharedTopics.push(topic.label);
  }

  const notes: string[] = [];
  if (gaps.length === 0) {
    notes.push(
      `Scanned ${adjacent.length} adjacent channel${adjacent.length === 1 ? "" : "s"} and found no topic that beats this channel's median while being genuinely uncovered. That is a real answer: the niche is already well served here.`,
    );
  }
  if (rejectedAsUnrelated.length > 0) {
    notes.push(
      `Excluded ${rejectedAsUnrelated.join(", ")} from the comparison — ${rejectedAsUnrelated.length === 1 ? "it does" : "they do"} not cover any subject this channel covers, so ${rejectedAsUnrelated.length === 1 ? "it is" : "they are"} not a useful benchmark.`,
    );
  }
  if (rejectedAsSmaller.length > 0) {
    notes.push(
      `Excluded ${rejectedAsSmaller.join(", ")} — ${rejectedAsSmaller.length === 1 ? "its median is" : "their medians are"} at or below this channel's, so ${rejectedAsSmaller.length === 1 ? "it is not" : "they are not"} out-performing it and ${rejectedAsSmaller.length === 1 ? "its topics are" : "their topics are"} not opportunities.`,
    );
  }
  if (failures.length > 0) {
    notes.push(
      `${failures.length} channel${failures.length === 1 ? "" : "s"} could not be scanned; results are based on the ${adjacent.length} that succeeded.`,
    );
  }

  return {
    attempted: true,
    ok: true,
    competitors: adjacent.map((l) => l.summary),
    gaps,
    sharedTopics: sharedTopics.slice(0, 5),
    quotaUnits: (options.meter?.units ?? 0) - quotaBefore,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

function buildEvidence(
  g: { term: string; relativeLift: number; topicMedian: number; multipleOfOurMedian: number },
  competitorTitles: string[],
  videoCount: number,
  ourMedian: number,
): string {
  const who = competitorTitles.length === 1 ? competitorTitles[0] : `${competitorTitles[0]} and ${competitorTitles.length - 1} other`;
  return (
    `${who} ${competitorTitles.length === 1 ? "has" : "have"} ${videoCount} video${videoCount === 1 ? "" : "s"} on "${g.term}" ` +
    `with a median of ${formatCount(g.topicMedian)} views — ${formatMultiple(g.multipleOfOurMedian)} this channel's median of ${formatCount(ourMedian)}, ` +
    `and ${Math.round(g.relativeLift)}% above their own channel median. This channel has not covered it.`
  );
}

/** Cheap niche query from the channel's own strongest topics. */
function buildNicheQuery(signals: PatternSignals): string {
  const fromTopics = signals.topics
    .filter((t) => t.liftPct > 0)
    .slice(0, 2)
    .flatMap((t) => t.keywords.slice(0, 1));
  if (fromTopics.length > 0) return fromTopics.join(" ");
  return tokenize(signals.channel.description).slice(0, 4).join(" ") || signals.channel.title;
}

/** Bundled competitor slugs for a demo channel, if any. */
export function seedCompetitorsFor(slug: string | null): string[] {
  if (!slug) return [];
  return seedEntry(slug)?.competitors ?? [];
}
