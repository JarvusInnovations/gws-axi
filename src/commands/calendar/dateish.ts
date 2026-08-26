import { AxiError } from "axi-sdk-js";

/**
 * Parse a date-ish flag value into an ISO 8601 string.
 *
 * Rules:
 * - Date-only (`YYYY-MM-DD`) → LOCAL midnight of that date, expressed as
 *   ISO. We deliberately do NOT use `new Date("YYYY-MM-DD")` because the
 *   JS spec parses that as UTC midnight (a well-known footgun), which
 *   contradicts our docs ("midnight local").
 * - Datetime with offset (`YYYY-MM-DDTHH:MM:SS±HH:MM` or trailing `Z`)
 *   → parsed as-is, timezone preserved.
 * - Datetime without offset (`YYYY-MM-DDTHH:MM`) → parsed as local time
 *   per the JS spec (which for this format does use local).
 * - Anything else → AxiError with a clear format hint.
 *
 * Returns an ISO string (with timezone info) suitable for Google API
 * `timeMin` / `timeMax` parameters.
 */
export function parseDateishFlag(value: string): string {
  if (!value) {
    throw new AxiError("Missing date/time value", "VALIDATION_ERROR", [
      "Use ISO format: 2026-04-20T14:00 or just 2026-04-20",
    ]);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Date-only: force local midnight instead of the spec-mandated UTC
    // midnight, matching our --help docs.
    const [y, m, d] = value.split("-").map((part) => Number(part));
    const local = new Date(y, m - 1, d, 0, 0, 0, 0);
    if (Number.isNaN(local.getTime())) {
      throw new AxiError(`Cannot parse date: ${value}`, "VALIDATION_ERROR", [
        "Use YYYY-MM-DD (e.g. 2026-04-20)",
      ]);
    }
    return local.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AxiError(`Cannot parse date/time: ${value}`, "VALIDATION_ERROR", [
      "Use ISO 8601 format: 2026-04-20T14:00:00-04:00",
      "Local time: 2026-04-20T14:00 (no offset — interpreted as local)",
      "Date-only: 2026-04-20 (midnight local)",
    ]);
  }
  return parsed.toISOString();
}

/**
 * Format a Google Calendar dateTime/date field for detail-view output.
 * Timed events: datetime + "(IANA tz)" suffix when timeZone is set.
 * All-day events: "YYYY-MM-DD (all-day)".
 * Missing/empty: empty string.
 *
 * Use for single-event detail views (get, create, update, respond).
 * List views should stick to offset-only for compact columns.
 */
export function formatEventTime(
  value:
    | { dateTime?: string | null; date?: string | null; timeZone?: string | null }
    | null
    | undefined,
): string {
  if (!value) return "";
  if (value.dateTime) {
    return value.timeZone ? `${value.dateTime} (${value.timeZone})` : value.dateTime;
  }
  if (value.date) return `${value.date} (all-day)`;
  return "";
}

/**
 * Convert a UTC timestamp string (e.g. "2026-04-22T13:00:00Z") to an ISO
 * string with the system's local timezone offset (e.g.
 * "2026-04-22T09:00:00-04:00"). Useful for making freebusy output
 * consistent with events output, which already comes back in
 * offset-preserving form from Google.
 *
 * Invalid input returns the original string unchanged.
 */
export function toLocalOffsetISO(input: string): string {
  if (!input) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offsetStr = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    offsetStr
  );
}

// Range flags ──────────────────────────────────────────────────────
// See specs/api/conventions.md#time-ranges. Range flags (--from/--to,
// --since/--until) differ from instant flags (create/update --start/--end):
// a date-only value denotes a DAY, and which instant that becomes depends on
// which edge it lands on. `parseDateishFlag` above keeps instant semantics and
// is deliberately left alone — this layers on top of it.

export type RangeEdge = "from" | "to";

interface DayParts {
  y: number;
  m: number;
  d: number;
}

type ResolvedValue = { kind: "day"; parts: DayParts } | { kind: "instant"; date: Date };

/**
 * Local midnight of a day, optionally shifted by whole days.
 *
 * The local `Date` constructor with an out-of-range day component is what makes
 * this DST-, month- and year-rollover-correct in one stroke. Never do this with
 * millisecond addition: `+ 86_400_000` across a DST boundary lands on 23:00 or
 * 01:00, not midnight.
 */
function localMidnight(parts: DayParts, plusDays = 0): Date {
  return new Date(parts.y, parts.m - 1, parts.d + plusDays, 0, 0, 0, 0);
}

function partsOf(date: Date): DayParts {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

function dayOffsetFrom(now: Date, days: number): ResolvedValue {
  return { kind: "day", parts: partsOf(localMidnight(partsOf(now), days)) };
}

const RELATIVE_RE = /^([+-])(\d+)([dwh])$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a relative/named token. Returns undefined when `value` isn't one, so
 * the caller can fall through to literal parsing.
 */
function resolveToken(value: string, now: Date): ResolvedValue | undefined {
  const v = value.trim().toLowerCase();
  switch (v) {
    case "now":
      return { kind: "instant", date: new Date(now.getTime()) };
    case "today":
      return dayOffsetFrom(now, 0);
    case "tomorrow":
      return dayOffsetFrom(now, 1);
    case "yesterday":
      return dayOffsetFrom(now, -1);
  }

  const rel = RELATIVE_RE.exec(v);
  if (!rel) return undefined;

  const sign = rel[1] === "-" ? -1 : 1;
  const n = Number(rel[2]);
  const unit = rel[3];
  // Hours are instant-precision (no day expansion); days/weeks are day-precision.
  if (unit === "h") {
    return { kind: "instant", date: new Date(now.getTime() + sign * n * 3600 * 1000) };
  }
  return dayOffsetFrom(now, sign * n * (unit === "w" ? 7 : 1));
}

function materialize(resolved: ResolvedValue, edge: RangeEdge): string {
  if (resolved.kind === "instant") return resolved.date.toISOString();
  // Day precision: the `from` edge opens at that day's midnight, the `to` edge
  // closes at the NEXT midnight so the named day is included (ranges are
  // half-open). This is the whole point — `--from D --to D` is all of day D.
  return localMidnight(resolved.parts, edge === "to" ? 1 : 0).toISOString();
}

/**
 * Parse one range-flag value into an ISO instant, honoring per-edge day
 * expansion and relative tokens. Anything that isn't a token or a bare date
 * falls through to `parseDateishFlag` unchanged (instant semantics, existing
 * error messages).
 */
export function parseRangeFlag(value: string, edge: RangeEdge, now: Date = new Date()): string {
  if (!value) {
    throw new AxiError("Missing date/time value", "VALIDATION_ERROR", [
      "Use a date (2026-04-20), a datetime (2026-04-20T14:00), or a token (today, tomorrow, +7d)",
    ]);
  }

  const token = resolveToken(value, now);
  if (token) return materialize(token, edge);

  if (DATE_ONLY_RE.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const probe = localMidnight({ y, m, d });
    if (Number.isNaN(probe.getTime())) {
      throw new AxiError(`Cannot parse date: ${value}`, "VALIDATION_ERROR", [
        "Use YYYY-MM-DD (e.g. 2026-04-20)",
      ]);
    }
    return materialize({ kind: "day", parts: { y, m, d } }, edge);
  }

  return parseDateishFlag(value);
}

/** Local midnight of the most recent `weekStartDay` (0=Sun … 6=Sat) on or before `now`. */
export function startOfWeek(now: Date, weekStartDay: number): Date {
  const back = (now.getDay() - weekStartDay + 7) % 7;
  return localMidnight(partsOf(now), -back);
}

export interface WindowInput {
  /** Raw, unresolved flag values — resolution happens here so errors can quote what was typed. */
  from?: string;
  to?: string;
  today?: boolean;
  thisWeek?: boolean;
}

export interface WindowOptions {
  /** Already-ISO fallbacks used when the corresponding flag is absent. */
  defaults?: { from?: string; to?: string };
  /** Flag spellings for error messages — `drive activity` uses --since/--until. */
  flagNames?: { from: string; to: string };
  /** 0=Sun … 6=Sat. Callers resolve this from the account before calling. */
  weekStartDay?: number;
  /**
   * Whether the calling command actually offers --today/--this-week. False for
   * `drive activity`, whose errors must not suggest flags it doesn't have
   * (principles.md#no-dead-end-surfaces).
   */
  shortcuts?: boolean;
  now?: Date;
}

/**
 * Resolve `--today` / `--this-week` / `--from` / `--to` into one validated
 * window. Single source of truth for the shortcut-conflict and empty-window
 * rules so no call site re-implements them.
 */
export function resolveWindow(
  input: WindowInput,
  options: WindowOptions = {},
): { from: string | undefined; to: string | undefined } {
  const now = options.now ?? new Date();
  const names = options.flagNames ?? { from: "--from", to: "--to" };
  const shortcuts: string[] = [];
  if (input.today) shortcuts.push("--today");
  if (input.thisWeek) shortcuts.push("--this-week");

  if (shortcuts.length > 1) {
    throw new AxiError(`Cannot combine ${shortcuts.join(" and ")}`, "VALIDATION_ERROR", [
      "Pass one window shortcut, or an explicit range with " + `${names.from} / ${names.to}`,
    ]);
  }

  if (shortcuts.length === 1) {
    const explicit = [
      input.from !== undefined ? names.from : undefined,
      input.to !== undefined ? names.to : undefined,
    ].filter(Boolean);
    if (explicit.length > 0) {
      throw new AxiError(
        `Cannot combine ${shortcuts[0]} with ${explicit.join(" / ")}`,
        "VALIDATION_ERROR",
        [
          `Use ${shortcuts[0]} on its own for that window`,
          `Or drop ${shortcuts[0]} and set the range explicitly with ${names.from} / ${names.to}`,
        ],
      );
    }

    const start = input.today
      ? localMidnight(partsOf(now))
      : startOfWeek(now, options.weekStartDay ?? 1);
    const span = input.today ? 1 : 7;
    return {
      from: start.toISOString(),
      to: localMidnight(partsOf(start), span).toISOString(),
    };
  }

  const from =
    input.from !== undefined ? parseRangeFlag(input.from, "from", now) : options.defaults?.from;
  const to = input.to !== undefined ? parseRangeFlag(input.to, "to", now) : options.defaults?.to;

  // A window that cannot match anything must never render as an empty list —
  // "no events found in the given time range" reads as "nothing is scheduled".
  if (from !== undefined && to !== undefined && new Date(from) >= new Date(to)) {
    throw new AxiError(
      `Empty time range: ${names.from} ${toLocalOffsetISO(from)} is not before ${names.to} ${toLocalOffsetISO(to)}`,
      "VALIDATION_ERROR",
      [
        `A date-only ${names.to} already covers that whole day — ${names.from} 2026-04-20 ${names.to} 2026-04-20 is all of April 20`,
        ...(options.shortcuts === false
          ? []
          : ["Use --today for today, or --this-week for the current week"]),
        `Otherwise make ${names.to} later than ${names.from}`,
      ],
    );
  }

  return { from, to };
}
