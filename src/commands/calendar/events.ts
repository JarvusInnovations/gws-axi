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

export const EVENTS_HELP = `usage: gws-axi calendar events [flags]
flags[8]:
  --calendar <id>      Calendar to query (default: "primary")
  --from <iso-or-rel>  Earliest event start (default: now)
  --to <iso-or-rel>    Latest event start (default: 7 days from now)
  --limit <n>          Max events to return (default: 25, max: 2500)
  --query <text>       Full-text search across summary/description/location/attendees
  --single-events      Expand recurring events into individual instances (default: true)
  --fields <list>      Comma-separated extra fields to include in output
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi calendar events
  gws-axi calendar events --from 2026-04-20T00:00 --to 2026-04-21T00:00
  gws-axi calendar events --calendar team@jarv.us --limit 50
  gws-axi calendar events --query standup
time formats:
  ISO 8601: 2026-04-20T14:00:00-04:00 (precise, timezone explicit)
  ISO short: 2026-04-20T14:00 (local time)
  date only: 2026-04-20 (midnight local)
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
        flags.from = parseDateish(next);
        i++;
        break;
      case "--to":
        flags.to = parseDateish(next);
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

function parseDateish(value: string): string {
  if (!value) {
    throw new AxiError(
      "Missing date/time value",
      "VALIDATION_ERROR",
      ["Use ISO format: 2026-04-20T14:00 or just 2026-04-20"],
    );
  }
  // Accept ISO 8601 directly. If it parses, use the parsed form (normalizes
  // time zone). If not, raise a clear error — we're deliberately not doing
  // natural-language parsing in v1.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AxiError(
      `Cannot parse date/time: ${value}`,
      "VALIDATION_ERROR",
      [
        "Use ISO 8601 format: 2026-04-20T14:00:00-04:00",
        "Or date-only: 2026-04-20",
        "Natural-language dates (e.g. 'tomorrow 2pm') are not supported in v1",
      ],
    );
  }
  return parsed.toISOString();
}

function baseSchema(): FieldDef[] {
  return [
    field("id"),
    truncated("summary", 60),
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
    mapEnum(
      "status",
      { confirmed: "ok", tentative: "tentative", cancelled: "cancelled" },
      "unknown",
    ),
  ];
}

function schemaWithExtras(extras: string[]): FieldDef[] {
  const base = baseSchema();
  for (const extra of extras) {
    switch (extra) {
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
    throw translateGoogleError(err, {
      account,
      operation: "calendar.events.list",
    });
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
      `Run \`gws-axi calendar get <id>\` for full event details (use the id from the first column)`,
    );
  }
  if (data.nextPageToken) {
    suggestions.push(
      `Increase --limit or narrow --from/--to to see more events (currently capped at ${flags.limit})`,
    );
  }
  if (!flags.extraFields.includes("attendees")) {
    suggestions.push(
      `Add \`--fields attendees,location\` to show attendee status and location`,
    );
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
