import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
} from "../../output/index.js";
import { formatEventTime } from "./dateish.js";

export const GET_HELP = `usage: gws-axi calendar get <event-id> [flags]
args[1]:
  <event-id>           Event ID (from \`calendar events\` output)
flags[3]:
  --calendar <id>      Calendar containing the event (default: "primary")
  --full               Don't truncate description / attendee list
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi calendar get abc_123 --calendar primary
  gws-axi calendar get abc_123 --full
output:
  Event metadata (summary, start/end, status, creator, organizer,
  location, hangout link, htmlLink) plus the attendee list with each
  person's response status. Description is truncated to 500 chars by
  default — use --full to see the complete body.
`;

interface ParsedFlags {
  calendar: string;
  full: boolean;
}

function parseFlags(args: string[]): { eventId: string; flags: ParsedFlags } {
  const flags: ParsedFlags = { calendar: "primary", full: false };
  let eventId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--calendar":
        flags.calendar = next;
        i++;
        break;
      case "--full":
        flags.full = true;
        break;
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
        "Usage: gws-axi calendar get <event-id>",
        "Get an ID from `gws-axi calendar events`",
      ],
    );
  }
  return { eventId, flags };
}

function truncate(value: string | undefined, max: number): { value: string; truncated: boolean; total: number } {
  if (!value) return { value: "", truncated: false, total: 0 };
  if (value.length <= max) return { value, truncated: false, total: value.length };
  return {
    value: `${value.slice(0, max - 1)}…`,
    truncated: true,
    total: value.length,
  };
}

export async function calendarGetCommand(
  account: string,
  args: string[],
): Promise<string> {
  const { eventId, flags } = parseFlags(args);
  const api = await calendarClient(account);

  let event: calendar_v3.Schema$Event;
  try {
    const res = await api.events.get({
      calendarId: flags.calendar,
      eventId,
    });
    event = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "calendar.events.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Event '${eventId}' not found in calendar '${flags.calendar}'`,
        "EVENT_NOT_FOUND",
        [
          `Verify the event ID with \`gws-axi calendar events --calendar ${flags.calendar}\``,
          flags.calendar === "primary"
            ? "The event may be on a different calendar — try --calendar <id>"
            : "Or try --calendar primary if the event is on your default calendar",
        ],
      );
    }
    throw translated;
  }

  const blocks: string[] = [];

  // Always include the calendar in the header so agents can correlate
  // across calendars in batch work without needing to remember which
  // --calendar flag they passed.
  blocks.push(renderObject({ account, calendar: flags.calendar }));

  const descResult = truncate(event.description ?? "", flags.full ? 1_000_000 : 500);

  const details: Record<string, unknown> = {
    id: event.id ?? "",
    summary: event.summary ?? "",
    status: event.status ?? "",
    start: formatEventTime(event.start),
    end: formatEventTime(event.end),
    creator: event.creator?.email ?? "",
    organizer: event.organizer?.email ?? "",
  };
  if (event.location) details.location = event.location;
  if (event.hangoutLink) details.hangout_link = event.hangoutLink;
  if (event.htmlLink) details.html_link = event.htmlLink;
  if (event.recurringEventId) details.recurring_event_id = event.recurringEventId;
  if (event.recurrence?.length) details.recurrence = event.recurrence;
  if (event.created) details.created = event.created;
  if (event.updated) details.updated = event.updated;
  blocks.push(renderObject({ event: details }));

  if (descResult.value) {
    const descBlock: Record<string, unknown> = { description: descResult.value };
    if (descResult.truncated) {
      descBlock.description_truncated = true;
      descBlock.description_total_chars = descResult.total;
    }
    blocks.push(renderObject(descBlock));
  }

  const attendees = event.attendees ?? [];
  if (attendees.length > 0) {
    const maxAttendees = flags.full ? attendees.length : 20;
    const shown = attendees.slice(0, maxAttendees) as Array<Record<string, unknown>>;
    const schema = [
      field("email"),
      {
        name: "response",
        extract: (a: Record<string, unknown>) => (a.responseStatus as string) ?? "",
      },
      {
        name: "self",
        extract: (a: Record<string, unknown>) => (a.self ? "✓" : ""),
      },
      {
        name: "organizer",
        extract: (a: Record<string, unknown>) => (a.organizer ? "✓" : ""),
      },
      {
        name: "optional",
        extract: (a: Record<string, unknown>) => (a.optional ? "✓" : ""),
      },
    ];
    blocks.push(renderList("attendees", shown, schema));
    if (attendees.length > maxAttendees) {
      blocks.push(
        renderObject({
          attendees_truncated: true,
          attendees_total: attendees.length,
          attendees_shown: maxAttendees,
        }),
      );
    }
  }

  const suggestions: string[] = [];
  if (event.status === "cancelled") {
    // Google tombstones deleted events (they return 200 with status=cancelled
    // rather than 404). Make sure agents don't misread this as "event exists".
    suggestions.push(
      `This event is CANCELLED (tombstoned by a prior delete). It won't appear in \`calendar events\` or in Google Calendar's UI. To restore, create a new event with \`gws-axi calendar create --account ${account} --calendar ${flags.calendar} ...\`.`,
    );
  }
  if (descResult.truncated || attendees.length > 20) {
    suggestions.push(
      `Run with --full to see complete description and all attendees`,
    );
  }
  if (event.htmlLink) {
    suggestions.push(`Open in browser: ${event.htmlLink}`);
  }

  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
