# ChannelIQ — the AI content strategist

**Paste in a YouTube channel. In under a minute, get a data-backed report on exactly what to make next, when to post it, and how to title it — grounded in that channel's own upload history and a live scan of the creators beating it in its niche.**

ChannelIQ is not an analytics dashboard. There are charts, but they sit at the bottom of the report as *proof*. The product is the prescription at the top.

---

## The problem

A creator between 1K and 500K subscribers has plenty of data and no time to mine it. YouTube Studio will happily tell them which of their videos did well. It will not tell them:

- that their number-led titles out-perform their plain statements by 94% on their own channel,
- that their 10–20 minute videos beat everything else by 84% while their sub-5-minute videos are 46% *down*,
- that the topic they've quietly stopped making is their strongest one,
- or anything at all about **the video they never made** — the topic that's printing views for three adjacent channels and that they've never touched.

That last one is the important one, and it is structurally impossible for their own analytics to answer.

So ChannelIQ answers the question a creator actually has, which is not "how did I do?" but **"what should I make next, and why?"**

---

## Architecture

Four agents. Only the last one touches an LLM.

```
                          ┌──────────────────────────┐
   user types a handle ──▶ │  1. DATA COLLECTOR AGENT │──▶ YouTube Data API v3
                          │  dataCollector.ts        │    (API key only, public
                          └────────────┬─────────────┘     endpoints, no OAuth)
                                       │ ChannelDataset
                                       │ (up to 50 uploads + stats, cached)
                                       ▼
                          ┌──────────────────────────┐
                          │ 2. PATTERN ANALYSIS AGENT│   ← NO LLM. Pure maths.
                          │  patternAnalyzer.ts      │
                          └────────────┬─────────────┘
                                       │ PatternSignals
                                       │ (ranked, number-bearing findings)
                          ┌────────────┴─────────────┐
                          ▼                          ▼
            ┌──────────────────────────┐  ┌────────────────────────┐
            │ 3a. WHITESPACE AGENT     │  │ 3b. THUMBNAIL AGENT    │
            │  whitespaceAgent.ts      │  │  thumbnailAgent.ts     │
            │  → YouTube API           │  │  → Gemini vision       │
            │  NO LLM                  │  │  (perception only)     │
            └────────────┬─────────────┘  └───────────┬────────────┘
                         │ WhitespaceReport            │ ThumbnailReport
                         └──────────────┬──────────────┘
                                        ▼
                          ┌──────────────────────────┐
                          │ 4. STRATEGY WRITER AGENT │   ← the ONLY LLM call
                          │  strategyWriter.ts       │      for generation
                          └────────────┬─────────────┘
                                       │ StrategyReport
                                       ▼
                          ┌──────────────────────────┐
                          │  Report renderer / UI    │
                          └──────────────────────────┘
```

Orchestrated by `lib/pipeline.ts`, which yields events as each stage runs. The UI renders those events live, so the pipeline animation in the browser is the real execution trace — stage names, outcomes and millisecond timings — not a decorative spinner.

### The design decision that matters most

**Only the last agent generates prose, and it is never allowed to do arithmetic.**

Everything upstream is deterministic. By the time the Strategy Writer runs, every fact already exists as a computed number with a confidence grade attached. The LLM is handed a compact JSON briefing and told to narrate it. That boundary is *enforced*, not merely requested:

1. **Server-enforced structured output.** Gemini's `responseSchema` constrains the response shape at the API level, so a malformed report is not a failure mode that can occur. It is still validated on arrival, because a schema guarantees structure and says nothing about content.
2. **A numeric claim guard** (`verifyNumericClaims` in `strategyWriter.ts`). Every number in the model's prose is checked against the set of numbers it was actually given, with tolerance for legitimate rounding (`137248` → `"137K"`, `"137,000"`, `"137.2K"`). An unverifiable figure triggers one corrective retry that names the specific violations, then a hard fall back. See [Testing the guard](#testing-the-guard) — it is not provider-neutral and is tested as such.
3. **A deterministic twin.** `writeStrategyDeterministic()` produces the same report shape from the same signals with no LLM at all. It is built *first* on every run and supplies the fallback for any failure and the default for any field the model omits — so there is no code path that renders a partial report.
4. **`rewriteBefore` is never taken from the model.** The "here's your own title, rewritten" comparison uses a real title pulled from the channel's data. A paraphrased "before" would make the whole demonstration worthless.

A hallucinated view count in a report a creator might act on is worse than no report at all.

---

## The analysis: why the numbers are trustworthy

This is the part that separates ChannelIQ from a chart wrapper, so it is worth being explicit.

### Raw view counts are not comparable, and naive correlation measures the wrong thing

A video published 400 days ago has had 100× longer to accumulate views than one published 4 days ago. Simultaneously, the channel was *smaller* back then. Those two biases point in opposite directions. Correlating raw views against title style mostly measures **when** a video was published.

So every video is scored against a **local baseline**:

```
performanceIndex = views / median(views of its 8–12 nearest neighbours by publish date)
```

1.00 means "typical for this channel at that moment". Because neighbours share roughly the same age *and* roughly the same channel size, dividing by that baseline cancels both biases at once.

Chosen over fitting a global `views ~ age` regression because it needs no assumed functional form for the view curve (which differs per niche), is robust to viral outliers, tracks channel growth instead of assuming it away, and behaves sanely at n=20 where a regression would over-fit. The cost — the index is trend-free by construction — is why the trend metric is computed separately from raw view medians.

### Runtime is a confounder, and ignoring it produces confident nonsense

Video length is usually the strongest single driver of performance on a channel, and it correlates with everything else: the deep-dives are long, the quick tips are short. Left uncontrolled, "Docker videos win" may just be "long videos win" wearing a disguise — and telling a creator to make more Docker videos when the real lever was runtime is exactly the kind of plausible, wrong advice that destroys trust.

So comparisons of titles, topics and posting slots run on an **adjusted index** with the channel's length-bucket effect divided out (shrunk toward 1.0 in proportion to how little data backs each bucket). Length comparisons themselves use the raw index — adjusting for the length effect and then measuring it would be circular.

### Confidence, not p-values

Every cohort comparison carries a **rank-based effect size**: the probability that a randomly chosen video in the cohort beats a randomly chosen video outside it (the backbone of the Mann-Whitney U test). It is interpretable enough to print directly — "85% of head-to-head comparisons favour these titles" — and a single viral outlier cannot fake it.

Confidence is graded from cohort size plus that effect size. Cohorts under 3 videos are never reported at all. Low-confidence findings are shown but flagged, and the Strategy Writer is instructed to hedge them explicitly. A tool that confidently says "post on Thursdays" off the back of two videos is worse than useless, and any judge who has run a channel will spot it instantly.

### Timing is honest about what it doesn't know

Three tiers, degrading gracefully, carried in a three-state `timingGuidance.evidence` field:

| `evidence` | Meaning |
| --- | --- |
| `day_and_hour` | Both the weekday and the 3-hour window come from this channel's history |
| `day_only` | The weekday is a real finding; there are too few uploads per time-of-day slot to call an hour, so the hour is a general heuristic |
| `heuristic` | The channel's data says nothing about timing; the whole recommendation is a starting point to test |

The middle state is why this is not a boolean, and getting that wrong was a real bug. It was `isHeuristic: boolean`, which forced "the day holds up but the hour doesn't" into `false` — so the flag said "this is evidenced" while the prose beside it said the hour was a heuristic. Both halves are true simultaneously and a boolean cannot say so.

The slot label now carries the actionable slot only; caveats live in `evidence`, where they cannot be lost when a string is reformatted. The UI, the Markdown export and the CLI each render the caveat from that field.

**The model supplies none of this.** It writes the `reasoning` prose and nothing else — `slot` and `evidence` are computed facts and are not in the response schema at all, so there is no path by which the model can restate them. Earlier versions let it, and it did exactly what you would expect: it returned "Thursday morning" on a channel where the hour was explicitly unsupported, and it moved the evidence flag differently on two channels that were in identical situations. `npm run guard` asserts the grade equals ours and that the prose agrees with the grade.

### An imperative has to be earned

The same discipline applies to the thumbnail card, via `ThumbnailReport.strength`:

| `strength` | Wording |
| --- | --- |
| `directive` | Clears the confidence bar with ≥5 of the sampled thumbnails behind it. An instruction is fine: "cut it" |
| `tentative` | A large effect that does not clear the bar. "…only 4 of 15 sampled thumbnails back that… worth testing rather than treating as a rule" |
| `inconclusive` | Nothing separates enough to act on. "…thumbnail style is not this channel's bottleneck" |

This card previously issued a flat imperative unconditionally. A trait backed by 8 of 12 thumbnails at *low* confidence read as "— cut it.", identical in tone to findings with real sample sizes behind them. Four separate defects were involved, all found by running real channels:

1. **The confidence grade was ignored when choosing the wording.** Fixed: a directive now requires `confidence !== low`.
2. **Traits were ranked by raw `|liftPct|`**, so an n=3 noise spike outranked an n=6 medium-confidence effect. Fixed: ranked by the same evidence weight the Pattern Analysis Agent uses (`|lift| × log(1+n) × confidence`).
3. **The "not your bottleneck" outcome was effectively dead code** — the bar was `|lift| ≥ 15` with no confidence requirement, which at n≈12 across 5 traits noise almost always clears. It fired on 0 of 4 real channels. Fixed and now covered by a test that asserts it is reachable.
4. **The model could rewrite the sentence**, reopening the laundering path closed for the timing slot. Fixed: pinned from the analysis, and removed from the response schema.

Two supporting changes: the sample rose from 12 to 16 thumbnails, because `gradeConfidence` needs ≥14 videos before `high` is arithmetically possible and the previous sample capped every thumbnail finding at `medium`; and a directive additionally requires a cohort of ≥5, since `medium` is awarded from 4 and "4 of 16" is a thin basis for telling someone to change how they make thumbnails.

All three branches are exercised on live channels, and the wording rules are pinned by tests against constructed trait sets rather than whatever a live channel happens to produce — which is why the original bug was invisible.

Timezone is inferred from the channel's declared country, falling back to its modal publishing hour, and the report always states which was used.

### The whitespace test has two conditions, both required

A gap only counts when:

1. **Relative** — the topic out-performs the competitor's *own* channel median by ≥15%. Without this, every topic from a bigger channel looks like an opportunity purely because they have more subscribers, and you end up recommending their sponsor read.
2. **Absolute** — the topic's median beats *our* median by ≥1.3×. A topic that does 0.4× our median isn't an opportunity even if it's a hit for them; it means their audience is different.

Plus a coverage test that checks bigram components, so we don't claim "docker compose" is uncovered when the channel has ten Docker videos.

---

## Reliability

A judge who watches one broken API call mentally writes off the submission, so failure handling is a feature here, not an afterthought.

| Failure | Behaviour |
| --- | --- |
| No `YOUTUBE_API_KEY` | Bundled demo channels run the full pipeline with zero network calls |
| No `GEMINI_API_KEY` | Deterministic writer produces the same report, less fluent prose |
| YouTube quota exhausted | Explicit message + one-click demo channels, never a raw error |
| Channel not found | Specific, actionable message ("try the @handle or full URL") |
| Competitor scan fails | Marked skipped with a reason; the core report renders complete |
| Thumbnail pass fails | Marked skipped; report renders complete |
| LLM returns bad JSON | Prevented by `responseSchema`; if it happens anyway, one corrective retry then the deterministic writer |
| LLM invents a number | Guard catches it, names it, retries with the violations listed, then falls back |
| LLM truncates its output | `MAX_TOKENS` is detected and named, rather than surfacing as a bare JSON syntax error |
| LLM returns an empty body | Surfaces the `finishReason` (safety block) instead of retrying blind |
| Gemini daily quota exhausted | Walks to the next candidate model (quota is metered *per model*), then falls back with a plain-English note |
| Gemini returns 503 "high demand" | Retries once after 1.5s, then walks to the next model |
| Model ID unavailable | Walks the candidate list (`gemini-3.6-flash` → `3.5-flash` → `3.1-flash-lite`); auth errors do *not* trigger the walk, since they would fail identically on every candidate |
| Cold serverless instance (empty cache) | Demo channels serve a committed, guard-re-verified precomputed narration — no cache, no network, no key needed |
| Precomputed narration has gone stale | Guard rejects it and the pipeline calls the model or falls back; a stale figure cannot reach the page |
| Precomputed narration predates a schema change | Rejected by a schema-version check, so a missing field can never render as `undefined`; `npm run bake` fixes it |
| A finding is real but thinly evidenced | Wording is downgraded from an instruction to "worth testing", with the cohort size stated inline |
| Response schema is internally inconsistent | Caught by an assertion in `npm run guard` — `propertyOrdering`/`required` naming a removed property produced a bare 404 that looked like a bad model id |
| Repeat run within a warm instance | Served from the runtime cache: no LLM requests, ~0.2s instead of ~13s |
| Mistyped `@handle` | Fails with a clear message; never fuzzy-matches to a different creator |
| Auto-suggested competitor is not actually adjacent | Rejected before analysis, and named in the report as excluded |
| Fewer than 8 analysable uploads | Refuses with an explanation rather than inventing patterns |
| Uploads under 48h old | Excluded and disclosed — they haven't had time to find an audience |
| Unhandled crash mid-stream | Serialised as a terminal error event; the UI always has something to render |

`scripts/smokeTest.ts` exercises the real HTTP streaming endpoint across all of these, including asserting that `rewriteBefore` matches an actual video title in the dataset.

### Quota discipline

`search.list` costs **100** quota units. `channels.list`, `playlistItems.list` and `videos.list` cost **1** each. So the path is always:

```
channels.list(forHandle)        1 unit  → uploads playlist id
playlistItems.list(playlistId)  1 unit  → up to 50 video ids
videos.list(id=<50 ids, batched>) 1 unit → stats for all 50 at once
```

**3 units** for a 50-video analysis. The naive implementation (`search.list` + one `videos.list` per video) costs **150** — a 50× difference, and the reason the free 10,000-unit daily tier is not a constraint. `search.list` is only used when a user supplies free-text we cannot resolve any other way, and that resolution is cached for 24 hours. Every response is cached (in-memory + on-disk where writable).

---

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

**No API keys are required.** The three bundled demo channels run the entire pipeline offline. Add keys to unlock live mode:

```bash
cp .env.example .env.local
```

| Variable | Optional? | Unlocks |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | yes | Live analysis of any real channel ([enable the API](https://console.cloud.google.com/apis/library/youtube.googleapis.com)) |
| `GEMINI_API_KEY` | yes | LLM-narrated prose + the thumbnail vision pass ([get one](https://aistudio.google.com/apikey)) |
| `GEMINI_MODEL` | yes | Override the model id (default `gemini-3.6-flash`) |

### Other commands

```bash
npm run pipeline -- devbrief                 # full pipeline in the terminal, no browser
npm run pipeline -- @somehandle              # against a real channel (needs YOUTUBE_API_KEY)
npm run pipeline -- @me --competitors @a,@b  # name competitors instead of auto-suggesting
npm run bake                                 # precompute demo narrations (RUN BEFORE DEPLOYING)
npm run verify                               # typecheck + guard suite + production build
npm run guard                                # numeric claim guard suite (offline)
npm run guard -- --live                      # ... plus real model output (needs GEMINI_API_KEY)
npm run sanity                               # dump every computed signal for the demo channels
npm run smoke -- http://localhost:3000       # HTTP smoke test against a running server
npm run snapshot -- @somehandle              # snapshot a real channel into data/seed/
npm run seed                                 # regenerate the synthetic demo datasets
npm run build && npm start
```

### Testing the guard

The numeric claim guard is the component that lets ChannelIQ put generated prose in front of a user at all, so it gets its own suite (`npm run guard`, 36 assertions).

It is deliberately tested as a **provider-sensitive** component, because it is a text parser and models do not agree on how to write a number. Migrating from one provider to another is exactly when it breaks, and it breaks in the worst possible direction: a correct report gets rejected, which is indistinguishable from the model hallucinating. The suite pins:

- **Parsing** — plain integers, decimals, grouped thousands (`3,800,000`), `K`/`M`/`B` suffixes, signed percentages, `x` multipliers.
- **Acceptance** — figures copied exactly, abbreviated, comma-grouped, restated as a multiplier, or quoted from inside a real video title must all pass. So must list positions, ranks, calendar years and runtime targets.
- **Rejection** — invented view counts, invented percentages, numbers *derived* by arithmetic from two real figures, and plausible-but-absent day counts must all be caught.
- **Self-consistency** — the deterministic writer's own output must pass the guard for every demo channel. If it does not, the guard and the briefing have drifted apart, and the guard would be rejecting honest model output for the same reason.
- **Precomputed narrations** — each committed narration must still verify against its own channel, must be *rejected* when checked against a different channel's signals, and must be invalidated by an injected drifted figure. That middle assertion is the one that matters: without it, "re-verified before serving" would be an unfalsifiable claim.
- **`--live`** — real model output must produce zero false positives, *and* the same real output with a fabricated figure spliced in must be caught. That second half is the point: a guard that never fires is indistinguishable from one that works.

The migration to Gemini surfaced two genuine defects that the previous integration had never exercised: the allow-list collector and the verifier used two different number regexes (so their idea of a "number" could disagree), and neither handled comma-grouped thousands. Both are fixed and pinned by tests.

### Deploying to Vercel

Zero config — the defaults are correct. For the record:

| Setting | Value |
| --- | --- |
| Framework preset | Next.js (auto-detected) |
| Build command | `npm run build` (default) |
| Output directory | leave blank (Next.js default `.next`) |
| Install command | `npm install` (default) |
| Node version | 20.x or newer (pinned via `engines` in package.json) |
| Root directory | leave blank |

Environment variables to add in **Project Settings → Environment Variables** (both optional; the app runs without either):

```
YOUTUBE_API_KEY   = <your key>
GEMINI_API_KEY    = <your key>
```

Those are the only two worth setting. The complete set of variables the code reads is:

| Variable | Required | Behaviour when absent |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | no | Live channel lookup is disabled; bundled demo channels still work |
| `GEMINI_API_KEY` | no | Deterministic writer plus precomputed narrations; no thumbnail pass |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.6-flash`, then falls back through `3.5-flash` and `3.1-flash-lite` |
| `CHANNELIQ_CACHE_TTL_MS` | no | Defaults to 6 hours |

Nothing else is read anywhere in the codebase, so a deployment with just those two keys is complete. **Production and Preview** is sufficient; the Development scope only affects `vercel dev` on your own machine.

Do not prefix any of them with `NEXT_PUBLIC_` — they are read server-side only, and the prefix would ship your keys to the browser.

Notes that actually matter on Vercel:

- **`/api/analyze` streams NDJSON** and is declared `runtime = "nodejs"` with `maxDuration = 60`. That value is deliberate: 60s is valid on every plan and compute mode, whereas the Hobby ceiling is 60s and only Fluid compute raises it to 300s — a value above the plan cap risks failing the deployment.

### The request has a hard time budget

Every analysis runs against a wall-clock deadline derived from `maxDuration` (see `PIPELINE_BUDGET_MS` in `lib/pipeline.ts`). Without one the pipeline is unbounded, and unbounded is not a theoretical problem: a real fresh run on a live channel took **119.5 seconds**, 101s of it inside the narration stage, because the model walk on quota errors, transient 503 backoffs and the correction retry all compose multiplicatively. On a deployed function that request is killed mid-stream and the user gets an error instead of a report.

The budget is enforced at three levels:

- **Per-call ceilings.** Every Gemini request carries an `AbortSignal`, so one slow generation cannot consume the whole budget.
- **Skip decisions.** Remaining candidate models, the correction retry, and the thumbnail pass are each skipped when there is not enough time left to complete them.
- **Priority.** The thumbnail pass is subordinate to the narration. It only starts when there is room for both, because it is the most expensive optional stage and feeds the least reliable section of the report.

That priority was learned by getting it wrong. An early version let the vision pass take 21s and abort with nothing, leaving the narration too little time — so the report fell back to templated prose to pay for a thumbnail section that did not exist. The related lesson: a cap must be generous enough for the call to actually finish. A 14s cap on a call that measures 15-21s guaranteed an abort, which spends the full cost for no result. Either give a stage room to complete or stand it down, never both halves.

Measured end to end after budgeting:

| Path | Time |
| --- | --- |
| Bundled demo channel (precomputed narration) | 0.1 - 0.7s |
| Live channel, repeat request | ~0.6s |
| Live channel, fresh (thumbnails + narration both succeed) | 21 - 28s |
| Worst case | bounded by the budget, and always returns a report |

The worst case is now a *bounded* one: if time runs out the narration falls back to the deterministic writer and the thumbnail section says it was cut short. A slightly less fluent report always beats a request that dies.
- **The seed datasets are statically imported** in `data/seed/index.ts`, not read with `fs` at runtime. A runtime `fs.readFileSync("data/seed/...")` works locally and then 404s in a serverless function — precisely the "worked on my machine" failure that kills a live demo.
- **Run `npm run bake` and commit the result before deploying.** This is the step that keeps the narrated report available in production. See below.

### Why the runtime cache is not a production guarantee

Worth being precise about, because the obvious advice — "warm the cache before demoing" — is wrong on serverless and it is an easy mistake to make.

`lib/cache.ts` is two tiers: a module-level `Map` and a JSON file cache that tries `.cache/` then `/tmp`. Locally that is genuinely reliable: one long-lived process, and `.cache/` persists across restarts. On Vercel, neither property holds.

- Vercel [reuses a warm function instance when requests arrive close together](https://vercel.com/docs/functions/serverless-functions), so the in-memory tier *can* hit — but that is opportunistic. A cold start begins with empty module state.
- Concurrent requests are served by separate instances, [each with an independent `/tmp` and no shared state](https://codenote.net/en/posts/vercel-nextjs-embedded-database-prototyping/).
- `/tmp` is [ephemeral between invocations](https://mastra.ai/reference/workspace/vercel) and is not a persistence layer.

So on the deployed app **every request risks being a cache miss**, and pre-warming from a laptop does nothing for it — the laptop's cache is not the deployment's cache. Combined with a 20-request daily quota, a judge opening a cold deployment could get the deterministic writer instead of the narrated report.

The answer is to stop depending on a writable filesystem. `npm run bake` generates narrations for the demo channels ahead of time into `data/precomputed/narrations.json`, which is **committed and statically imported** — same reasoning as the seed data. Reading it needs no cache, no network and no API key, and it is immune to cold starts because it is part of the bundle.

This is checked, not assumed: with `.cache/` deleted, a fresh process and **no `GEMINI_API_KEY` at all**, a demo channel returns the full narrated report in ~30ms.

**A precomputed narration is never trusted blindly.** Prose about numbers goes stale, so before it is served the numeric claim guard re-checks every figure against the signals computed in that request:

1. If the briefing hash matches the one recorded at bake time, inputs are byte-identical and it is served as-is.
2. Otherwise every figure in the prose is re-verified against today's numbers, and it is served only if all of them still exist.
3. Otherwise it is discarded, and the pipeline calls the model or falls back to the deterministic writer.

`npm run guard` asserts that this discriminates: one demo channel's narration checked against another's signals is rejected with dozens of violations, and an injected drifted figure invalidates it. So the worst case is the deterministic writer, never a stale number.

**Re-run `npm run bake` shortly before you demo.** Baked narrations decay, by design: the demo timelines shift forward over time so the bundled channels never look abandoned, which eventually changes the sample and therefore the medians. When that happens the guard rejects the narration and the report falls back to the deterministic writer — correct behaviour, but you lose the narrated prose. `npm run guard` reports it explicitly:

```
[FAIL] The Plain Kitchen: precomputed narration still verifies
       — STALE — diagnosis: "53757" is not a figure from the briefing (re-run npm run bake)
```

So the pre-demo sequence is `npm run bake && npm run verify`, then commit and deploy. Also re-bake after any change to the analysis logic or the seed data.

For the hash to match, the briefing has to be **deterministic within a day**, which is why every figure derived from "now" — video ages, days-since-last-covered, the seed timeline shift — is computed against an analysis clock fixed at midnight UTC (`analysisDayStart()` in `lib/stats.ts`) rather than `Date.now()`. Two defects came from not doing this, and both showed up only in production: the seed timeline shift used `Math.round` against a live clock, and that quotient sits near a `.5` boundary for part of each week, so a few minutes of elapsed time flipped the shift by a whole week and changed the sample size (a channel baked at n=21 was served at n=20); and video ages ticked over at each video's own time of day. The visible symptom was demo channels taking 34s instead of 0.2s. `npm run guard` now builds each demo briefing twice, 1.2s apart, and requires the two to be byte-identical.

One local gotcha: the narrations are a **statically imported JSON module**, so `next build` inlines them. Editing only `narrations.json` does not always invalidate Next's build cache, which means a locally rebuilt bundle can still serve the previous narrations. If you are testing the precomputed path locally, `rm -rf .next` before rebuilding. This does not affect Vercel, where every deploy builds from a fresh checkout.

### Gemini quota

The Gemini free tier meters **requests per day, per model** (`GenerateRequestsPerDayPerProjectPerModel`) — 20/day for `gemini-3.6-flash` at the time of writing. One fresh analysis costs up to two requests: one narration, one thumbnail vision pass. So a free-tier key supports roughly **ten fresh analyses per day** for channels that are not precomputed.

Four things in the code exist because of this, all found by exhausting the real quota during testing:

1. **Precomputed narrations** for the demo channels, so the paths a judge is most likely to take cost nothing at all.
2. **A 429 walks the model candidate list.** Because quota is metered per model, a 429 on `gemini-3.6-flash` says nothing about `gemini-3.5-flash`'s budget. Walking the list multiplies the free-tier allowance instead of dropping straight to templated prose. Verified working: a real run reported `Narrated by gemini-3.1-flash-lite` after the primary model was exhausted.
3. **Both LLM calls are cached at runtime too** — narration against a hash of the computed briefing, vision against the exact set of video ids. Within a warm instance a repeat run costs zero requests and returns in ~0.2s instead of ~13s. Useful, just not something to depend on in production.
4. **Transient 503s retry once before walking.** Gemini returns "high demand" on popular models often enough that falling through to templated prose over a two-second blip would be a bad trade.

For **live channels a judge types in**, precomputing is impossible by definition, so that path is genuinely quota-limited. If that matters for your demo, enable billing on the key.

---

## About the bundled demo data

**The three bundled demo channels are synthetic.** DevBrief, The Plain Kitchen and Homelab Hour are not real creators, and the report says so, prominently, at the top of every run.

That is a deliberate choice. Publishing fabricated view counts under a real creator's name would be misleading, and the alternative — shipping a real scrape — goes stale and can't be regenerated without a key. The synthetic channels are generated by `scripts/generateSeed.ts` with **genuine, recoverable statistical structure**: specific title patterns, length bands, posting slots and topics really do out-perform in the data, along with a realistic view-accumulation curve and log-normal noise.

The analysis pipeline is therefore doing real work, and it can be checked: `scripts/sanityCheck.ts` shows the analyzer recovering the injected ground truth (Docker +102% against an injected 1.55× multiplier, Kubernetes −61% against 0.58×, 10–20 min +84% against 1.42×). Homelab Hour is deliberately thin at 20 uploads so the low-confidence and "data is too sparse to call a slot" paths are exercised in every demo.

Timelines are shifted forward at load time so the demo never ages into "you haven't posted in eight months" — quantised to whole weeks, because any other shift would rotate every video onto a different weekday and silently destroy the day-of-week signal.

To run the offline demo on real creators instead, use `npm run snapshot -- @handle`.

---

## How this maps to the judging criteria

### Functionality (30%)

Complete P0, plus all of P1.

- Channel input accepts `@handle`, bare handle, `/channel/UC…`, `/c/`, `/user/`, a video URL, a Shorts URL, or free text.
- Data Collector pulls up to 50 uploads with full statistics on the 3-quota-unit path.
- Pattern Analysis correlates **title structure** (9 overlapping patterns), **title length** (5 bands), **video length** (5 buckets incl. Shorts), **day and 3-hour slot** in the channel's inferred timezone, and **topic clusters** (unigram + bigram extraction, containment-based merging) — all against age-and-growth-normalised performance, with the runtime confounder controlled.
- Also computes cadence/consistency, an age-adjusted trend, and the high-engagement/low-reach set (videos the audience loved but the algorithm ignored — a packaging failure, not a topic failure).
- Strategy Writer outputs a diagnosis, a headline, 3 ranked concepts with per-concept evidence, a title formula with a rewrite of one of the channel's own titles, length and timing guidance, a "stop doing" list and a 6-step checklist.
- **P1 delivered:** Competitor Whitespace Agent (double-tested gaps), thumbnail vision pass, and export via Markdown copy + a print stylesheet that turns Ctrl+P into a clean PDF.
- Guaranteed-demo fallback: three bundled channels, plus one-click recovery buttons on every error state.

### Creativity (20%)

- The whitespace analysis answers a question the creator's own analytics *cannot*: what about the video you never made. Two-condition gap test so it doesn't just recommend whatever a bigger channel posts.
- The **numeric claim guard** — programmatically verifying an LLM's prose against the numbers it was given, with a self-correcting retry — is an unusual and portable answer to a real problem with LLM-in-the-loop analytics.
- Local-baseline scoring instead of raw views, and dividing out the runtime confounder, are the difference between a correlation and a coincidence.
- The high-engagement/low-reach detector produces the report's most non-obvious recommendation: *remake this specific video, its packaging failed, not its topic.*
- The pipeline animation is the architecture diagram, executing.
- The deterministic writer means the product has no hard dependency on an LLM being up.

### Technical execution (20%)

- One file per agent; the architecture is legible from the file tree. Contracts in `lib/types.ts`; each layer transforms the previous one's typed output.
- Strict TypeScript, no `any` in the data path, clean `next build`.
- Real streaming (NDJSON over a `ReadableStream`) rather than a fake progress bar.
- Rank-based statistics throughout (medians, effect sizes, shrinkage) because view distributions are heavily right-skewed.
- Two-tier caching that degrades to memory-only on a read-only filesystem.
- 50× quota reduction from endpoint choice and 50-ID batching.
- Comments explain *why*, not *what* — particularly the non-obvious statistical choices.

### Real-world usefulness (30%)

- Output is a prescription, not a visualisation: what to make, what to call it, how long, when to post, what to stop.
- Every claim carries its number and its confidence, so a creator can tell a solid finding from a hint — and the tool says "I don't know" where it doesn't.
- The report is a shareable deliverable (Markdown for Notion/Docs/email, PDF via print) rather than a session that vanishes.
- Explicitly honest about being correlational, about synthetic demo data, and about which advice is a general heuristic rather than a finding. That's what makes it something a creator would open twice.

---

## Project layout

```
app/
  page.tsx                      streams the pipeline, renders the report
  api/analyze/route.ts          NDJSON event stream
  api/capabilities/route.ts     what this deployment can do (no key values)
lib/
  agents/
    dataCollector.ts            AGENT 1 — resolve + fetch + sanitise
    patternAnalyzer.ts          AGENT 2 — all correlation logic, no LLM
    whitespaceAgent.ts          AGENT 3a — competitor gaps, no LLM
    thumbnailAgent.ts           AGENT 3b — vision perception only
    strategyWriter.ts           AGENT 4 — the only generative LLM call
  pipeline.ts                   orchestration + failure policy
  youtube.ts                    API client, quota metering, input parsing
  stats.ts                      medians, effect sizes, confidence, formatting
  types.ts                      contracts between every layer
  cache.ts                      memory + disk cache
  reportMarkdown.ts             export
components/                     input, pipeline progress, report, charts
data/seed/                      bundled snapshots (synthetic) + manifest
data/precomputed/               committed narrations — survives cold starts, guard re-verified
scripts/                        generateSeed, snapshot, bake, sanityCheck, runPipeline,
                                smokeTest, liveCheck, guardTest
```

---

## Limitations

Stated plainly, because pretending otherwise is how a tool loses a user's trust.

- **Correlational.** Single-channel history, no control group. Good grounds for what to test next; not proof of cause.
- **Public metrics only.** Views, likes, comments, duration and metadata. No impressions, CTR, or watch time — those need OAuth and the channel owner's consent. CTR in particular would materially sharpen the thumbnail and title analysis.
- **Timezone is inferred**, from the declared country or the modal upload hour. Always disclosed.
- **Small samples.** 20–50 uploads is what YouTube gives cheaply. It is enough for strong effects and honestly insufficient for subtle ones, which is what the confidence grading is for.
- **English-centric** topic extraction (stopword list and tokenizer).
- **Whitespace detection finds vocabulary gaps, not semantic ones.** It looks for terms a channel has never used. On a broad channel that is not the same as a subject it has never covered — a large tech reviewer will genuinely never have typed the word "tech" in a title. The thresholds are therefore tuned to be quiet rather than wrong: single-word topics face much stricter bars than multi-word ones, auto-suggested channels must share at least two subjects with yours to qualify, and the honest outcome on a well-covered niche is zero gaps. **Naming your competitors explicitly produces markedly better results than auto-suggestion**, which is a keyword search and returns what is popular rather than what is adjacent.
- **Shorts and long-form are bucketed but not modelled separately**, and they have genuinely different distribution mechanics.
