/**
 * Two-tier cache: in-memory (always) + on-disk JSON (when the filesystem is
 * writable, i.e. local dev).
 *
 * Why bother: the YouTube Data API free tier is 10,000 quota units/day. A
 * single channel analysis costs ~3-5 units if you take the cheap path, but
 * repeated demo runs and competitor scans add up fast. Caching turns a live
 * demo into a near-instant replay and makes quota exhaustion during judging
 * essentially impossible.
 *
 * On Vercel the filesystem is read-only outside /tmp, so disk writes are
 * best-effort and every failure is swallowed — a cache is never allowed to
 * break a request.
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = Number(process.env.CHANNELIQ_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000);

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const memory = new Map<string, Entry<unknown>>();

function diskDir(): string | null {
  const candidates = [path.join(process.cwd(), ".cache"), path.join("/tmp", "channeliq-cache")];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

let resolvedDir: string | null | undefined;
function cacheDir(): string | null {
  if (resolvedDir === undefined) resolvedDir = diskDir();
  return resolvedDir;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

export function cacheGet<T>(key: string): T | null {
  const hit = memory.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.value as T;
    memory.delete(key);
  }

  const dir = cacheDir();
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, `${safeKey(key)}.json`), "utf8");
    const parsed = JSON.parse(raw) as Entry<T>;
    if (parsed.expiresAt > Date.now()) {
      memory.set(key, parsed as Entry<unknown>);
      return parsed.value;
    }
  } catch {
    // cold cache, corrupt file, or unreadable dir — all equivalent to a miss
  }
  return null;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
  const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
  memory.set(key, entry as Entry<unknown>);

  const dir = cacheDir();
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, `${safeKey(key)}.json`), JSON.stringify(entry), "utf8");
  } catch {
    // best effort only
  }
}

/** Memoise an async producer under `key`. Failures are never cached. */
export async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await produce();
  cacheSet(key, value, ttlMs);
  return value;
}

export function cacheHas(key: string): boolean {
  return cacheGet(key) !== null;
}
