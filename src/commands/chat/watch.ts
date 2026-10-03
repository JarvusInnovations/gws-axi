import { writeSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { parseRangeFlag } from "../calendar/dateish.js";
import { parseSpaceId, resolveSpaceTarget, spaceResourceName } from "./address.js";
import { parseArgs, parseChoice } from "../../util/flags.js";
import { UNRESOLVED_NOTE } from "./identity.js";
import { identifyPeople, toRow } from "./message-rows.js";
import {
  check,
  cursorFromDate,
  isTimestamp,
  matches,
  snapshotNow,
  type MatchRules,
  type PollDeps,
} from "./poller.js";
import {
  bareId,
  chatError,
  nameSpaces,
  resolveSpace,
  retryingChat,
  selfUserRef,
  SPACE_KINDS,
  TYPE_BY_KIND,
  type SpaceKind,
} from "./shared.js";
import { renderMessageText, truncateKeepingLinks } from "./text.js";

type Space = chat_v1.Schema$Space;
type Message = chat_v1.Schema$Message;

const SHARED_FLAGS = `  <space>…             One or more conversation ids (AAAA… or spaces/AAAA…) or
                       Chat URLs
  --with <email>       The 1:1 direct message with this person
  --all                Every conversation the account is in
  --type <kind>        With --all: only space, group, or dm
  --thread <id>        Only this thread (needs exactly one <space>)
  --from <email>       Only messages from this address
  --mentions-me        Only messages that mention you
  --include-mine       Also your own messages (skipped by default, so a
                       reply you post doesn't wake you up)
  --after <cursor>     Start after this point: a cursor from a previous run,
                       or a time (-1h, today, an ISO time). Default: now —
                       nothing already posted is replayed.
  --interval <dur>     How often to check (default 15s; 30s with --all; min 5s)
  --account <email>    Account override when 2+ are configured`;

export const WAIT_HELP = `usage: gws-axi chat wait (<space>… | --with <email> | --all) [flags]
flags[14]:
${SHARED_FLAGS}
  --timeout <dur>      Give up after this long: 30s, 9m, 1h, or 0 for no limit
                       (default 9m — under a 10-minute foreground limit)
  --full               Don't truncate message text (default cap: 500 chars)
examples:
  gws-axi chat wait AAAAxyz
  gws-axi chat wait AAAAxyz --thread t8Q --from bob@example.com
  gws-axi chat wait --all --mentions-me --timeout 0
  gws-axi chat wait AAAAxyz --after 2026-09-30T14:14:07.255999Z
output:
  The first new matching message(s), a \`cursor\`, and the command to wait for
  the next. On timeout: \`messages: none within <dur>\`, exit 0, and a resume
  command. Exit 1 only for failures a retry can't fix (auth, access).
notes:
  Blocks until something arrives. From an agent, run it as a BACKGROUND
  command: you get one notification when it returns. If it's killed, re-run
  it with --after <cursor> — no message is skipped or repeated.
  Polls Chat, so a message can take up to one --interval to show up.
  Reading never marks anything read.
`;

export const WATCH_HELP = `usage: gws-axi chat watch (<space>… | --with <email> | --all) [flags]
flags[13]:
${SHARED_FLAGS}
  --timeout <dur>      Stop after this long: 30s, 29m, 1h, or 0 for no limit
                       (default 29m — under a 30-minute monitor limit)
examples:
  gws-axi chat watch AAAAxyz
  gws-axi chat watch AAAAxyz BBBBabc --from bob@example.com
  gws-axi chat watch --all --type dm
  gws-axi chat watch --all --after 2026-09-30T14:14:07.255999Z
output:
  One line per event, flushed as it happens — made for a line-per-event
  monitor (each line is one notification):
    watching: …                     first line: what is watched, from when
    <time> <space> · <sender>: …    a message, with [space= msg= thread= cursor=]
    error: … / recovered: …         after 3 failed checks in a row, and after
    stopped: … — resume: <command>  last line: why, and how to continue
notes:
  Resume with --after <cursor> from the last line seen: nothing is skipped or
  repeated. Stops itself before the default timeout, and prints its resume
  line on SIGTERM/SIGINT too. Exit 1 only for failures a retry can't fix.
  Polls Chat, so a message can take up to one --interval to show up.
  Reading never marks anything read.
`;

const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;
const FATAL = new Set([
  "TOKEN_INVALID",
  "SCOPE_MISSING",
  "API_NOT_ENABLED",
  "SPACE_NOT_FOUND",
  "DM_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "CREDENTIALS_MISSING",
]);
const FAILURES_BEFORE_REPORT = 3;
const LINE_TEXT_CAP = 300;

/** `30s`, `9m`, `1h`, or `0` for no limit, in milliseconds. */
export function parseDuration(flag: string, raw: string): number {
  const value = raw.trim();
  if (value === "0") return 0;
  const match = DURATION.exec(value);
  if (!match) {
    throw new AxiError(
      `${flag} expects a duration like 30s, 9m, or 1h, got: ${raw}`,
      "VALIDATION_ERROR",
      [`${flag} 0 means no limit`],
    );
  }
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** A cursor passes through verbatim; any range-flag time is converted. */
export function parseAfter(raw: string, now: Date = new Date()): string {
  const value = raw.trim();
  if (isTimestamp(value)) return value;
  try {
    return cursorFromDate(new Date(parseRangeFlag(value, "from", now)));
  } catch {
    throw new AxiError(`--after expects a cursor or a time, got: ${raw}`, "VALIDATION_ERROR", [
      "Pass the cursor a previous run printed, or a time like -1h, today, or 2026-09-30T09:00",
    ]);
  }
}

export interface WatchFlags {
  spaces: string[];
  withEmail?: string;
  all: boolean;
  type?: SpaceKind;
  thread?: string;
  from?: string;
  mentionsMe: boolean;
  includeMine: boolean;
  after?: string;
  timeoutMs: number;
  intervalMs: number;
  full: boolean;
}

export function parseWatchFlags(args: string[], verb: "wait" | "watch", now?: Date): WatchFlags {
  const command = `chat ${verb}`;
  const parsed = parseArgs(
    args,
    {
      value: ["--with", "--type", "--thread", "--from", "--after", "--timeout", "--interval"],
      boolean: ["--all", "--mentions-me", "--include-mine", ...(verb === "wait" ? ["--full"] : [])],
    },
    command,
  );
  const usage = `Usage: gws-axi ${command} (<space>… | --with <email> | --all)`;
  const all = parsed.booleans.has("--all");
  const withEmail = parsed.values["--with"];
  const targets = [parsed.positionals.length > 0, withEmail !== undefined, all].filter(Boolean);
  if (targets.length !== 1) {
    throw new AxiError(
      targets.length === 0
        ? "Nothing to watch: name conversations, or pass --with <email> or --all"
        : "Pass conversations, --with, or --all — only one kind",
      "VALIDATION_ERROR",
      [usage, "Find conversation ids with `gws-axi chat spaces`"],
    );
  }
  const spaces = parsed.positionals.map(parseSpaceId);
  const type = parseChoice("--type", parsed.values["--type"], SPACE_KINDS);
  if (type && !all) {
    throw new AxiError("--type works only with --all", "VALIDATION_ERROR", [usage]);
  }
  const thread = parsed.values["--thread"];
  if (thread !== undefined && spaces.length !== 1) {
    throw new AxiError("--thread needs exactly one <space>", "VALIDATION_ERROR", [usage]);
  }
  const from = parsed.values["--from"]?.trim().toLowerCase();
  if (from !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new AxiError(
      `--from expects an email address, got: ${parsed.values["--from"]}`,
      "VALIDATION_ERROR",
      [usage],
    );
  }
  const intervalMs = parsed.values["--interval"]
    ? parseDuration("--interval", parsed.values["--interval"])
    : all
      ? 30_000
      : 15_000;
  if (intervalMs < 5000) {
    throw new AxiError("--interval can't be less than 5s", "VALIDATION_ERROR", [
      "Chat is polled; checking faster only spends quota",
    ]);
  }
  return {
    spaces,
    withEmail,
    all,
    type,
    thread: thread ? bareId(thread) : undefined,
    from,
    mentionsMe: parsed.booleans.has("--mentions-me"),
    includeMine: parsed.booleans.has("--include-mine"),
    after: parsed.values["--after"] ? parseAfter(parsed.values["--after"], now) : undefined,
    timeoutMs: parsed.values["--timeout"]
      ? parseDuration("--timeout", parsed.values["--timeout"])
      : verb === "wait"
        ? 9 * 60_000
        : 29 * 60_000,
    intervalMs,
    full: parsed.booleans.has("--full"),
  };
}

/** The command again, for a resume line: same flags, a new --after. */
export function resumeCommand(verb: "wait" | "watch", args: string[], cursor: string): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--after") {
      i++;
      continue;
    }
    kept.push(
      /^[A-Za-z0-9_./:@=+-]+$/.test(args[i]) ? args[i] : `'${args[i].replace(/'/g, `'\\''`)}'`,
    );
  }
  return `gws-axi chat ${verb} ${[...kept, "--after", cursor].join(" ")}`;
}

function chatDeps(api: chat_v1.Chat): PollDeps {
  return {
    listSpaces: async () => {
      const spaces: Space[] = [];
      let pageToken: string | undefined;
      do {
        const res = await retryingChat(() => api.spaces.list({ pageSize: 1000, pageToken }));
        spaces.push(...(res.data.spaces ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return spaces;
    },
    listMessages: async (spaceName, after) => {
      const messages: Message[] = [];
      let pageToken: string | undefined;
      do {
        const res = await retryingChat(() =>
          api.spaces.messages.list({
            parent: spaceName,
            filter: `createTime > "${after}"`,
            pageSize: 1000,
            pageToken,
            markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
          }),
        );
        messages.push(...(res.data.messages ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return messages;
    },
  };
}

/** Everything a run needs before its first wait; fails fast on a bad target. */
async function prepare(account: string, flags: WatchFlags) {
  const api = await chatClient(account);
  let named: Space[] = [];
  if (flags.withEmail !== undefined) {
    named = [
      await resolveSpace(api, account, resolveSpaceTarget({ withEmail: flags.withEmail }, "")),
    ];
  } else if (!flags.all) {
    named = await Promise.all(
      flags.spaces.map((id) => resolveSpace(api, account, { kind: "space", id })),
    );
  }
  const names = new Set(named.map((s) => s.name));
  const watched = flags.all
    ? (s: Space) => !flags.type || s.spaceType === TYPE_BY_KIND[flags.type]
    : (s: Space) => names.has(s.name);

  const self = selfUserRef(account);
  const rules: MatchRules = {
    self,
    account,
    includeMine: flags.includeMine,
    thread: flags.thread
      ? `${named[0]?.name ?? spaceResourceName(flags.spaces[0])}/threads/${flags.thread}`
      : undefined,
    from: flags.from,
    mentionsMe: flags.mentionsMe,
  };

  // Conversation labels, fetched once per conversation as they're needed.
  type Label = { id: string; type: string; name: string };
  const labels = new Map<string, Label>();
  const label = async (spaceName: string): Promise<Label> => {
    if (!labels.has(spaceName)) {
      let space: Space = { name: spaceName };
      try {
        space = (await api.spaces.get({ name: spaceName })).data;
      } catch {
        // Some direct messages refuse to describe themselves; name from members.
      }
      const [n] = (await nameSpaces(api, account, [space])).named;
      labels.set(spaceName, { id: n.id, type: n.type, name: n.name });
    }
    return labels.get(spaceName) as Label;
  };

  let what: string;
  if (flags.all) what = flags.type ? `every ${flags.type} conversation` : "every conversation";
  else {
    const shown = await Promise.all(named.map((s) => label(s.name ?? "")));
    what = shown.length === 1 ? shown[0].name : `${shown.length} conversations`;
  }
  return { api, deps: chatDeps(api), watched, rules, label, what };
}

function classify(err: unknown, account: string): AxiError {
  if (err instanceof AxiError) return err;
  return chatError(err, { account, operation: "chat.poll" });
}

/** Stop signals end a run with its resume output rather than killing it mid-line. */
function onStop(): {
  stopped: () => string | undefined;
  sleep: (ms: number) => Promise<void>;
  dispose: () => void;
} {
  let reason: string | undefined;
  let wake: (() => void) | undefined;
  const handler = (signal: NodeJS.Signals): void => {
    reason = signal;
    wake?.();
  };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const s of signals) process.on(s, handler);
  return {
    stopped: () => reason,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        if (reason) return resolve();
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = done;
      }),
    dispose: () => {
      for (const s of signals) process.off(s, handler);
    },
  };
}

/** Write one line and flush it, so a monitor sees it now and in order. */
const emit = (line: string): void => {
  writeSync(1, `${line}\n`);
};

export async function chatWaitCommand(account: string, args: string[]): Promise<string> {
  const flags = parseWatchFlags(args, "wait");
  const run = await prepare(account, flags).catch((err) => {
    throw classify(err, account);
  });
  const stop = onStop();
  const deadline = flags.timeoutMs > 0 ? Date.now() + flags.timeoutMs : Number.POSITIVE_INFINITY;

  try {
    let cursor = flags.after ?? (await snapshotNow(run.deps));
    let checkNow = flags.after !== undefined;
    let found: Message[] = [];
    for (;;) {
      if (checkNow) {
        try {
          const result = await check(run.deps, cursor, run.watched);
          cursor = result.snapshot;
          found = result.messages.filter((m) => matches(m, run.rules));
        } catch (err) {
          const axi = classify(err, account);
          if (FATAL.has(axi.code)) throw axi;
          // Transient: the next check tries again.
        }
      }
      checkNow = true;
      if (found.length > 0 || stop.stopped()) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await stop.sleep(Math.min(flags.intervalMs, remaining));
    }

    const resume = resumeCommand("wait", args, cursor);
    if (found.length === 0) {
      const why = stop.stopped()
        ? `none before ${stop.stopped()}`
        : `none within ${formatDuration(flags.timeoutMs)}`;
      return joinBlocks(
        renderObject({ account }),
        renderObject({ messages: why }),
        renderObject({ cursor }),
        renderHelp([`Keep waiting: \`${resume}\``]),
      );
    }

    const { ledger, resolution } = await identifyPeople(account, found);
    const rows = found.map((m) => toRow(m, ledger, { full: flags.full }));
    const blocks = [renderObject({ account }), renderObject({ matched: found.length })];
    if (found.length === 1) {
      const space = await run.label(found[0].space?.name ?? "");
      const row = rows[0];
      blocks.push(renderObject({ space }));
      blocks.push(
        renderObject({
          message: {
            id: row.id,
            time: row.time,
            sender: row.sender,
            thread: row.thread,
            text: row.text,
          },
        }),
      );
    } else {
      blocks.push(
        renderList("messages", rows as unknown as Array<Record<string, unknown>>, [
          field("space"),
          field("id"),
          field("time"),
          field("sender"),
          field("thread"),
          field("text"),
        ]),
      );
    }
    blocks.push(renderObject({ cursor }));
    const unresolved = ledger.unresolved();
    if (resolution.degraded) blocks.push(renderObject({ note: resolution.degraded }));
    else if (unresolved > 0) blocks.push(renderObject({ note: UNRESOLVED_NOTE }));
    const first = rows[0];
    blocks.push(
      renderHelp([
        `Reply: \`gws-axi chat send ${first.space} --thread ${first.thread} --text "…" --account ${account}\``,
        `Wait for the next one: \`${resume}\``,
      ]),
    );
    return joinBlocks(...blocks);
  } finally {
    stop.dispose();
  }
}

/** One self-contained line for a message. */
async function messageLine(
  message: Message,
  run: Awaited<ReturnType<typeof prepare>>,
  account: string,
): Promise<string> {
  const { ledger } = await identifyPeople(account, [message]);
  const space = await run.label(message.space?.name ?? "");
  const where =
    space.type === "dm" || space.type === "group" ? `${space.name} (${space.type})` : space.name;
  const text = truncateKeepingLinks(
    renderMessageText(message, (u) => ledger.label(u))
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ⏎ "),
    LINE_TEXT_CAP,
  );
  const row = toRow(message, ledger, { full: true });
  return `${row.time} ${where} · ${row.sender}: ${text} [space=${row.space} msg=${row.id} thread=${row.thread} cursor=${message.createTime}]`;
}

/**
 * `source` is the account_source label, passed in because a streaming command's
 * header is its first line, written long before the dispatcher sees output.
 */
export async function chatWatchCommand(
  account: string,
  args: string[],
  source?: string,
): Promise<string> {
  const flags = parseWatchFlags(args, "watch");
  const run = await prepare(account, flags).catch((err) => {
    throw classify(err, account);
  });
  const stop = onStop();
  const started = Date.now();
  const deadline = flags.timeoutMs > 0 ? started + flags.timeoutMs : Number.POSITIVE_INFINITY;

  try {
    let cursor = flags.after ?? (await snapshotNow(run.deps));
    emit(
      `watching: ${run.what} as ${account}${source ? ` (account_source: ${source})` : ""}, from ${cursor}, every ${formatDuration(flags.intervalMs)}, ${
        flags.timeoutMs > 0 ? `stopping after ${formatDuration(flags.timeoutMs)}` : "until stopped"
      }`,
    );
    let checkNow = flags.after !== undefined;
    let failures = 0;
    for (;;) {
      if (checkNow) {
        try {
          const result = await check(run.deps, cursor, run.watched);
          for (const message of result.messages) {
            if (matches(message, run.rules)) emit(await messageLine(message, run, account));
          }
          cursor = result.snapshot;
          if (failures >= FAILURES_BEFORE_REPORT) emit(`recovered: checks are succeeding again`);
          failures = 0;
        } catch (err) {
          const axi = classify(err, account);
          // The structured error is the last thing printed, exit 1.
          if (FATAL.has(axi.code)) throw axi;
          failures++;
          if (failures === FAILURES_BEFORE_REPORT) {
            emit(
              `error: ${failures} checks in a row failed (${axi.code}: ${axi.message}); still trying`,
            );
          }
        }
      }
      checkNow = true;
      if (stop.stopped()) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await stop.sleep(Math.min(flags.intervalMs, remaining));
    }
    const why = stop.stopped()
      ? `signal ${stop.stopped()}`
      : `timeout after ${formatDuration(flags.timeoutMs)}`;
    return `stopped: ${why} — resume: ${resumeCommand("watch", args, cursor)}`;
  } finally {
    stop.dispose();
  }
}
