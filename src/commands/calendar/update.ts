import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderObject } from "../../output/index.js";
import { formatEventTime, parseDateishFlag } from "./dateish.js";

export const UPDATE_HELP = `usage: gws-axi calendar update <event-id> [flags]
args[1]:
  <event-id>             Event ID to update (from \`calendar events\` or \`calendar get\`)
flags[12]:
  --summary <text>       New event title
  --start <iso>          New start time (ISO datetime or YYYY-MM-DD for all-day)
  --end <iso>            New end time
  --duration <h|m>       Set end relative to (new or existing) start, e.g. "1h"
  --description <text>   Replace description (pass empty string to clear)
  --location <text>      Replace location
  --add-attendees <es>   Comma-separated emails to add (merges with existing)
  --remove-attendees <es> Comma-separated emails to remove
  --replace-attendees <es> Comma-separated emails — REPLACES entire attendee list
  --send-updates <mode>  none | all | externalOnly (default: none)
  --calendar <id>        Calendar containing the event (default: primary)
  --account <email>      REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi calendar update abc_123 --summary "Team sync (rescheduled)"
  gws-axi calendar update abc_123 --start 2026-04-22T15:00 --duration 30m
  gws-axi calendar update abc_123 --add-attendees eve@x.com --send-updates all
notes:
  Uses events.patch — only specified fields change; everything else stays
  as-is. If --start is given without --end or --duration, --end stays put
  (might produce a negative-duration event — the API will reject).
  For attendee changes: --add/--remove merge with the existing list via a
  read-modify-write (two API calls); --replace-attendees overwrites in one.
`;

interface ParsedFlags {
  eventId: string;
  summary: string | undefined;
  start: string | undefined;
  end: string | undefined;
  duration: string | undefined;
  description: string | undefined;
  location: string | undefined;
  addAttendees: string[];
  removeAttendees: string[];
  replaceAttendees: string[] | undefined;
  timezone: string | undefined;
  sendUpdates: "all" | "externalOnly" | "none";
  calendar: string;
}

function parseDurationMs(value: string): number {
  const re = /^(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/i;
  const m = value.trim().match(re);
  if (!m || (!m[1] && !m[2])) {
    throw new AxiError(
      `Cannot parse duration: ${value}`,
      "VALIDATION_ERROR",
      ["Use forms like 1h, 30m, 90m, or 1h30m"],
    );
  }
  return (
    (parseInt(m[1] ?? "0", 10) * 60 + parseInt(m[2] ?? "0", 10)) * 60 * 1000
  );
}

function parseFlags(args: string[]): ParsedFlags {
  let eventId: string | undefined;
  const flags: Partial<ParsedFlags> = {
    addAttendees: [],
    removeAttendees: [],
    replaceAttendees: undefined,
    sendUpdates: "none",
    calendar: "primary",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--summary": flags.summary = next; i++; break;
      case "--start": flags.start = next; i++; break;
      case "--end": flags.end = next; i++; break;
      case "--duration": flags.duration = next; i++; break;
      case "--description": flags.description = next; i++; break;
      case "--location": flags.location = next; i++; break;
      case "--add-attendees":
        flags.addAttendees = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--remove-attendees":
        flags.removeAttendees = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--replace-attendees":
        flags.replaceAttendees = next.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--timezone": flags.timezone = next; i++; break;
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
      case "--calendar": flags.calendar = next; i++; break;
      default:
        if (!arg.startsWith("--") && eventId === undefined) {
          eventId = arg;
        }
    }
  }

  if (!eventId) {
    throw new AxiError(
      "Missing event ID argument",
      "VALIDATION_ERROR",
      [
        "Usage: gws-axi calendar update <event-id> [flags]",
        "Get an ID from `gws-axi calendar events`",
      ],
    );
  }

  return { ...flags, eventId } as ParsedFlags;
}

function buildPatchBody(
  flags: ParsedFlags,
  existing: calendar_v3.Schema$Event,
): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {};

  if (flags.summary !== undefined) body.summary = flags.summary;
  if (flags.description !== undefined) body.description = flags.description;
  if (flags.location !== undefined) body.location = flags.location;

  // Time handling: we need to know if the EXISTING event is all-day or timed
  // to parse flags.start/end correctly.
  const existingIsAllDay = Boolean(existing.start?.date);
  if (flags.start !== undefined || flags.end !== undefined || flags.duration !== undefined) {
    if (existingIsAllDay) {
      if (flags.start !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.start)) {
          throw new AxiError(
            "Existing event is all-day; --start must be YYYY-MM-DD",
            "VALIDATION_ERROR",
            [`Got: ${flags.start}`],
          );
        }
        body.start = { date: flags.start };
      }
      if (flags.end !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.end)) {
          throw new AxiError(
            "Existing event is all-day; --end must be YYYY-MM-DD",
            "VALIDATION_ERROR",
            [`Got: ${flags.end}`],
          );
        }
        body.end = { date: flags.end };
      }
    } else {
      if (flags.start !== undefined) {
        const startIso = parseDateishFlag(flags.start);
        body.start = flags.timezone
          ? { dateTime: startIso, timeZone: flags.timezone }
          : { dateTime: startIso };
      }
      if (flags.end !== undefined) {
        const endIso = parseDateishFlag(flags.end);
        body.end = flags.timezone
          ? { dateTime: endIso, timeZone: flags.timezone }
          : { dateTime: endIso };
      } else if (flags.duration !== undefined) {
        const ms = parseDurationMs(flags.duration);
        const baseStartIso =
          (body.start?.dateTime as string | undefined) ??
          (existing.start?.dateTime as string | undefined);
        if (!baseStartIso) {
          throw new AxiError(
            "Cannot compute --duration — no known start time",
            "VALIDATION_ERROR",
            ["Pass --start or ensure the event has a dateTime start"],
          );
        }
        const endIso = new Date(new Date(baseStartIso).getTime() + ms).toISOString();
        body.end = flags.timezone
          ? { dateTime: endIso, timeZone: flags.timezone }
          : { dateTime: endIso };
      }
    }
  }

  // Attendees
  if (flags.replaceAttendees !== undefined) {
    body.attendees = flags.replaceAttendees.map((email) => ({ email }));
  } else if (flags.addAttendees.length > 0 || flags.removeAttendees.length > 0) {
    const existingAttendees = existing.attendees ?? [];
    const removeSet = new Set(flags.removeAttendees.map((e) => e.toLowerCase()));
    const keptExisting = existingAttendees.filter(
      (a) => !(a.email && removeSet.has(a.email.toLowerCase())),
    );
    const existingEmails = new Set(
      keptExisting
        .map((a) => a.email?.toLowerCase())
        .filter((e): e is string => typeof e === "string"),
    );
    const additions = flags.addAttendees
      .filter((e) => !existingEmails.has(e.toLowerCase()))
      .map((email) => ({ email }));
    body.attendees = [...keptExisting, ...additions];
  }

  return body;
}

export async function calendarUpdateCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);

  // Sanity check: the user passed at least one mutating flag.
  const hasChanges =
    flags.summary !== undefined ||
    flags.description !== undefined ||
    flags.location !== undefined ||
    flags.start !== undefined ||
    flags.end !== undefined ||
    flags.duration !== undefined ||
    flags.addAttendees.length > 0 ||
    flags.removeAttendees.length > 0 ||
    flags.replaceAttendees !== undefined;
  if (!hasChanges) {
    throw new AxiError(
      "No update flags provided — nothing to change",
      "VALIDATION_ERROR",
      [
        "Pass at least one of --summary, --start, --end, --duration,",
        "--description, --location, --add-attendees, --remove-attendees,",
        "or --replace-attendees",
      ],
    );
  }

  const api = await calendarClient(account);

  // Fetch existing event — needed to detect all-day vs timed, and to merge
  // attendee add/remove lists correctly.
  let existing: calendar_v3.Schema$Event;
  try {
    const res = await api.events.get({
      calendarId: flags.calendar,
      eventId: flags.eventId,
    });
    existing = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "calendar.events.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Event '${flags.eventId}' not found in calendar '${flags.calendar}'`,
        "EVENT_NOT_FOUND",
        [
          `Verify the ID with \`gws-axi calendar events --calendar ${flags.calendar}\``,
        ],
      );
    }
    throw translated;
  }

  const body = buildPatchBody(flags, existing);

  let updated: calendar_v3.Schema$Event;
  try {
    const res = await api.events.patch({
      calendarId: flags.calendar,
      eventId: flags.eventId,
      requestBody: body,
      sendUpdates: flags.sendUpdates,
    });
    updated = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "calendar.events.patch",
    });
  }

  const blocks: string[] = [];
  const changedFields = Object.keys(body);
  blocks.push(
    renderObject({
      action: "updated",
      account,
      calendar: flags.calendar,
      fields_changed: changedFields,
      send_updates: flags.sendUpdates,
    }),
  );

  const attendees = updated.attendees ?? [];
  blocks.push(
    renderObject({
      event: {
        id: updated.id ?? "",
        summary: updated.summary ?? "",
        start: formatEventTime(updated.start),
        end: formatEventTime(updated.end),
        status: updated.status ?? "",
        attendee_count: attendees.length,
        html_link: updated.htmlLink ?? "",
      },
    }),
  );

  const suggestions: string[] = [];
  suggestions.push(
    `Run \`gws-axi calendar get ${updated.id} --calendar ${flags.calendar}\` to view full updated event`,
  );
  if (flags.sendUpdates === "none" && attendees.length > 0) {
    suggestions.push(
      `Attendees were NOT notified of this change (--send-updates none). Run the same command with --send-updates all to resend invitations`,
    );
  }
  blocks.push(renderObject({ help: suggestions }));

  return joinBlocks(...blocks);
}
