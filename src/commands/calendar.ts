import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { calendarCalendarsCommand, CALENDARS_HELP } from "./calendar/calendars.js";
import { calendarEventsCommand, EVENTS_HELP } from "./calendar/events.js";
import { calendarGetCommand, GET_HELP } from "./calendar/get.js";

interface CalendarSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

const SUBCOMMANDS: CalendarSubcommand[] = [
  { name: "events", mutation: false, help: EVENTS_HELP, handler: calendarEventsCommand },
  { name: "get", mutation: false, help: GET_HELP, handler: calendarGetCommand },
  { name: "calendars", mutation: false, help: CALENDARS_HELP, handler: calendarCalendarsCommand },
  { name: "search", mutation: false, help: "not yet implemented" },
  { name: "freebusy", mutation: false, help: "not yet implemented" },
  { name: "create", mutation: true, help: "not yet implemented" },
  { name: "update", mutation: true, help: "not yet implemented" },
  { name: "delete", mutation: true, help: "not yet implemented" },
  { name: "respond", mutation: true, help: "not yet implemented" },
];

const SUB_BY_NAME: Record<string, CalendarSubcommand> = Object.fromEntries(
  SUBCOMMANDS.map((s) => [s.name, s]),
);

function parseAccountFlag(args: string[]): {
  account: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let account: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--account" && args[i + 1]) {
      account = args[i + 1];
      i++;
      continue;
    }
    rest.push(arg);
  }
  return { account, rest };
}

const reads = SUBCOMMANDS.filter((s) => !s.mutation).map((s) => s.name);
const writes = SUBCOMMANDS.filter((s) => s.mutation).map((s) => s.name);

export const CALENDAR_HELP = `usage: gws-axi calendar <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
subcommand help:
  gws-axi calendar events --help    for time-range / limit / field flags
  gws-axi calendar <sub> --help     for any other subcommand
examples:
  gws-axi calendar events
  gws-axi calendar events --from 2026-04-20T00:00 --to 2026-04-21T00:00
  gws-axi calendar events --fields attendees,location
`;

export async function calendarCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return CALENDAR_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(
      `Unknown calendar subcommand: ${sub}`,
      "VALIDATION_ERROR",
      [`Run \`gws-axi calendar --help\` to see available subcommands`],
    );
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `calendar ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(
      `gws-axi calendar ${sub} is not yet implemented`,
      "NOT_IMPLEMENTED",
      [
        `Account resolution succeeded: would run as ${resolution.account}`,
        `See docs/design.md for the planned command surface`,
      ],
    );
  }

  return def.handler(resolution.account, remaining);
}
