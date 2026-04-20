import { AxiError } from "axi-sdk-js";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { renderObject } from "../../output/index.js";

export const DELETE_HELP = `usage: gws-axi calendar delete <event-id> [flags]
args[1]:
  <event-id>             Event ID to delete
flags[4]:
  --calendar <id>        Calendar containing the event (default: primary)
  --send-updates <mode>  none | all | externalOnly (default: none)
  --account <email>      REQUIRED when 2+ accounts are authenticated
  --yes                  Don't warn; just delete (no-op currently — writes
                         are already explicit via --account + this command)
examples:
  gws-axi calendar delete abc_123
  gws-axi calendar delete abc_123 --send-updates all --calendar team@jarv.us
notes:
  Idempotent: deleting an already-deleted or non-existent event returns
  exit 0 with \`action: noop\` rather than an error. If you need a hard
  guarantee the event existed before deletion, run \`calendar get\` first.
`;

interface ParsedFlags {
  eventId: string;
  calendar: string;
  sendUpdates: "all" | "externalOnly" | "none";
}

function parseFlags(args: string[]): ParsedFlags {
  let eventId: string | undefined;
  let calendar = "primary";
  let sendUpdates: "all" | "externalOnly" | "none" = "none";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
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
      case "--yes":
        // no-op — reserved for future confirmation prompts
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
        "Usage: gws-axi calendar delete <event-id> [flags]",
        "Get an ID from `gws-axi calendar events`",
      ],
    );
  }

  return { eventId, calendar, sendUpdates };
}

export async function calendarDeleteCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await calendarClient(account);

  try {
    await api.events.delete({
      calendarId: flags.calendar,
      eventId: flags.eventId,
      sendUpdates: flags.sendUpdates,
    });
    return renderObject({
      action: "deleted",
      account,
      calendar: flags.calendar,
      event_id: flags.eventId,
      send_updates: flags.sendUpdates,
      help: [
        `Run \`gws-axi calendar events --calendar ${flags.calendar}\` to verify`,
      ],
    });
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "calendar.events.delete",
    });
    if (translated.code === "NOT_FOUND" || translated.code === "GOOGLE_API_ERROR_410") {
      // 404 or 410 (gone) — already deleted. Idempotent success.
      return renderObject({
        action: "noop",
        account,
        calendar: flags.calendar,
        event_id: flags.eventId,
        reason: "event was already deleted or never existed",
      });
    }
    throw translated;
  }
}
