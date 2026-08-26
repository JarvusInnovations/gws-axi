import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { settingsPathForAccount } from "../../config.js";
import { calendarClient } from "../../google/client.js";

/**
 * The account's own Calendar `weekStart` preference, used by `--this-week`.
 *
 * "This week" means the week as the caller's calendar draws it, so the boundary
 * comes from their Google setting rather than a constant (see
 * specs/api/conventions.md#window-shortcuts). The read is authorized by the
 * existing `calendar` scope — no new grant — but it is a preference lookup
 * decorating a query, so it is cached and can never fail the query it serves.
 */

/** Google returns "0" (Sunday), "1" (Monday) or "6" (Saturday). */
const WEEK_START_LABELS: Record<number, string> = {
  0: "sunday",
  1: "monday",
  6: "saturday",
};

const FALLBACK_DAY = 1;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

export type WeekStartSource = "account" | "cache" | "fallback";

export interface WeekStart {
  /** 0=Sunday … 6=Saturday. */
  day: number;
  label: string;
  source: WeekStartSource;
}

interface CachedSettings {
  week_start?: number;
  fetched?: string;
}

function labelFor(day: number): string {
  return WEEK_START_LABELS[day] ?? `day ${day}`;
}

function fallback(): WeekStart {
  return { day: FALLBACK_DAY, label: labelFor(FALLBACK_DAY), source: "fallback" };
}

function readCache(account: string): number | undefined {
  try {
    const path = settingsPathForAccount(account);
    if (!existsSync(path)) return undefined;
    const cached = JSON.parse(readFileSync(path, "utf-8")) as CachedSettings;
    if (typeof cached.week_start !== "number" || !cached.fetched) return undefined;
    const age = Date.now() - new Date(cached.fetched).getTime();
    if (!Number.isFinite(age) || age >= CACHE_TTL_MS) return undefined;
    return cached.week_start;
  } catch {
    // Corrupt or unreadable cache is a cache miss, never an error.
    return undefined;
  }
}

function writeCache(account: string, day: number): void {
  try {
    const path = settingsPathForAccount(account);
    mkdirSync(dirname(path), { recursive: true });
    // Merge so a future cached setting isn't dropped by this write.
    let existing: CachedSettings = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf-8")) as CachedSettings;
      } catch {
        existing = {};
      }
    }
    const next = { ...existing, week_start: day, fetched: new Date().toISOString() };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // A cache we can't persist just means we refetch next time.
  }
}

/**
 * Resolve the account's week-start day, preferring a fresh cache entry.
 * Never throws: any failure degrades to Monday with `source: "fallback"`, which
 * the caller discloses in its output.
 */
export async function resolveWeekStart(account: string): Promise<WeekStart> {
  const cached = readCache(account);
  if (cached !== undefined) {
    return { day: cached, label: labelFor(cached), source: "cache" };
  }

  try {
    const api = await calendarClient(account);
    const res = await api.settings.get({ setting: "weekStart" });
    const day = Number(res.data.value);
    if (!Number.isInteger(day) || day < 0 || day > 6) return fallback();
    writeCache(account, day);
    return { day, label: labelFor(day), source: "account" };
  } catch {
    return fallback();
  }
}
