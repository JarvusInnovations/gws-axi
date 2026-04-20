import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderObject } from "../../output/index.js";
import { formatEventTime, parseDateishFlag } from "./dateish.js";

export const CREATE_HELP = `usage: gws-axi calendar create --summary <text> --start <iso> [flags]
flags[13]:
  --summary <text>       REQUIRED — event title
  --start <iso>          REQUIRED — event start (ISO datetime or YYYY-MM-DD for all-day)
  --end <iso>            End time (default: start + 1h for timed, start + 1d for all-day)
  --duration <h|m>       Alternative to --end, e.g. "1h", "30m", "90m", "1h30m"
  --all-day              Treat --start as a date (not datetime); all-day event
  --description <text>   Multi-line ok; pass via shell heredoc or quoted string
  --location <text>      Freeform location string
  --attendees <emails>   Comma-separated emails (no spaces). Invites sent per --send-updates
  --timezone <tz>        IANA TZ (e.g. America/New_York) for timed events (default: calendar's tz)
  --recurrence <rrule>   RFC 5545 RRULE (e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR")
  --send-updates <mode>  none | all | externalOnly (default: none — agent-safe)
  --calendar <id>        Calendar to write to (default: primary)
  --account <email>      REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi calendar create --summary "Team sync" --start 2026-04-22T14:00 --duration 30m
  gws-axi calendar create --summary "Holiday" --start 2026-05-26 --all-day
  gws-axi calendar create --summary "1:1" --start 2026-04-22T10:00 --end 2026-04-22T10:30 --attendees alice@x.com,bob@x.com --send-updates all
notes:
  --send-updates defaults to "none" so agent-created events don't spam
  invited guests with notifications unless explicitly requested. Pass
  --send-updates all for production-style invite behavior.
output:
  Returns the newly-created event's key fields (id, summary, start, end,
  organizer, attendees count, htmlLink) plus an \`action: created\` line.
`;

interface ParsedFlags {
  summary: string | undefined;
  start: string | undefined;
  end: string | undefined;
  duration: string | undefined;
  allDay: boolean;
  description: string | undefined;
  location: string | undefined;
  attendees: string[];
  timezone: string | undefined;
  recurrence: string | undefined;
  sendUpdates: "all" | "externalOnly" | "none";
  calendar: string;
}

function parseDurationMs(value: string): number {
  // Accept forms like "90m", "1h", "1h30m", "45min"
  const re = /^(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/i;
  const m = value.trim().match(re);
  if (!m || (!m[1] && !m[2])) {
    throw new AxiError(
      `Cannot parse duration: ${value}`,
      "VALIDATION_ERROR",
      ["Use forms like 1h, 30m, 90m, or 1h30m"],
    );
  }
  const hours = parseInt(m[1] ?? "0", 10);
  const minutes = parseInt(m[2] ?? "0", 10);
  return (hours * 60 + minutes) * 60 * 1000;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    summary: undefined,
    start: undefined,
    end: undefined,
    duration: undefined,
    allDay: false,
    description: undefined,
    location: undefined,
    attendees: [],
    timezone: undefined,
    recurrence: undefined,
    sendUpdates: "none",
    calendar: "primary",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--summary":
        flags.summary = next;
        i++;
        break;
      case "--start":
        flags.start = next;
        i++;
        break;
      case "--end":
        flags.end = next;
        i++;
        break;
      case "--duration":
        flags.duration = next;
        i++;
        break;
      case "--all-day":
        flags.allDay = true;
        break;
      case "--description":
        flags.description = next;
        i++;
        break;
      case "--location":
        flags.location = next;
        i++;
        break;
      case "--attendees":
        flags.attendees = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--timezone":
        flags.timezone = next;
        i++;
        break;
      case "--recurrence":
        flags.recurrence = next;
        i++;
        break;
      case "--send-updates":
        if (next === "all" || next === "externalOnly" || next === "none") {
          flags.sendUpdates = next;
        } else {
          throw new AxiError(
            `Invalid --send-updates value: ${next}`,
            "VALIDATION_ERROR",
            ["Valid values: none, all, externalOnly"],
          );
        }
        i++;
        break;
      case "--calendar":
        flags.calendar = next;
        i++;
        break;
    }
  }
  return flags;
}

/** Format a Date to `YYYY-MM-DD` in local time. */
function toDateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildEventBody(flags: ParsedFlags): calendar_v3.Schema$Event {
  if (!flags.summary) {
    throw new AxiError("--summary is required", "VALIDATION_ERROR", [
      "Pass --summary 'Event title'",
    ]);
  }
  if (!flags.start) {
    throw new AxiError("--start is required", "VALIDATION_ERROR", [
      "Pass --start 2026-04-22T14:00 (timed) or --start 2026-04-22 --all-day",
    ]);
  }

  const body: calendar_v3.Schema$Event = {
    summary: flags.summary,
  };
  if (flags.description !== undefined) body.description = flags.description;
  if (flags.location !== undefined) body.location = flags.location;
  if (flags.attendees.length > 0) {
    body.attendees = flags.attendees.map((email) => ({ email }));
  }
  if (flags.recurrence) {
    const line = flags.recurrence.startsWith("RRULE:")
      ? flags.recurrence
      : `RRULE:${flags.recurrence}`;
    body.recurrence = [line];
  }

  if (flags.allDay) {
    // All-day events use the date field; Google expects exclusive end date,
    // so default end = start + 1 day if neither --end nor --duration given.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.start)) {
      throw new AxiError(
        "--all-day requires --start in YYYY-MM-DD form",
        "VALIDATION_ERROR",
        [`Got: ${flags.start}`],
      );
    }
    body.start = { date: flags.start };
    let endDate: string;
    if (flags.end) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.end)) {
        throw new AxiError(
          "--all-day requires --end in YYYY-MM-DD form",
          "VALIDATION_ERROR",
          [`Got: ${flags.end}`],
        );
      }
      endDate = flags.end;
    } else {
      // Google's all-day end date is exclusive — default to start + 1 day
      const d = new Date(`${flags.start}T00:00:00`);
      d.setDate(d.getDate() + 1);
      endDate = toDateOnly(d);
    }
    body.end = { date: endDate };
  } else {
    // Timed event: parse via parseDateishFlag (handles ISO, local, date-only)
    const startIso = parseDateishFlag(flags.start);
    let endIso: string;
    if (flags.end) {
      endIso = parseDateishFlag(flags.end);
    } else if (flags.duration) {
      const ms = parseDurationMs(flags.duration);
      endIso = new Date(new Date(startIso).getTime() + ms).toISOString();
    } else {
      // Default: 1 hour after start
      endIso = new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();
    }
    body.start = flags.timezone
      ? { dateTime: startIso, timeZone: flags.timezone }
      : { dateTime: startIso };
    body.end = flags.timezone
      ? { dateTime: endIso, timeZone: flags.timezone }
      : { dateTime: endIso };
  }

  return body;
}

export async function calendarCreateCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const body = buildEventBody(flags);
  const api = await calendarClient(account);

  let created: calendar_v3.Schema$Event;
  try {
    const res = await api.events.insert({
      calendarId: flags.calendar,
      requestBody: body,
      sendUpdates: flags.sendUpdates,
    });
    created = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "calendar.events.insert",
    });
  }

  const blocks: string[] = [];
  blocks.push(
    renderObject({
      action: "created",
      account,
      calendar: flags.calendar,
    }),
  );

  const attendees = created.attendees ?? [];
  const event: Record<string, unknown> = {
    id: created.id ?? "",
    summary: created.summary ?? "",
    start: formatEventTime(created.start),
    end: formatEventTime(created.end),
    status: created.status ?? "",
    organizer: created.organizer?.email ?? "",
    attendee_count: attendees.length,
    send_updates: flags.sendUpdates,
  };
  if (created.location) event.location = created.location;
  if (created.htmlLink) event.html_link = created.htmlLink;
  if (created.recurrence?.length) event.recurrence = created.recurrence;
  blocks.push(renderObject({ event }));

  const suggestions: string[] = [];
  suggestions.push(
    `Run \`gws-axi calendar get ${created.id} --calendar ${flags.calendar}\` to view full details`,
  );
  if (attendees.length > 0 && flags.sendUpdates === "none") {
    suggestions.push(
      `Attendees were NOT notified (--send-updates none). Run \`calendar update ${created.id} --send-updates all\` to resend`,
    );
  }
  blocks.push(renderObject({ help: suggestions }));

  return joinBlocks(...blocks);
}
