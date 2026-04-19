import { calendarClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  mapEnum,
  renderListResponse,
  truncated,
} from "../../output/index.js";

export const CALENDARS_HELP = `usage: gws-axi calendar calendars [flags]
flags[2]:
  --account <email>    Account override when 2+ are configured
  --fields <list>      Extra columns: timezone, description, colorId
examples:
  gws-axi calendar calendars
  gws-axi calendar calendars --account chris@personal.com
  gws-axi calendar calendars --fields timezone
default columns:
  id           Calendar ID (use with \`calendar events --calendar <id>\`)
  summary      Human-readable name
  access       reader | writer | owner | free_busy
  primary      ✓ for the account's primary calendar
notes:
  Lists ALL calendars this account can access — your own plus ones
  you're subscribed to. Shared / team calendars appear here too.
`;

interface ParsedFlags {
  extraFields: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { extraFields: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--fields" && next) {
      flags.extraFields = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }
  return flags;
}

export async function calendarCalendarsCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await calendarClient(account);

  let items: Array<Record<string, unknown>>;
  try {
    const res = await api.calendarList.list({
      maxResults: 250,
      showHidden: false,
    });
    items = (res.data.items ?? []) as Array<Record<string, unknown>>;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "calendar.calendarList.list",
    });
  }

  const schema = [
    field("id"),
    truncated("summary", 60),
    mapEnum(
      "accessRole",
      {
        owner: "owner",
        writer: "writer",
        reader: "reader",
        freeBusyReader: "free_busy",
      },
      "unknown",
      "access",
    ),
    {
      name: "primary",
      extract: (item: Record<string, unknown>) =>
        item.primary === true ? "✓" : "",
    },
  ];
  for (const extra of flags.extraFields) {
    switch (extra) {
      case "timezone":
        schema.push(field("timeZone"));
        break;
      case "description":
        schema.push(truncated("description", 80));
        break;
      case "colorId":
        schema.push(field("colorId"));
        break;
      // silently skip unknown extras
    }
  }

  const owned = items.filter(
    (c) => c.accessRole === "owner" || c.primary === true,
  ).length;
  const suggestions: string[] = [];
  if (items.length > 0) {
    suggestions.push(
      `Query a specific calendar: \`gws-axi calendar events --calendar <id>\``,
    );
    if (flags.extraFields.length === 0) {
      suggestions.push(
        `Add \`--fields timezone,description\` for more details`,
      );
    }
  }

  return renderListResponse({
    header: { account },
    summary: {
      count: items.length,
      owned,
    },
    name: "calendars",
    items,
    schema,
    suggestions,
    emptyMessage: "no calendars accessible to this account",
  });
}
