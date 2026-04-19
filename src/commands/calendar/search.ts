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
import { parseDateishFlag } from "./dateish.js";

export const SEARCH_HELP = `usage: gws-axi calendar search --query <text> [flags]
flags[9]:
  --query <text>         REQUIRED — full-text search across summary/description/location/attendees
  --from <iso>           Earliest event start (default: 30 days ago)
  --to <iso>             Latest event start (default: 1 year from now)
  --calendars <ids>      Comma-separated calendar IDs (overrides scope default)
  --include-shared       Include calendars you're subscribed to but don't own
                         (team members', shared projects, etc.). Default is
                         owned calendars only (primary + any you created).
  --limit <n>            Max events PER calendar (default: 50, max: 2500)
  --fields <list>        Extra columns: status, organizer, location, attendees, seen_on
  --no-dedupe            Keep per-calendar duplicates; one row per (calendar, event) pair
  --account <email>      Account override when 2+ are configured
examples:
  gws-axi calendar search --query "standup"
  gws-axi calendar search --query "budget" --from 2025-01-01
  gws-axi calendar search --query "chris" --include-shared
  gws-axi calendar search --query "chris" --calendars primary,team@jarv.us
scope:
  By default searches ONLY calendars you own (primary + self-created).
  Team members' calendars you've added to see their availability are
  skipped unless --include-shared is passed or they're in --calendars.
dedupe:
  Shared events (one event visible on multiple of your calendars) are
  collapsed to one row by default — \`calendar\` shows the first
  calendar seen, seen_on_count reports the total. Pass --fields seen_on
  for the full list. Use --no-dedupe to get per-calendar rows.
  Use \`calendar events\` (single calendar, narrower range) when you
  already know which calendar to query.
default columns:
  calendar, id, summary (truncated 80), start, end, my_response,
  seen_on_count (only shown when > 1)
`;

interface ParsedFlags {
  query: string | undefined;
  from: string;
  to: string;
  calendarFilter: string[] | undefined;
  includeShared: boolean;
  limit: number;
  extraFields: string[];
  dedupe: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const now = Date.now();
  const flags: ParsedFlags = {
    query: undefined,
    from: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
    to: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
    calendarFilter: undefined,
    includeShared: false,
    limit: 50,
    extraFields: [],
    dedupe: true,
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
        flags.from = parseDateishFlag(next);
        i++;
        break;
      case "--to":
        flags.to = parseDateishFlag(next);
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
      case "--no-dedupe":
        flags.dedupe = false;
        break;
      case "--include-shared":
        flags.includeShared = true;
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

function schemaWithExtras(
  extras: string[],
  showSeenCount: boolean,
): FieldDef[] {
  const base = baseSchema();
  // Rename "_calendar" column to "calendar" for display — leading underscore
  // was just to avoid clashing with any Google-API field named "calendar"
  base[0] = { name: "calendar", extract: (item) => item._calendar };

  if (showSeenCount) {
    // Insert seen_on_count right after `calendar` so related fields cluster
    base.splice(1, 0, {
      name: "seen_on_count",
      extract: (item) => {
        const s = item._seen_on as string[] | undefined;
        return s?.length ?? 1;
      },
    });
  }

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
      case "seen_on":
        base.push({
          name: "seen_on",
          extract: (item) => {
            const s = item._seen_on as string[] | undefined;
            return s?.join(",") ?? (item._calendar as string) ?? "";
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
  // as-is. Otherwise list accessible calendars and by default filter to
  // owned ones only (primary + calendars the user created). Calendars the
  // user has merely subscribed to (team members', shared projects) are
  // opted into via --include-shared.
  let calendarIds: string[];
  let skippedSharedCount = 0;
  if (flags.calendarFilter) {
    calendarIds = flags.calendarFilter;
  } else {
    try {
      const listRes = await api.calendarList.list({
        maxResults: 250,
        showHidden: false,
      });
      const all = listRes.data.items ?? [];
      const owned = all.filter(
        (c) => c.accessRole === "owner" || c.primary === true,
      );
      const shared = all.filter(
        (c) => c.accessRole !== "owner" && c.primary !== true,
      );
      const selected = flags.includeShared ? [...owned, ...shared] : owned;
      if (!flags.includeShared) skippedSharedCount = shared.length;
      calendarIds = selected
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
  const flat = results.flatMap((r) =>
    r.items.map((e) => ({ ...e, _calendar: r.calendarId }) as Record<string, unknown>),
  );

  // Optional dedupe by event.id: shared team events appear once per
  // calendar they're visible on. Default-on since the noise is
  // significant (one event on 15 calendars ⇒ 15 rows in raw merge).
  let merged: Record<string, unknown>[];
  let duplicatesCollapsed = 0;
  let anyDuplicates = false;
  if (flags.dedupe) {
    const byId = new Map<string, Record<string, unknown>>();
    const noId: Record<string, unknown>[] = [];
    for (const item of flat) {
      const id = item.id as string | undefined;
      if (!id) {
        noId.push({ ...item, _seen_on: [item._calendar as string] });
        continue;
      }
      const existing = byId.get(id);
      if (existing) {
        (existing._seen_on as string[]).push(item._calendar as string);
        duplicatesCollapsed++;
      } else {
        byId.set(id, { ...item, _seen_on: [item._calendar as string] });
      }
    }
    merged = [...noId, ...Array.from(byId.values())];
    anyDuplicates = duplicatesCollapsed > 0;
  } else {
    merged = flat.map((item) => ({ ...item, _seen_on: [item._calendar as string] }));
  }

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
  const anyCalendarHitLimit = results.some(
    (r) => r.items.length >= flags.limit,
  );

  const header: Record<string, unknown> = {
    account,
    query: flags.query,
  };

  const summary: Record<string, unknown> = {
    count: merged.length,
    calendars_searched: succeededCount,
    range: `${flags.from} → ${flags.to}`,
  };
  if (flags.dedupe) {
    summary.dedupe = true;
    if (duplicatesCollapsed > 0) {
      summary.duplicates_collapsed = duplicatesCollapsed;
    }
  }
  if (erroredCalendars.length > 0) {
    summary.calendars_with_errors = erroredCalendars.length;
  }
  if (anyCalendarHitLimit) {
    summary.more_available = true;
    summary.per_calendar_limit = flags.limit;
  }
  if (skippedSharedCount > 0 && !flags.includeShared) {
    summary.shared_calendars_skipped = skippedSharedCount;
  }

  const schema = schemaWithExtras(flags.extraFields, anyDuplicates);

  const suggestions: string[] = [];
  if (merged.length > 0) {
    suggestions.push(
      "Run `gws-axi calendar get <id> --calendar <calendar>` for full event details",
    );
    if (anyDuplicates && !flags.extraFields.includes("seen_on")) {
      suggestions.push(
        "Add `--fields seen_on` to see the full calendar list for shared events",
      );
    }
    if (flags.extraFields.length === 0) {
      suggestions.push(
        "Add `--fields attendees,location,organizer` to enrich the output",
      );
    }
    if (anyCalendarHitLimit) {
      suggestions.push(
        `At least one calendar returned the full --limit (${flags.limit}) — raise --limit or narrow --from/--to to avoid truncation`,
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
  if (skippedSharedCount > 0 && !flags.includeShared) {
    suggestions.push(
      `Skipped ${skippedSharedCount} shared/subscribed calendar(s) — add --include-shared to search them too`,
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
