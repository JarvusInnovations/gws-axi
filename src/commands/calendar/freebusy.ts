import type { calendar_v3 } from "googleapis";
import { calendarClient, translateGoogleError } from "../../google/client.js";
import { renderList, renderObject, joinBlocks, renderHelp } from "../../output/index.js";
import { resolveWindow, toLocalOffsetISO } from "./dateish.js";
import { resolveWeekStart } from "./week-start.js";

export const FREEBUSY_HELP = `usage: gws-axi calendar freebusy [flags]
flags[6]:
  --calendars <ids>    Comma-separated calendar IDs (default: "primary")
  --today              Just today (the default range, stated explicitly)
  --this-week          The current week (starts on your Google Calendar's
                       configured first day of the week)
  --from <when>        Start of query range (default: start of today, local tz)
  --to <when>          End of query range (default: end of today, local tz)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi calendar freebusy
  gws-axi calendar freebusy --this-week
  gws-axi calendar freebusy --calendars primary,team@jarv.us
  gws-axi calendar freebusy --from 2026-04-22T09:00 --to 2026-04-22T17:00
  gws-axi calendar freebusy --from 2026-04-22 --to 2026-04-24   (3 whole days)
output:
  Busy blocks across the requested calendars, one row per block.
  calendar column identifies which calendar each block belongs to.
  Empty result means no busy time in the range — you're free.
ranges:
  Half-open [--from, --to). A date-only value denotes the DAY: --from
  opens at its midnight, --to closes at the end of it. Tokens: now,
  today, tomorrow, yesterday, +Nd/-Nd, +Nw/-Nw, +Nh/-Nh.
notes:
  Time ranges longer than a few days work but the API caps total time
  coverage at ~3 months across all requested calendars combined. For
  long ranges with many calendars, narrow to one at a time.
`;

interface ParsedFlags {
  calendars: string[];
  /** Raw flag values — resolved by `resolveWindow` so it can quote what was typed. */
  from: string | undefined;
  to: string | undefined;
  today: boolean;
  thisWeek: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    calendars: ["primary"],
    from: undefined,
    to: undefined,
    today: false,
    thisWeek: false,
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
        flags.from = next;
        i++;
        break;
      case "--to":
        flags.to = next;
        i++;
        break;
      case "--today":
        flags.today = true;
        break;
      case "--this-week":
        flags.thisWeek = true;
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

export async function calendarFreebusyCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);

  // Only a week shortcut needs the account's weekStart preference.
  const weekStart = flags.thisWeek ? await resolveWeekStart(account) : undefined;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const window = resolveWindow(flags, {
    defaults: {
      from: startOfToday.toISOString(),
      // Half-open: the default day closes at tomorrow's midnight, matching
      // `--today`, rather than the old 23:59:59.999.
      to: new Date(
        startOfToday.getFullYear(),
        startOfToday.getMonth(),
        startOfToday.getDate() + 1,
      ).toISOString(),
    },
    weekStartDay: weekStart?.day,
    now,
  });
  const from = window.from as string;
  const to = window.to as string;

  const api = await calendarClient(account);

  let data: calendar_v3.Schema$FreeBusyResponse;
  try {
    const res = await api.freebusy.query({
      requestBody: {
        timeMin: from,
        timeMax: to,
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

  interface CoverageRow {
    calendar: string;
    status: "ok" | "error";
    busy_blocks: number;
    detail: string;
  }
  const coverage: CoverageRow[] = [];
  const rows: BusyRow[] = [];
  const responseCalendars = data.calendars ?? {};
  for (const calId of flags.calendars) {
    const info = responseCalendars[calId];
    if (!info) {
      coverage.push({
        calendar: calId,
        status: "error",
        busy_blocks: 0,
        detail: "missing from response",
      });
      continue;
    }
    if (info.errors?.length) {
      coverage.push({
        calendar: calId,
        status: "error",
        busy_blocks: 0,
        detail: info.errors.map((e) => e.reason ?? "unknown").join(", "),
      });
      continue;
    }
    const busy = info.busy ?? [];
    coverage.push({
      calendar: calId,
      status: "ok",
      busy_blocks: busy.length,
      detail: busy.length === 0 ? "free for entire range" : "",
    });
    for (const block of busy) {
      rows.push({
        calendar: calId,
        // Google returns freebusy timestamps in UTC (trailing Z). Convert to
        // local-with-offset so format matches `calendar events` output.
        start: toLocalOffsetISO(block.start ?? ""),
        end: toLocalOffsetISO(block.end ?? ""),
      });
    }
  }
  // Sort by start time so the agent sees a timeline view
  rows.sort((a, b) => a.start.localeCompare(b.start));

  const blocks: string[] = [];
  const erroredCount = coverage.filter((c) => c.status === "error").length;
  blocks.push(
    renderObject({
      account,
      range: `${toLocalOffsetISO(from)} → ${toLocalOffsetISO(to)}`,
      ...(weekStart ? { week_start: `${weekStart.label} (${weekStart.source})` } : {}),
      busy_block_count: rows.length,
    }),
  );

  // Always render per-calendar coverage so agents can confirm each requested
  // calendar was actually reached. Distinguishes "free" from "errored".
  blocks.push(
    renderList("coverage", coverage as unknown as Array<Record<string, unknown>>, [
      { name: "calendar", extract: (r) => r.calendar },
      { name: "status", extract: (r) => r.status },
      { name: "busy_blocks", extract: (r) => r.busy_blocks },
      { name: "detail", extract: (r) => r.detail },
    ]),
  );

  if (rows.length === 0) {
    blocks.push(renderObject({ busy: [] }));
    const okCalendars = coverage.filter((c) => c.status === "ok").map((c) => c.calendar);
    blocks.push(
      renderObject({
        message:
          okCalendars.length > 0
            ? `no busy time — ${okCalendars.join(", ")} free for the entire range`
            : "no successfully-queried calendars had busy blocks",
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
  if (rows.length === 0 && erroredCount === 0) {
    suggestions.push(`Widen the time range with --from/--to to verify availability at other times`);
  }
  if (erroredCount > 0) {
    suggestions.push(
      `${erroredCount} calendar(s) returned errors — check ids or your access rights`,
    );
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }

  return joinBlocks(...blocks);
}
