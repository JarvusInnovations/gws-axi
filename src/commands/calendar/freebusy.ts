import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { renderList, renderObject, joinBlocks, renderHelp } from "../../output/index.js";

export const FREEBUSY_HELP = `usage: gws-axi calendar freebusy [flags]
flags[4]:
  --calendars <ids>    Comma-separated calendar IDs (default: "primary")
  --from <iso>         Start of query range (default: start of today, local tz)
  --to <iso>           End of query range (default: end of today, local tz)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi calendar freebusy
  gws-axi calendar freebusy --calendars primary,team@jarv.us
  gws-axi calendar freebusy --from 2026-04-22T09:00 --to 2026-04-22T17:00
output:
  Busy blocks across the requested calendars, one row per block.
  calendar column identifies which calendar each block belongs to.
  Empty result means no busy time in the range — you're free.
notes:
  Time ranges longer than a few days work but the API caps total time
  coverage at ~3 months across all requested calendars combined. For
  long ranges with many calendars, narrow to one at a time.
`;

interface ParsedFlags {
  calendars: string[];
  from: string;
  to: string;
}

function parseDateish(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AxiError(
      `Cannot parse date/time: ${value}`,
      "VALIDATION_ERROR",
      ["Use ISO 8601 (e.g. 2026-04-22T09:00 or 2026-04-22)"],
    );
  }
  return parsed.toISOString();
}

function parseFlags(args: string[]): ParsedFlags {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const flags: ParsedFlags = {
    calendars: ["primary"],
    from: startOfDay.toISOString(),
    to: endOfDay.toISOString(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--calendars":
        flags.calendars = next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i++;
        break;
      case "--from":
        flags.from = parseDateish(next, startOfDay);
        i++;
        break;
      case "--to":
        flags.to = parseDateish(next, endOfDay);
        i++;
        break;
    }
  }
  return flags;
}

interface BusyRow {
  calendar: string;
  start: string;
  end: string;
}

export async function calendarFreebusyCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await calendarClient(account);

  let data: calendar_v3.Schema$FreeBusyResponse;
  try {
    const res = await api.freebusy.query({
      requestBody: {
        timeMin: flags.from,
        timeMax: flags.to,
        items: flags.calendars.map((id) => ({ id })),
      },
    });
    data = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "calendar.freebusy.query",
    });
  }

  const perCalendarErrors: Array<{ calendar: string; error: string }> = [];
  const rows: BusyRow[] = [];
  const calendars = data.calendars ?? {};
  for (const [calId, info] of Object.entries(calendars)) {
    if (info.errors?.length) {
      perCalendarErrors.push({
        calendar: calId,
        error: info.errors.map((e) => e.reason ?? "unknown").join(", "),
      });
      continue;
    }
    for (const block of info.busy ?? []) {
      rows.push({
        calendar: calId,
        start: block.start ?? "",
        end: block.end ?? "",
      });
    }
  }
  // Sort by start time so the agent sees a timeline view
  rows.sort((a, b) => a.start.localeCompare(b.start));

  const blocks: string[] = [];
  blocks.push(
    renderObject({
      account,
      range: `${flags.from} → ${flags.to}`,
      calendars: flags.calendars,
      busy_block_count: rows.length,
    }),
  );

  if (perCalendarErrors.length > 0) {
    blocks.push(
      renderList(
        "calendar_errors",
        perCalendarErrors as unknown as Array<Record<string, unknown>>,
        [
          { name: "calendar", extract: (r) => r.calendar },
          { name: "error", extract: (r) => r.error },
        ],
      ),
    );
  }

  if (rows.length === 0) {
    blocks.push(renderObject({ busy: [] }));
    blocks.push(
      renderObject({
        message: `no busy time — ${flags.calendars.join(", ")} free for the entire range`,
      }),
    );
  } else {
    blocks.push(
      renderList("busy", rows as unknown as Array<Record<string, unknown>>, [
        { name: "calendar", extract: (r) => r.calendar },
        { name: "start", extract: (r) => r.start },
        { name: "end", extract: (r) => r.end },
      ]),
    );
  }

  const suggestions: string[] = [];
  if (flags.calendars.length === 1 && flags.calendars[0] === "primary") {
    suggestions.push(
      `Add more calendars with --calendars primary,team@... to see cross-calendar availability`,
    );
  }
  if (rows.length === 0) {
    suggestions.push(
      `Widen the time range with --from/--to to verify availability at other times`,
    );
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }

  return joinBlocks(...blocks);
}
