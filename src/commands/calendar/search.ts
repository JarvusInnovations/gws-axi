import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  mapEnum,
  renderListResponse,
  truncated,
  type FieldDef,
} from "../../output/index.js";

export const SEARCH_HELP = `usage: gws-axi calendar search --query <text> [flags]
flags[7]:
  --query <text>         REQUIRED — full-text search across summary/description/location/attendees
  --from <iso>           Earliest event start (default: 30 days ago)
  --to <iso>             Latest event start (default: 1 year from now)
  --calendars <ids>      Comma-separated calendar IDs (default: all accessible)
  --limit <n>            Max events PER calendar (default: 50, max: 2500)
  --fields <list>        Extra columns: status, organizer, location, attendees
  --account <email>      Account override when 2+ are configured
examples:
  gws-axi calendar search --query "standup"
  gws-axi calendar search --query "budget" --from 2025-01-01
  gws-axi calendar search --query "chris" --calendars primary,team@jarv.us
notes:
  Queries events.list for each accessible calendar in parallel and merges
  results sorted by start time. Use \`calendar events\` (single calendar,
  narrower default range) when you already know which calendar to query.
default columns:
  calendar, id, summary (truncated 80), start, end, my_response
`;

interface ParsedFlags {
  query: string | undefined;
  from: string;
  to: string;
  calendarFilter: string[] | undefined;
  limit: number;
  extraFields: string[];
}

function parseDateish(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AxiError(
      `Cannot parse date/time: ${value}`,
      "VALIDATION_ERROR",
      ["Use ISO 8601 (e.g. 2026-04-20T14:00 or 2026-04-20)"],
    );
  }
  return parsed.toISOString();
}

function parseFlags(args: string[]): ParsedFlags {
  const now = Date.now();
  const flags: ParsedFlags = {
    query: undefined,
    from: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
    to: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
    calendarFilter: undefined,
    limit: 50,
    extraFields: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--query":
        flags.query = next;
        i++;
        break;
      case "--from":
        flags.from = parseDateish(next);
        i++;
        break;
      case "--to":
        flags.to = parseDateish(next);
        i++;
        break;
      case "--calendars":
        flags.calendarFilter = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--limit":
        flags.limit = Math.min(2500, Math.max(1, parseInt(next, 10) || 50));
        i++;
        break;
      case "--fields":
        flags.extraFields = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
    }
  }
  return flags;
}

function baseSchema(): FieldDef[] {
  return [
    field("_calendar"),
    field("id"),
    truncated("summary", 80),
    {
      name: "start",
      extract: (item) => {
        const s = item.start as
          | { dateTime?: string; date?: string }
          | undefined;
        return s?.dateTime ?? s?.date ?? "";
      },
    },
    {
      name: "end",
      extract: (item) => {
        const e = item.end as
          | { dateTime?: string; date?: string }
          | undefined;
        return e?.dateTime ?? e?.date ?? "";
      },
    },
    {
      name: "my_response",
      extract: (item) => {
        const attendees = item.attendees as
          | Array<{ self?: boolean; responseStatus?: string }>
          | undefined;
        if (!attendees?.length) return "";
        const me = attendees.find((a) => a.self);
        return me?.responseStatus ?? "";
      },
    },
  ];
}

function schemaWithExtras(extras: string[]): FieldDef[] {
  const base = baseSchema();
  // Rename "_calendar" column to "calendar" for display — leading underscore
  // was just to avoid clashing with any Google-API field named "calendar"
  base[0] = { name: "calendar", extract: (item) => item._calendar };

  for (const extra of extras) {
    switch (extra) {
      case "status":
        base.push(
          mapEnum(
            "status",
            { confirmed: "ok", tentative: "tentative", cancelled: "cancelled" },
            "unknown",
          ),
        );
        break;
      case "organizer":
        base.push({
          name: "organizer",
          extract: (item) => {
            const o = item.organizer as { email?: string } | undefined;
            return o?.email ?? "";
          },
        });
        break;
      case "location":
        base.push(truncated("location", 40));
        break;
      case "attendees":
        base.push({
          name: "attendees",
          extract: (item) => {
            const a = item.attendees as Array<unknown> | undefined;
            return a?.length ?? 0;
          },
        });
        break;
    }
  }
  return base;
}

export async function calendarSearchCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  if (!flags.query) {
    throw new AxiError(
      "--query is required",
      "VALIDATION_ERROR",
      [
        "Example: gws-axi calendar search --query 'standup'",
        "For a time-range listing without search, use `gws-axi calendar events`",
      ],
    );
  }

  const api = await calendarClient(account);

  // Resolve which calendars to query. If user specified --calendars, use those
  // as-is. Otherwise list all accessible calendars.
  let calendarIds: string[];
  if (flags.calendarFilter) {
    calendarIds = flags.calendarFilter;
  } else {
    try {
      const listRes = await api.calendarList.list({
        maxResults: 250,
        showHidden: false,
      });
      calendarIds = (listRes.data.items ?? [])
        .map((c) => c.id)
        .filter((id): id is string => typeof id === "string");
    } catch (err) {
      throw translateGoogleError(err, {
        account,
        operation: "calendar.calendarList.list",
      });
    }
  }

  if (calendarIds.length === 0) {
    throw new AxiError(
      "No calendars to search",
      "NO_CALENDARS",
      [`Run \`gws-axi calendar calendars --account ${account}\` to diagnose`],
    );
  }

  interface CalendarResult {
    calendarId: string;
    items: calendar_v3.Schema$Event[];
    error?: string;
  }

  // Parallel events.list per calendar — silently skip calendars that 404 or
  // 403 (user lost access, deleted calendar, etc.) rather than abort.
  const results: CalendarResult[] = await Promise.all(
    calendarIds.map(async (calendarId) => {
      try {
        const res = await api.events.list({
          calendarId,
          timeMin: flags.from,
          timeMax: flags.to,
          maxResults: flags.limit,
          singleEvents: true,
          orderBy: "startTime",
          q: flags.query,
        });
        return { calendarId, items: res.data.items ?? [] };
      } catch (err) {
        return {
          calendarId,
          items: [],
          error:
            err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
        };
      }
    }),
  );

  // Tag each event with its source calendar, flatten, and sort by start time
  const merged = results.flatMap((r) =>
    r.items.map((e) => ({ ...e, _calendar: r.calendarId }) as Record<string, unknown>),
  );
  merged.sort((a, b) => {
    const startA =
      (a.start as { dateTime?: string; date?: string } | undefined)?.dateTime ??
      (a.start as { dateTime?: string; date?: string } | undefined)?.date ??
      "";
    const startB =
      (b.start as { dateTime?: string; date?: string } | undefined)?.dateTime ??
      (b.start as { dateTime?: string; date?: string } | undefined)?.date ??
      "";
    return String(startA).localeCompare(String(startB));
  });

  const erroredCalendars = results.filter((r) => r.error);
  const succeededCount = results.length - erroredCalendars.length;

  const header: Record<string, unknown> = {
    account,
    query: flags.query,
  };

  const summary: Record<string, unknown> = {
    count: merged.length,
    calendars_searched: succeededCount,
    range: `${flags.from} → ${flags.to}`,
  };
  if (erroredCalendars.length > 0) {
    summary.calendars_with_errors = erroredCalendars.length;
  }

  const schema = schemaWithExtras(flags.extraFields);

  const suggestions: string[] = [];
  if (merged.length > 0) {
    suggestions.push(
      "Run `gws-axi calendar get <id> --calendar <calendar>` for full event details",
    );
    if (flags.extraFields.length === 0) {
      suggestions.push(
        "Add `--fields attendees,location,organizer` to enrich the output",
      );
    }
  } else {
    suggestions.push(
      `No matches — try a broader query, widen --from/--to, or check different calendars`,
    );
  }
  if (erroredCalendars.length > 0) {
    suggestions.push(
      `${erroredCalendars.length} calendar(s) had errors — narrow with --calendars to isolate`,
    );
  }

  return renderListResponse({
    header,
    summary,
    name: "events",
    items: merged,
    schema,
    suggestions,
    emptyMessage: `no events matched "${flags.query}" across ${succeededCount} calendar(s)`,
  });
}
