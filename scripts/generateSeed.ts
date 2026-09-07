/**
 * Seed dataset generator.
 *
 * WHY THIS EXISTS
 * ---------------
 * ChannelIQ must run end-to-end with zero API keys, and the live demo must
 * never depend on YouTube quota or latency at judging time. So we bundle
 * snapshots in data/seed/.
 *
 * HONESTY NOTE (important, and stated in the README + the UI):
 * These bundled datasets are *synthetic sample channels*, not scrapes of real
 * creators. Publishing fabricated numbers under a real creator's name would be
 * misleading, so the demo channels are fictional. They are constructed to
 * contain genuine, non-obvious statistical structure — specific title
 * patterns, length bands, posting slots and topics really do outperform in the
 * data — so the analysis pipeline is doing actual work, not theatre.
 *
 * To snapshot a REAL channel into the same format (requires YOUTUBE_API_KEY):
 *   npm run snapshot -- @somehandle
 *
 * Regenerate the synthetic set with:
 *   npx tsx scripts/generateSeed.ts
 */

import fs from "node:fs";
import path from "node:path";

// --------------------------------------------------------------------------
// Deterministic PRNG so regenerating the seed never changes the demo.
// --------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PatternId =
  | "question"
  | "how_to"
  | "number_led"
  | "colon_split"
  | "superlative"
  | "plain_statement"
  | "bracketed"
  | "first_person";

interface Topic {
  key: string;
  /** Multiplier applied to expected views when a video is in this topic. */
  mult: number;
  subjects: string[];
  actions: string[];
  weight: number;
  /** Restrict this topic to the oldest fraction of the timeline (0-1 window). */
  window?: [number, number];
}

interface ChannelSpec {
  slug: string;
  aliases: string[];
  title: string;
  handle: string;
  description: string;
  subscribers: number;
  country: string;
  niche: string;
  videoCount: number;
  /** Absolute expected views for a typical video at the START of the window. */
  baseViews: number;
  /** Total multiplicative growth across the whole window (1.0 = flat). */
  growth: number;
  medianGapDays: number;
  patternMult: Partial<Record<PatternId, number>>;
  patternWeight: Partial<Record<PatternId, number>>;
  /** Duration buckets: [minSec, maxSec, multiplier, weight] */
  durations: Array<[number, number, number, number]>;
  /** weekday (0=Sun) -> multiplier */
  weekdayMult: number[];
  weekdayWeight: number[];
  /** local hour -> multiplier, sparse */
  hourMult: Record<number, number>;
  hourPool: number[];
  topics: Topic[];
  baseLikeRate: number;
  baseCommentRate: number;
  competitors: string[];
  seed: number;
  synthetic: true;
}

// --------------------------------------------------------------------------
// Title construction. Each template is guaranteed to satisfy the detector in
// lib/agents/patternAnalyzer.ts for its pattern id.
// --------------------------------------------------------------------------

const NUMBERS = [3, 5, 6, 7, 9, 10, 12];
const LISTICLE_NOUNS = ["Mistakes", "Tricks", "Tips", "Shortcuts", "Habits"];
const LISTICLE_TAILS = [
  "That Actually Matter",
  "I Wish I Knew Sooner",
  "Nobody Warns You About",
  "Worth Stealing",
];

function buildTitle(pattern: PatternId, topic: Topic, rand: () => number, year: number): string {
  const subject = topic.subjects[Math.floor(rand() * topic.subjects.length)];
  const action = topic.actions[Math.floor(rand() * topic.actions.length)];
  const n = NUMBERS[Math.floor(rand() * NUMBERS.length)];
  const noun = LISTICLE_NOUNS[Math.floor(rand() * LISTICLE_NOUNS.length)];

  switch (pattern) {
    case "number_led": {
      const tail = LISTICLE_TAILS[Math.floor(rand() * LISTICLE_TAILS.length)];
      return `${n} ${subject} ${noun} ${tail}`;
    }
    case "how_to":
      return `How to ${action}`;
    case "question": {
      // Crude plural agreement, purely so the sample titles read like English.
      const plural = /s$/i.test(subject) && !/ss$/i.test(subject);
      return `${plural ? "Are" : "Is"} ${subject} Still Worth It in ${year}?`;
    }
    case "colon_split":
      return `${subject}: The Setup I Actually Use`;
    case "superlative":
      return `The Best Way to ${action}`;
    case "bracketed":
      return `${subject} Deep Dive [Full Walkthrough]`;
    case "first_person":
      return `I Spent a Month Learning ${subject}`;
    case "plain_statement":
    default:
      return `${subject} Explained`;
  }
}

function weightedPick<T>(items: T[], weights: number[], rand: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * How much of a video's eventual view count has landed by `ageDays`.
 * Real YouTube view curves are front-loaded then long-tailed; this is a crude
 * but directionally honest model. The Pattern Analysis Agent has to undo this
 * (via its rolling baseline) to compare a 4-day-old video with a 400-day-old
 * one, so it matters that the seed data actually contains the effect.
 */
function ageAccrual(ageDays: number): number {
  const burst = 1 - Math.exp(-ageDays / 9);
  const tail = Math.log1p(Math.max(0, ageDays)) / Math.log1p(720);
  return Math.min(1, 0.55 * burst + 0.45 * tail);
}

function logNormalNoise(rand: () => number, sigma: number): number {
  // Box-Muller
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(z * sigma);
}

// --------------------------------------------------------------------------
// Channel specs
// --------------------------------------------------------------------------

const DEV_TOPICS: Topic[] = [
  {
    key: "docker",
    mult: 1.55,
    weight: 4,
    subjects: ["Docker Compose", "Container Builds", "Dockerfiles"],
    actions: ["Cut Your Docker Image Size by 80%", "Structure a Docker Compose Project", "Debug a Container That Won't Start"],
  },
  {
    key: "typescript",
    mult: 1.18,
    weight: 4,
    subjects: ["TypeScript Generics", "Strict Mode TypeScript", "Type Inference"],
    actions: ["Type an API Client Properly", "Migrate a JS Project to TypeScript", "Stop Fighting TypeScript Errors"],
  },
  {
    key: "kubernetes",
    mult: 0.58,
    weight: 3,
    subjects: ["Kubernetes Operators", "K8s Networking", "Helm Charts"],
    actions: ["Deploy to Kubernetes Without Losing Your Mind", "Write Your First Helm Chart"],
  },
  {
    key: "rust",
    mult: 1.02,
    weight: 3,
    subjects: ["Rust Ownership", "Rust Error Handling", "Async Rust"],
    actions: ["Read Rust Compiler Errors", "Build a CLI in Rust"],
  },
  {
    key: "github actions",
    mult: 0.72,
    weight: 3,
    subjects: ["GitHub Actions", "CI Pipelines", "Build Caching"],
    actions: ["Cache Dependencies in GitHub Actions", "Speed Up a Slow CI Pipeline"],
  },
  {
    key: "ai agents",
    mult: 2.05,
    weight: 1,
    window: [0, 0.35],
    subjects: ["Coding Agents", "LLM Tool Calling"],
    actions: ["Wire an LLM Into Your Editor"],
  },
];

const KITCHEN_TOPICS: Topic[] = [
  {
    key: "meal prep",
    mult: 1.62,
    weight: 4,
    subjects: ["Sunday Meal Prep", "Five Day Lunch Prep", "Fridge Prep"],
    actions: ["Prep Five Lunches in One Hour", "Meal Prep Without Soggy Vegetables"],
  },
  {
    key: "air fryer",
    mult: 1.48,
    weight: 3,
    subjects: ["Air Fryer Basics", "Air Fryer Vegetables", "Air Fryer Chicken"],
    actions: ["Air Fry Anything Without Drying It Out", "Get Crispy Air Fryer Potatoes"],
  },
  {
    key: "one pan",
    mult: 1.28,
    weight: 4,
    subjects: ["One Pan Dinners", "Sheet Pan Suppers", "Skillet Meals"],
    actions: ["Build a One Pan Dinner From Anything", "Make a Sheet Pan Dinner in 20 Minutes"],
  },
  {
    key: "baking",
    mult: 0.74,
    weight: 3,
    subjects: ["No Knead Bread", "Cookie Dough", "Enriched Doughs"],
    actions: ["Bake Bread Without a Mixer", "Stop Overbaking Cookies"],
  },
  {
    key: "knife skills",
    mult: 0.61,
    weight: 2,
    subjects: ["Knife Skills", "Onion Prep", "Sharpening"],
    actions: ["Dice an Onion Properly", "Sharpen a Kitchen Knife at Home"],
  },
  {
    key: "budget",
    mult: 1.09,
    weight: 3,
    subjects: ["Budget Dinners", "Ten Dollar Dinners", "Pantry Meals"],
    actions: ["Feed Four for Ten Dollars", "Cook From a Bare Pantry"],
  },
];

const HOMELAB_TOPICS: Topic[] = [
  {
    key: "proxmox",
    mult: 1.55,
    weight: 4,
    subjects: ["Proxmox", "Proxmox Backups", "VM Passthrough"],
    actions: ["Set Up Proxmox on Old Hardware", "Back Up Proxmox the Easy Way"],
  },
  {
    key: "nas",
    mult: 1.22,
    weight: 3,
    subjects: ["DIY NAS", "TrueNAS", "Disk Layouts"],
    actions: ["Build a Quiet NAS Under 500 Dollars", "Pick a RAID Layout You Won't Regret"],
  },
  {
    key: "networking",
    mult: 0.88,
    weight: 3,
    subjects: ["VLANs at Home", "Home Firewalls", "DNS at Home"],
    actions: ["Segment Your Home Network With VLANs", "Run Your Own DNS"],
  },
  {
    key: "power",
    mult: 0.66,
    weight: 2,
    subjects: ["Rack Power Draw", "UPS Sizing"],
    actions: ["Cut Your Homelab Power Bill"],
  },
];

const SPECS: ChannelSpec[] = [
  {
    slug: "devbrief",
    aliases: ["devbrief", "@devbrief", "dev brief", "UCseedDEVBRIEF00000001"],
    title: "DevBrief",
    handle: "devbrief",
    description:
      "Short, practical developer tooling videos. Docker, TypeScript, CI and the boring infrastructure that actually ships software.",
    subscribers: 214_000,
    country: "US",
    niche: "developer tooling tutorials",
    videoCount: 48,
    baseViews: 62_000,
    growth: 1.35,
    medianGapDays: 6,
    patternMult: {
      number_led: 1.46,
      superlative: 1.24,
      how_to: 1.12,
      colon_split: 1.0,
      question: 0.93,
      bracketed: 0.86,
      plain_statement: 0.68,
      first_person: 1.05,
    },
    patternWeight: {
      number_led: 6,
      how_to: 6,
      question: 4,
      colon_split: 2,
      superlative: 3,
      plain_statement: 5,
      bracketed: 2,
      first_person: 1,
    },
    durations: [
      [180, 290, 0.64, 2],
      [320, 590, 0.98, 5],
      [610, 1180, 1.42, 6],
      [1250, 2100, 0.81, 2],
    ],
    weekdayMult: [0.82, 1.02, 1.31, 1.12, 0.98, 0.94, 0.71],
    weekdayWeight: [1, 3, 4, 3, 3, 2, 1],
    hourMult: { 9: 0.9, 12: 1.0, 15: 1.22, 16: 1.2, 18: 1.02, 21: 0.85 },
    hourPool: [9, 12, 15, 16, 18, 21],
    topics: DEV_TOPICS,
    baseLikeRate: 0.041,
    baseCommentRate: 0.0052,
    competitors: ["shipfast-weekly", "the-refactor"],
    seed: 1337,
    synthetic: true,
  },
  {
    slug: "plain-kitchen",
    aliases: ["plainkitchen", "@plainkitchen", "the plain kitchen", "UCseedPLAINKITCHEN0001"],
    title: "The Plain Kitchen",
    handle: "plainkitchen",
    description:
      "Unfussy home cooking. Weeknight dinners, meal prep and the small techniques that make cheap ingredients taste expensive.",
    subscribers: 47_500,
    country: "GB",
    niche: "home cooking weeknight dinners",
    videoCount: 44,
    baseViews: 18_500,
    growth: 1.9,
    medianGapDays: 7,
    patternMult: {
      how_to: 1.41,
      number_led: 1.19,
      colon_split: 0.96,
      superlative: 1.08,
      question: 0.84,
      bracketed: 0.79,
      plain_statement: 0.74,
      first_person: 0.98,
    },
    patternWeight: {
      how_to: 4,
      number_led: 3,
      question: 3,
      colon_split: 3,
      superlative: 2,
      plain_statement: 5,
      bracketed: 2,
      first_person: 1,
    },
    durations: [
      [150, 295, 1.34, 4],
      [310, 580, 1.11, 5],
      [620, 1150, 0.71, 4],
      [1300, 1900, 0.52, 1],
    ],
    weekdayMult: [1.36, 0.95, 0.88, 1.02, 0.97, 1.06, 1.14],
    weekdayWeight: [3, 2, 2, 3, 3, 3, 3],
    hourMult: { 7: 1.18, 10: 1.24, 13: 1.0, 17: 0.94, 19: 0.88 },
    hourPool: [7, 10, 13, 17, 19],
    topics: KITCHEN_TOPICS,
    baseLikeRate: 0.058,
    baseCommentRate: 0.0091,
    competitors: ["weeknight-wok", "batch-and-freeze"],
    seed: 90210,
    synthetic: true,
  },
  {
    slug: "homelab-hour",
    aliases: ["homelabhour", "@homelabhour", "homelab hour", "UCseedHOMELABHOUR00001"],
    title: "Homelab Hour",
    handle: "homelabhour",
    description:
      "Self-hosting, home servers and the rack in my basement. Long-form builds, honest power bills, no sponsor fluff.",
    subscribers: 11_300,
    country: "CA",
    niche: "homelab self hosting home server",
    // Deliberately thin: exercises the low-confidence / "data is sparse" paths.
    videoCount: 21,
    baseViews: 7_400,
    growth: 0.82,
    medianGapDays: 13,
    patternMult: {
      question: 1.52,
      how_to: 1.14,
      number_led: 1.03,
      colon_split: 0.94,
      superlative: 1.1,
      plain_statement: 0.8,
      bracketed: 1.06,
      first_person: 1.2,
    },
    patternWeight: {
      question: 3,
      how_to: 4,
      number_led: 2,
      colon_split: 2,
      superlative: 2,
      plain_statement: 4,
      bracketed: 2,
      first_person: 2,
    },
    durations: [
      [240, 295, 0.72, 1],
      [400, 590, 0.86, 3],
      [700, 1190, 1.04, 4],
      [1300, 2600, 1.31, 4],
    ],
    weekdayMult: [1.18, 0.92, 0.96, 1.04, 1.08, 1.12, 0.9],
    weekdayWeight: [3, 2, 2, 2, 3, 3, 2],
    hourMult: { 8: 1.0, 11: 1.12, 14: 1.05, 20: 0.92 },
    hourPool: [8, 11, 14, 20],
    topics: HOMELAB_TOPICS,
    baseLikeRate: 0.047,
    baseCommentRate: 0.0114,
    competitors: ["rackmounted", "selfhosted-sundays"],
    seed: 4242,
    synthetic: true,
  },
];

// --------------------------------------------------------------------------
// Competitor specs — smaller samples, tuned so specific topics are clearly
// *their* territory. That is what the Whitespace Agent should surface.
// --------------------------------------------------------------------------

interface CompetitorSpec {
  slug: string;
  title: string;
  handle: string;
  description: string;
  subscribers: number;
  country: string;
  videoCount: number;
  baseViews: number;
  growth: number;
  medianGapDays: number;
  topics: Topic[];
  seed: number;
}

const COMPETITORS: CompetitorSpec[] = [
  {
    slug: "shipfast-weekly",
    title: "ShipFast Weekly",
    handle: "shipfastweekly",
    description: "Weekly deep dives on shipping software fast. Agents, platform engineering, developer experience.",
    subscribers: 388_000,
    country: "US",
    videoCount: 30,
    baseViews: 148_000,
    growth: 1.5,
    medianGapDays: 7,
    seed: 777,
    topics: [
      {
        key: "ai agents",
        mult: 2.4,
        weight: 6,
        subjects: ["Coding Agents", "Agent Workflows", "LLM Tool Calling"],
        actions: ["Ship a Feature With a Coding Agent", "Give an LLM Access to Your Codebase"],
      },
      {
        key: "observability",
        mult: 1.7,
        weight: 4,
        subjects: ["OpenTelemetry", "Structured Logging", "Tracing"],
        actions: ["Instrument a Service With OpenTelemetry", "Find a Slow Endpoint With Tracing"],
      },
      {
        key: "kubernetes",
        mult: 1.1,
        weight: 3,
        subjects: ["Kubernetes Operators", "K8s Autoscaling"],
        actions: ["Autoscale a Kubernetes Service"],
      },
      {
        key: "typescript",
        mult: 0.9,
        weight: 2,
        subjects: ["TypeScript Generics"],
        actions: ["Type an API Client Properly"],
      },
    ],
  },
  {
    slug: "the-refactor",
    title: "The Refactor",
    handle: "therefactor",
    description: "Systems programming, performance work and the unglamorous engineering that makes things fast.",
    subscribers: 156_000,
    country: "DE",
    videoCount: 28,
    baseViews: 91_000,
    growth: 1.25,
    medianGapDays: 9,
    seed: 8181,
    topics: [
      {
        key: "webassembly",
        mult: 2.1,
        weight: 5,
        subjects: ["WebAssembly", "WASM Modules", "Wasm in the Browser"],
        actions: ["Compile Rust to WebAssembly", "Replace a Hot JS Loop With WASM"],
      },
      {
        key: "profiling",
        mult: 1.8,
        weight: 4,
        subjects: ["Flame Graphs", "CPU Profiling", "Memory Profiling"],
        actions: ["Read a Flame Graph", "Find a Memory Leak in Production"],
      },
      {
        key: "rust",
        mult: 1.15,
        weight: 4,
        subjects: ["Async Rust", "Rust Ownership"],
        actions: ["Build a CLI in Rust"],
      },
      {
        key: "docker",
        mult: 0.85,
        weight: 2,
        subjects: ["Container Builds"],
        actions: ["Cut Your Docker Image Size by 80%"],
      },
    ],
  },
  {
    slug: "weeknight-wok",
    title: "Weeknight Wok",
    handle: "weeknightwok",
    description: "Fast, hot, high-heat cooking for people who get home at seven.",
    subscribers: 122_000,
    country: "SG",
    videoCount: 30,
    baseViews: 54_000,
    growth: 1.4,
    medianGapDays: 6,
    seed: 5150,
    topics: [
      {
        key: "stir fry",
        mult: 2.2,
        weight: 6,
        subjects: ["Wok Hei", "Stir Fry Basics", "Wok Technique"],
        actions: ["Get Wok Hei on a Home Stove", "Stir Fry Without Steaming Your Food"],
      },
      {
        key: "noodles",
        mult: 1.8,
        weight: 4,
        subjects: ["Hand Pulled Noodles", "Noodle Sauces"],
        actions: ["Cook Noodles That Don't Clump"],
      },
      {
        key: "one pan",
        mult: 1.0,
        weight: 3,
        subjects: ["Skillet Meals"],
        actions: ["Make a Sheet Pan Dinner in 20 Minutes"],
      },
      {
        key: "budget",
        mult: 0.95,
        weight: 2,
        subjects: ["Pantry Meals"],
        actions: ["Cook From a Bare Pantry"],
      },
    ],
  },
  {
    slug: "batch-and-freeze",
    title: "Batch & Freeze",
    handle: "batchandfreeze",
    description: "Cook once, eat for a month. Freezer meals, slow cooker dinners and batch systems for busy households.",
    subscribers: 78_000,
    country: "US",
    videoCount: 26,
    baseViews: 39_000,
    growth: 1.6,
    medianGapDays: 8,
    seed: 3131,
    topics: [
      {
        key: "freezer meals",
        mult: 2.3,
        weight: 6,
        subjects: ["Freezer Meals", "Freezer Breakfasts", "Batch Freezing"],
        actions: ["Freeze a Month of Dinners in One Afternoon", "Freeze Meals Without Freezer Burn"],
      },
      {
        key: "slow cooker",
        mult: 1.75,
        weight: 4,
        subjects: ["Slow Cooker Dinners", "Dump and Go Meals"],
        actions: ["Build a Dump and Go Slow Cooker Dinner"],
      },
      {
        key: "meal prep",
        mult: 1.05,
        weight: 3,
        subjects: ["Sunday Meal Prep"],
        actions: ["Prep Five Lunches in One Hour"],
      },
    ],
  },
  {
    slug: "rackmounted",
    title: "RackMounted",
    handle: "rackmounted",
    description: "Enterprise gear in a spare bedroom. Serious homelab builds, networking and storage at scale.",
    subscribers: 205_000,
    country: "US",
    videoCount: 28,
    baseViews: 66_000,
    growth: 1.3,
    medianGapDays: 7,
    seed: 6060,
    topics: [
      {
        key: "10gbe",
        mult: 2.15,
        weight: 5,
        subjects: ["10GbE at Home", "Fibre Runs", "Switch Upgrades"],
        actions: ["Wire 10GbE Through Your House", "Pick a Quiet 10GbE Switch"],
      },
      {
        key: "kubernetes at home",
        mult: 1.9,
        weight: 4,
        subjects: ["K3s at Home", "Home Kubernetes"],
        actions: ["Run Kubernetes on Three Mini PCs"],
      },
      {
        key: "proxmox",
        mult: 1.1,
        weight: 3,
        subjects: ["Proxmox Backups"],
        actions: ["Back Up Proxmox the Easy Way"],
      },
      {
        key: "power",
        mult: 0.9,
        weight: 2,
        subjects: ["Rack Power Draw"],
        actions: ["Cut Your Homelab Power Bill"],
      },
    ],
  },
  {
    slug: "selfhosted-sundays",
    title: "SelfHosted Sundays",
    handle: "selfhostedsundays",
    description: "One self-hosted app every Sunday. Docker Compose files you can actually copy.",
    subscribers: 64_000,
    country: "NL",
    videoCount: 26,
    baseViews: 28_000,
    growth: 1.7,
    medianGapDays: 7,
    seed: 2020,
    topics: [
      {
        key: "docker compose",
        mult: 2.05,
        weight: 6,
        subjects: ["Docker Compose Stacks", "Compose Files", "Container Updates"],
        actions: ["Self-Host Anything With Docker Compose", "Keep Your Containers Updated Automatically"],
      },
      {
        key: "backups",
        mult: 1.85,
        weight: 4,
        subjects: ["3-2-1 Backups", "Restic Backups", "Offsite Backups"],
        actions: ["Set Up 3-2-1 Backups for Your Homelab", "Test a Restore Before You Need It"],
      },
      {
        key: "photo hosting",
        mult: 1.6,
        weight: 3,
        subjects: ["Immich", "Self-Hosted Photos"],
        actions: ["Replace Google Photos With Immich"],
      },
      {
        key: "nas",
        mult: 0.95,
        weight: 2,
        subjects: ["TrueNAS"],
        actions: ["Pick a RAID Layout You Won't Regret"],
      },
    ],
  },
];

// --------------------------------------------------------------------------
// Generation
// --------------------------------------------------------------------------

/**
 * Anchor date. The loader (lib/agents/dataCollector.ts) shifts every seed
 * timeline so the newest video is a few days old at read time, which keeps the
 * bundled demo from ageing into "you haven't posted in 8 months".
 */
const ANCHOR = Date.parse("2026-08-25T00:00:00Z");
const YEAR = 2026;

const COUNTRY_OFFSET: Record<string, number> = {
  US: -5, GB: 0, DE: 1, NL: 1, CA: -5, SG: 8,
};

interface GeneratedVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  likes: number;
  comments: number;
  thumbnailUrl: string;
  tags: string[];
}

function generateVideos(
  spec: {
    slug: string;
    videoCount: number;
    baseViews: number;
    growth: number;
    medianGapDays: number;
    topics: Topic[];
    seed: number;
    country: string;
    patternMult?: Partial<Record<PatternId, number>>;
    patternWeight?: Partial<Record<PatternId, number>>;
    durations?: Array<[number, number, number, number]>;
    weekdayMult?: number[];
    weekdayWeight?: number[];
    hourMult?: Record<number, number>;
    hourPool?: number[];
    baseLikeRate?: number;
    baseCommentRate?: number;
  },
): GeneratedVideo[] {
  const rand = mulberry32(spec.seed);
  const offset = COUNTRY_OFFSET[spec.country] ?? 0;

  const patternIds: PatternId[] = [
    "number_led", "how_to", "question", "colon_split",
    "superlative", "plain_statement", "bracketed", "first_person",
  ];
  const pWeights = patternIds.map((p) => spec.patternWeight?.[p] ?? 2);
  const durations = spec.durations ?? [
    [200, 295, 0.9, 2],
    [320, 590, 1.0, 4],
    [620, 1180, 1.1, 4],
    [1250, 2000, 0.9, 2],
  ];
  const weekdayMult = spec.weekdayMult ?? [1, 1, 1, 1, 1, 1, 1];
  const weekdayWeight = spec.weekdayWeight ?? [2, 3, 3, 3, 3, 3, 2];
  const hourPool = spec.hourPool ?? [10, 14, 18];
  const hourMult = spec.hourMult ?? {};
  const likeRate = spec.baseLikeRate ?? 0.045;
  const commentRate = spec.baseCommentRate ?? 0.006;

  const videos: GeneratedVideo[] = [];
  const N = spec.videoCount;
  const usedTitles = new Set<string>();

  // Walk backwards from the anchor so index 0 is the NEWEST video.
  let cursor = ANCHOR - 4 * 86_400_000;

  for (let i = 0; i < N; i++) {
    // progress: 0 = newest, 1 = oldest
    const progress = i / Math.max(1, N - 1);

    const eligible = spec.topics.filter((t) => {
      if (!t.window) return true;
      return progress >= t.window[0] && progress <= t.window[1];
    });
    const pool = eligible.length ? eligible : spec.topics;
    const topic = weightedPick(pool, pool.map((t) => t.weight), rand);
    const pattern = weightedPick(patternIds, pWeights, rand);

    // Land the publish date on a weekday the channel actually favours.
    let publishedAt = new Date(cursor);
    const targetWeekday = weightedPick([0, 1, 2, 3, 4, 5, 6], weekdayWeight, rand);
    const targetHour = hourPool[Math.floor(rand() * hourPool.length)];
    // shift backwards to the nearest matching weekday (keeps ordering intact)
    const localGuess = new Date(publishedAt.getTime() + offset * 3_600_000);
    const delta = (localGuess.getUTCDay() - targetWeekday + 7) % 7;
    publishedAt = new Date(publishedAt.getTime() - delta * 86_400_000);
    // set the local hour, then convert back to UTC for storage
    const utcHour = ((targetHour - offset) % 24 + 24) % 24;
    publishedAt.setUTCHours(utcHour, Math.floor(rand() * 60), 0, 0);

    const ageDays = Math.max(1, (ANCHOR - publishedAt.getTime()) / 86_400_000);

    const [minSec, maxSec, durMult] = weightedPick(
      durations,
      durations.map((d) => d[3]),
      rand,
    );
    const durationSeconds = Math.round(minSec + rand() * (maxSec - minSec));

    let title = buildTitle(pattern, topic, rand, YEAR);
    let guard = 0;
    while (usedTitles.has(title) && guard++ < 12) title = buildTitle(pattern, topic, rand, YEAR);
    usedTitles.add(title);

    const localWeekday = new Date(publishedAt.getTime() + offset * 3_600_000).getUTCDay();
    const localHour = new Date(publishedAt.getTime() + offset * 3_600_000).getUTCHours();

    // Channel-size baseline at this point in the timeline. progress=1 is the
    // oldest video, so growth must be applied in reverse.
    const growthFactor = Math.pow(spec.growth, 1 - progress);
    const eventualViews =
      spec.baseViews *
      growthFactor *
      topic.mult *
      (spec.patternMult?.[pattern] ?? 1) *
      durMult *
      weekdayMult[localWeekday] *
      (hourMult[localHour] ?? 1) *
      logNormalNoise(rand, 0.26);

    const views = Math.max(120, Math.round(eventualViews * ageAccrual(ageDays)));

    // Engagement rates drift with topic quality but are noisier than views.
    const engagementBoost = 0.75 + 0.5 * Math.min(1.6, topic.mult) / 1.6 + (rand() - 0.5) * 0.3;
    const likes = Math.max(1, Math.round(views * likeRate * engagementBoost * logNormalNoise(rand, 0.16)));
    const comments = Math.max(0, Math.round(views * commentRate * engagementBoost * logNormalNoise(rand, 0.22)));

    const id = `SEED${spec.slug.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase()}${String(i).padStart(3, "0")}`;

    videos.push({
      id,
      title,
      description: `${title}\n\nIn this video: ${topic.subjects[0].toLowerCase()}, plus the ${topic.key} workflow I use day to day. Chapters, links and the full write-up below.\n\n#${topic.key.replace(/\s+/g, "")}`,
      publishedAt: publishedAt.toISOString(),
      durationSeconds,
      views,
      likes,
      comments,
      // Deterministic placeholder art; the UI degrades gracefully if it 404s.
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      tags: [topic.key, ...topic.key.split(" ")].slice(0, 5),
    });

    // step the cursor back by a realistic gap
    const gap = Math.max(1, Math.round(spec.medianGapDays * (0.55 + rand() * 1.1)));
    cursor = publishedAt.getTime() - gap * 86_400_000;
  }

  return videos;
}

function channelRecord(
  spec: { slug: string; title: string; handle: string; description: string; subscribers: number; country: string },
  videos: GeneratedVideo[],
  channelId: string,
) {
  const totalViews = videos.reduce((a, v) => a + v.views, 0);
  return {
    channelId,
    handle: spec.handle,
    title: spec.title,
    description: spec.description,
    subscribers: spec.subscribers,
    // Lifetime views are larger than our sample window; scale plausibly.
    totalViews: Math.round(totalViews * 2.4),
    videoCount: videos.length + Math.round(videos.length * 1.3),
    thumbnailUrl: "",
    publishedAt: new Date(ANCHOR - 1400 * 86_400_000).toISOString(),
    country: spec.country,
  };
}

function seedChannelId(slug: string): string {
  // Stable, obviously-synthetic ids. 24 chars, UC-prefixed like the real thing.
  const base = slug.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return ("UCSEED" + base + "0".repeat(24)).slice(0, 24);
}

function main() {
  const outDir = path.join(process.cwd(), "data", "seed");
  fs.mkdirSync(outDir, { recursive: true });

  const manifest: Array<Record<string, unknown>> = [];

  for (const spec of SPECS) {
    const videos = generateVideos(spec);
    const channelId = seedChannelId(spec.slug);
    const dataset = {
      synthetic: true,
      note: "Synthetic sample channel generated by scripts/generateSeed.ts. Not a real creator's data.",
      anchor: new Date(ANCHOR).toISOString(),
      channel: channelRecord(spec, videos, channelId),
      videos,
    };
    fs.writeFileSync(path.join(outDir, `${spec.slug}.json`), JSON.stringify(dataset, null, 2));

    manifest.push({
      slug: spec.slug,
      channelId,
      title: spec.title,
      handle: spec.handle,
      aliases: [...spec.aliases, spec.slug, channelId],
      niche: spec.niche,
      subscribers: spec.subscribers,
      videoCount: videos.length,
      competitors: spec.competitors,
      isPrimaryDemo: true,
    });
    console.log(`seed: ${spec.slug} -> ${videos.length} videos`);
  }

  for (const comp of COMPETITORS) {
    const videos = generateVideos({ ...comp, patternWeight: {}, country: comp.country });
    const channelId = seedChannelId(comp.slug);
    const dataset = {
      synthetic: true,
      note: "Synthetic sample competitor channel generated by scripts/generateSeed.ts.",
      anchor: new Date(ANCHOR).toISOString(),
      channel: channelRecord(comp, videos, channelId),
      videos,
    };
    fs.writeFileSync(path.join(outDir, `${comp.slug}.json`), JSON.stringify(dataset, null, 2));
    manifest.push({
      slug: comp.slug,
      channelId,
      title: comp.title,
      handle: comp.handle,
      aliases: [comp.slug, comp.handle, `@${comp.handle}`, channelId],
      niche: "",
      subscribers: comp.subscribers,
      videoCount: videos.length,
      competitors: [],
      isPrimaryDemo: false,
    });
    console.log(`seed: ${comp.slug} -> ${videos.length} videos (competitor)`);
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), channels: manifest }, null, 2));
  console.log(`\nwrote ${manifest.length} seed datasets to data/seed/`);
}

main();
