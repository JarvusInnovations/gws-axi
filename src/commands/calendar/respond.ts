import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { renderObject } from "../../output/index.js";

export const RESPOND_HELP = `usage: gws-axi calendar respond <event-id> --response <status> [flags]
args[1]:
  <event-id>             Event ID you've been invited to
flags[4]:
  --response <status>    REQUIRED: accepted | tentative | declined | needsAction
  --comment <text>       Optional comment (visible to the organizer)
  --calendar <id>        Calendar containing the event (default: primary)
  --send-updates <mode>  none | all | externalOnly (default: all — notifies organizer)
  --account <email>      REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi calendar respond abc_123 --response accepted
  gws-axi calendar respond abc_123 --response declined --comment "Timezone conflict"
  gws-axi calendar respond abc_123 --response tentative --send-updates none
notes:
  Updates the \`self: true\` attendee's responseStatus via events.patch.
  The event must already have you listed as an attendee — you can't RSVP
  to something you weren't invited to. If you're the sole organizer of
  a single-person event, there's no attendee to update (use calendar
  update to change the event itself).
  Default --send-updates is "all" (organizer expects to know your
  response) — differs from create/update/delete which default to "none".
`;

type ResponseStatus = "accepted" | "tentative" | "declined" | "needsAction";
const VALID_RESPONSES: ResponseStatus[] = [
  "accepted",
  "tentative",
  "declined",
  "needsAction",
];

interface ParsedFlags {
  eventId: string;
  response: ResponseStatus;
  comment: string | undefined;
  calendar: string;
  sendUpdates: "all" | "externalOnly" | "none";
}

function parseFlags(args: string[]): ParsedFlags {
  let eventId: string | undefined;
  let response: ResponseStatus | undefined;
  let comment: string | undefined;
  let calendar = "primary";
  let sendUpdates: "all" | "externalOnly" | "none" = "all";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--response":
        if (!VALID_RESPONSES.includes(next as ResponseStatus)) {
          throw new AxiError(
            `Invalid --response value: ${next}`,
            "VALIDATION_ERROR",
            [`Valid values: ${VALID_RESPONSES.join(", ")}`],
          );
        }
        response = next as ResponseStatus;
        i++;
        break;
      case "--comment":
        comment = next;
        i++;
        break;
      case "--calendar":
        calendar = next;
        i++;
        break;
      case "--send-updates":
        if (next === "all" || next === "externalOnly" || next === "none") {
          sendUpdates = next;
        } else {
          throw new AxiError(
            `Invalid --send-updates value: ${next}`,
            "VALIDATION_ERROR",
            ["Valid values: none, all, externalOnly"],
          );
        }
        i++;
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
      ["Usage: gws-axi calendar respond <event-id> --response <status>"],
    );
  }
  if (!response) {
    throw new AxiError(
      "--response is required",
      "VALIDATION_ERROR",
      [`Valid values: ${VALID_RESPONSES.join(", ")}`],
    );
  }
  return { eventId, response, comment, calendar, sendUpdates };
}

export async function calendarRespondCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await calendarClient(account);

  // Fetch the event so we can find the self-attendee and produce the
  // updated attendees array.
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

  const attendees = existing.attendees ?? [];
  if (attendees.length === 0) {
    throw new AxiError(
      `Event '${flags.eventId}' has no attendees — you can't RSVP to it`,
      "NOT_AN_INVITEE",
      [
        "If this is your own single-person event, use `calendar update` to change it directly",
      ],
    );
  }

  const selfIndex = attendees.findIndex((a) => a.self === true);
  if (selfIndex < 0) {
    throw new AxiError(
      `${account} is not an attendee of event '${flags.eventId}' — can't RSVP`,
      "NOT_AN_INVITEE",
      [
        "RSVP only works for events where you are a direct attendee",
        "Verify with `gws-axi calendar get " + flags.eventId + "`",
      ],
    );
  }

  const previousResponse = attendees[selfIndex].responseStatus ?? "needsAction";
  const updatedAttendees = attendees.map((a, i) =>
    i === selfIndex
      ? {
          ...a,
          responseStatus: flags.response,
          ...(flags.comment !== undefined ? { comment: flags.comment } : {}),
        }
      : a,
  );

  let updated: calendar_v3.Schema$Event;
  try {
    const res = await api.events.patch({
      calendarId: flags.calendar,
      eventId: flags.eventId,
      requestBody: { attendees: updatedAttendees },
      sendUpdates: flags.sendUpdates,
    });
    updated = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "calendar.events.patch",
    });
  }

  return renderObject({
    action: "responded",
    account,
    calendar: flags.calendar,
    event_id: updated.id ?? flags.eventId,
    summary: updated.summary ?? "",
    previous_response: previousResponse,
    new_response: flags.response,
    send_updates: flags.sendUpdates,
    help: [
      `Run \`gws-axi calendar get ${flags.eventId} --calendar ${flags.calendar}\` to verify`,
    ],
  });
}
