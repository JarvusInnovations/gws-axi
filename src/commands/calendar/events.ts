import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  mapEnum,
  pluck,
  renderListResponse,
  truncated,
  type FieldDef,
} from "../../output/index.js";
import { parseDateishFlag } from "./dateish.js";

export const EVENTS_HELP = `usage: gws-axi calendar events [flags]
flags[8]:
  --calendar <id>      Calendar to query (default: "primary")
  --from <iso>         Earliest event start (default: now)
  --to <iso>           Latest event start (default: 7 days from now)
  --limit <n>          Max events to return (default: 25, max: 2500)
  --query <text>       Full-text search across summary/description/location/attendees
  --single-events      Expand recurring events into individual instances (default: true)
  --fields <list>      Extra columns: status, organizer, location, attendees, description, htmlLink, hangoutLink
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi calendar events
  gws-axi calendar events --from 2026-04-20T00:00 --to 2026-04-21T00:00
  gws-axi calendar events --calendar team@jarv.us --limit 50
  gws-axi calendar events --query standup
  gws-axi calendar events --fields status,attendees,location
time formats:
  Timed events:  ISO 8601 with offset — 2026-04-20T14:00:00-04:00
  Local time:    2026-04-20T14:00 (interpreted as local tz)
  Date-only:     2026-04-20 (midnight local)
output note:
  The start/end columns use datetime (with offset) for timed events
  and date-only strings for all-day events. Agents parsing these
  columns must handle both formats.
default columns:
  id, summary, start, end, my_response (your responseStatus if you're
  an attendee; blank for self-organized events with no attendee list),
  attachments (compact count; "(N Docs)" suffix when meeting notes /
  Gemini Notes Docs are attached — chase any with \`calendar get <id>\`
  to see file_ids and hand off to \`docs read\`).
  status column suppressed by default (most events are "confirmed" —
  add --fields status to see cancelled/tentative).
`;

interface ParsedFlags {
  calendar: string;
  from: string;
  to: string;
  limit: number;
  query: string | undefined;
  singleEvents: boolean;
  extraFields: string[];
}

function parseEventsFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    calendar: "primary",
    from: new Date().toISOString(),
    to: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    limit: 25,
    query: undefined,
    singleEvents: true,
    extraFields: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--calendar":
        flags.calendar = next;
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
      case "--limit":
        flags.limit = Math.min(2500, Math.max(1, parseInt(next, 10) || 25));
        i++;
        break;
      case "--query":
        flags.query = next;
        i++;
        break;
      case "--single-events":
        flags.singleEvents = next === "false" ? false : true;
        if (next === "false" || next === "true") i++;
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
    field("id"),
    truncated("summary", 80),
    // start.dateTime for timed events, start.date for all-day — pluck either
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
    // my_response: responseStatus of the attendee flagged `self: true`.
    // Blank when the user is the sole organizer or not in the attendee
    // list. Most common use: agents filtering for "am I actually going?"
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
    // attachments: compact count, with "(N Docs)" suffix when at least
    // one is a Google Doc — meeting-notes / Gemini Notes show up here,
    // and surfacing them by default lets agents notice "this event has
    // a transcript" without having to expand into `calendar get`.
    {
      name: "attachments",
      extract: (item) => {
        const a = item.attachments as
          | Array<{ mimeType?: string }>
          | undefined;
        if (!a?.length) return "";
        const docs = a.filter(
          (x) => x.mimeType === "application/vnd.google-apps.document",
        ).length;
        return docs > 0 && docs < a.length
          ? `${a.length} (${docs} Doc${docs === 1 ? "" : "s"})`
          : `${a.length}`;
      },
    },
  ];
}

function schemaWithExtras(extras: string[]): FieldDef[] {
  const base = baseSchema();
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
        base.push(pluck("organizer", "email", "organizer"));
        break;
      case "location":
        base.push(truncated("location", 40));
        break;
      case "attendees":
        base.push({
          name: "attendees",
          extract: (item) => {
            const a = item.attendees as
              | Array<{ email?: string; responseStatus?: string }>
              | undefined;
            if (!a?.length) return "";
            const counts = a.reduce(
              (acc, x) => {
                const key = x.responseStatus ?? "other";
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            );
            return `${a.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`;
          },
        });
        break;
      case "htmlLink":
        base.push(field("htmlLink"));
        break;
      case "description":
        base.push(truncated("description", 100));
        break;
      case "hangoutLink":
        base.push(field("hangoutLink"));
        break;
      default:
        // Unknown field — skip silently rather than error. Keeps --fields
        // lenient (user doesn't need to know exact field names).
        break;
    }
  }
  return base;
}

export async function calendarEventsCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseEventsFlags(args);

  const api = await calendarClient(account);
  const requestParams: calendar_v3.Params$Resource$Events$List = {
    calendarId: flags.calendar,
    timeMin: flags.from,
    timeMax: flags.to,
    maxResults: flags.limit,
    singleEvents: flags.singleEvents,
    orderBy: flags.singleEvents ? "startTime" : undefined,
    q: flags.query,
  };

  let data: calendar_v3.Schema$Events;
  try {
    const res = await api.events.list(requestParams);
    data = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "calendar.events.list",
    });
    // Enrich NOT_FOUND with calendar-specific recovery hints; the generic
    // translator doesn't know the request was scoped to a calendarId.
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Calendar '${flags.calendar}' not found${flags.calendar === "primary" ? "" : ` (or ${account} doesn't have access)`}`,
        "CALENDAR_NOT_FOUND",
        [
          `Run \`gws-axi calendar calendars --account ${account}\` to list accessible calendars`,
          `Use --calendar primary to query ${account}'s default calendar`,
        ],
      );
    }
    throw translated;
  }

  const items = (data.items ?? []) as Array<Record<string, unknown>>;
  const schema = schemaWithExtras(flags.extraFields);

  const header: Record<string, unknown> = { account };
  if (flags.calendar !== "primary") {
    header.calendar = flags.calendar;
  }

  const summary: Record<string, unknown> = {
    count: items.length,
    range: `${flags.from} → ${flags.to}`,
  };
  if (flags.query) {
    summary.query = flags.query;
  }
  if (data.nextPageToken) {
    summary.more_available = true;
  }

  const suggestions: string[] = [];
  if (items.length > 0) {
    suggestions.push(
      `Run \`gws-axi calendar get <id>\` for full event details (id is the first column)`,
    );
    if (data.nextPageToken) {
      suggestions.push(
        `Increase --limit or narrow --from/--to to see more events (currently capped at ${flags.limit})`,
      );
    }
    if (flags.extraFields.length === 0) {
      suggestions.push(
        `Add \`--fields attendees,location,status\` to show more columns`,
      );
    }
    if (flags.calendar === "primary") {
      suggestions.push(
        `Query a different calendar with \`--calendar <id>\` (list them with \`gws-axi calendar calendars\`)`,
      );
    }
  } else {
    // Empty-result-specific hints — don't recycle the general ones above.
    if (flags.query) {
      suggestions.push(
        `Remove --query to show all events in the range, or try a broader search term`,
      );
    }
    suggestions.push(
      `Broaden the time range with --from / --to (current: ${flags.from} → ${flags.to})`,
    );
    if (flags.calendar === "primary") {
      suggestions.push(
        `Try a different calendar with \`--calendar <id>\` (list them with \`gws-axi calendar calendars\`)`,
      );
    }
  }

  return renderListResponse({
    header,
    summary,
    name: "events",
    items,
    schema,
    suggestions,
    emptyMessage: flags.query
      ? `no events matched "${flags.query}" in the given time range`
      : "no events found in the given time range",
  });
}
