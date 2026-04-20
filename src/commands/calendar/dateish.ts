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
    throw new AxiError(
      "Missing date/time value",
      "VALIDATION_ERROR",
      ["Use ISO format: 2026-04-20T14:00 or just 2026-04-20"],
    );
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Date-only: force local midnight instead of the spec-mandated UTC
    // midnight, matching our --help docs.
    const [y, m, d] = value.split("-").map((part) => Number(part));
    const local = new Date(y, m - 1, d, 0, 0, 0, 0);
    if (Number.isNaN(local.getTime())) {
      throw new AxiError(
        `Cannot parse date: ${value}`,
        "VALIDATION_ERROR",
        ["Use YYYY-MM-DD (e.g. 2026-04-20)"],
      );
    }
    return local.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AxiError(
      `Cannot parse date/time: ${value}`,
      "VALIDATION_ERROR",
      [
        "Use ISO 8601 format: 2026-04-20T14:00:00-04:00",
        "Local time: 2026-04-20T14:00 (no offset — interpreted as local)",
        "Date-only: 2026-04-20 (midnight local)",
      ],
    );
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
