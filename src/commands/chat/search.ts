import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveWindow } from "../calendar/dateish.js";
import { parseSpaceId, spaceResourceName } from "./address.js";
import { parseArgs, parseChoice, parseLimit } from "./flags.js";
import { UNRESOLVED_NOTE } from "./identity.js";
import { identifyPeople, messageSchema, senderRows, toRow } from "./message-rows.js";
import { rangeEcho } from "./messages.js";
import {
  chatError,
  nameSpaces,
  SPACE_KINDS,
  TYPE_BY_KIND,
  type SpaceKind,
  retryingChat,
} from "./shared.js";

export const SEARCH_HELP = `usage: gws-axi chat search [<keywords>] [flags]
args[1]:
  <keywords>           Words to look for. Quote a phrase: "status update"
flags[12]:
  --space <space>      Only this conversation (id or Chat URL)
  --from <email>       Only messages sent by this person
  --type <kind>        Only this kind of conversation: space, group, dm
  --unread             Only unread messages
  --mentions-me        Only messages that mention you
  --has-link           Only messages containing a link
  --has-attachment     Only messages with an attachment
  --since <when>       Only messages at/after this time
  --until <when>       Only messages before this time. Date-only values are
                       whole days; tokens like today, -7d, now are accepted.
  --limit <n>          Max messages to return (default: 25, max: 100)
  --page <token>       Continue from a previous response's next_page
  --full               Don't truncate message text (default cap: 500 chars)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi chat search budget
  gws-axi chat search "status update" --since -7d
  gws-axi chat search --mentions-me --unread
  gws-axi chat search invoice --from bob@example.com --has-attachment
output:
  \`messages[N]{space,id,time,sender,text}\`, newest first, with
  \`spaces[N]{id,type,name}\` and \`senders[N]{id,name,email,type}\` legends.
notes:
  At least one keyword or filter is required.
  Search does not see everything: private messages, messages posted by
  apps, app direct messages, messages from blocked users, and muted
  conversations are left out — and recent direct messages have been seen
  missing too. To read a conversation directly, use \`chat messages <space>\`.
`;

const COMMAND = "chat search";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const COVERAGE_NOTE =
  "Search does not see everything: it omits private messages, messages posted by apps, app direct messages, messages from blocked users, and muted conversations, and has been seen to miss recent direct messages. Read a conversation directly with `gws-axi chat messages <space>`.";

interface Flags {
  keywords: string[];
  space: string | undefined;
  from: string | undefined;
  type: SpaceKind | undefined;
  unread: boolean;
  mentionsMe: boolean;
  hasLink: boolean;
  hasAttachment: boolean;
  since: string | undefined;
  until: string | undefined;
  limit: number;
  page: string | undefined;
  full: boolean;
}

export function parseSearchFlags(args: string[], now: Date = new Date()): Flags {
  const parsed = parseArgs(
    args,
    {
      value: ["--space", "--from", "--type", "--since", "--until", "--limit", "--page"],
      boolean: ["--unread", "--mentions-me", "--has-link", "--has-attachment", "--full"],
    },
    COMMAND,
  );
  const from = parsed.values["--from"]?.trim().toLowerCase();
  if (from !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new AxiError(
      `--from expects an email address, got: ${parsed.values["--from"]}`,
      "VALIDATION_ERROR",
      ["Search matches a sender by address only"],
    );
  }
  const window = resolveWindow(
    { from: parsed.values["--since"], to: parsed.values["--until"] },
    { flagNames: { from: "--since", to: "--until" }, shortcuts: false, now },
  );
  const flags: Flags = {
    keywords: parsed.positionals.map((k) => k.trim()).filter(Boolean),
    space: parsed.values["--space"] ? parseSpaceId(parsed.values["--space"]) : undefined,
    from,
    type: parseChoice("--type", parsed.values["--type"], SPACE_KINDS),
    unread: parsed.booleans.has("--unread"),
    mentionsMe: parsed.booleans.has("--mentions-me"),
    hasLink: parsed.booleans.has("--has-link"),
    hasAttachment: parsed.booleans.has("--has-attachment"),
    since: window.from,
    until: window.to,
    limit: parseLimit(
      parsed.values["--limit"],
      { fallback: DEFAULT_LIMIT, max: MAX_LIMIT },
      COMMAND,
    ),
    page: parsed.values["--page"],
    full: parsed.booleans.has("--full"),
  };
  if (buildSearchFilter(flags) === "") {
    throw new AxiError("chat search needs a keyword or a filter", "VALIDATION_ERROR", [
      "Run `gws-axi chat search <keywords>` to search message text",
      "Run `gws-axi chat spaces` to browse conversations",
      "Run `gws-axi chat messages <space>` to read one",
    ]);
  }
  return flags;
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * The search `filter`. Field names are the ones the API accepts, which are not
 * the ones its reference gives: the time field is `create_time`, and a sender
 * matches by address but not by id.
 */
export function buildSearchFilter(flags: Omit<Flags, "limit" | "page" | "full">): string {
  const clauses: string[] = [];
  // A phrase the caller quoted arrives as one argument containing a space.
  for (const keyword of flags.keywords) {
    clauses.push(/\s/.test(keyword) ? quoted(keyword) : keyword.replace(/"/g, ""));
  }
  if (flags.space) clauses.push(`space.name = ${quoted(spaceResourceName(flags.space))}`);
  if (flags.from) clauses.push(`sender.name = ${quoted(`users/${flags.from}`)}`);
  if (flags.type) clauses.push(`space.space_type = ${quoted(TYPE_BY_KIND[flags.type])}`);
  if (flags.unread) clauses.push("is_unread()");
  if (flags.mentionsMe) clauses.push("annotations.user_mentions.user.name:users/me");
  if (flags.hasLink) clauses.push("has_link()");
  if (flags.hasAttachment) clauses.push("attachment:*");
  // Sent in UTC; the range echo stays in local-offset ISO.
  if (flags.since) clauses.push(`create_time >= ${quoted(new Date(flags.since).toISOString())}`);
  if (flags.until) clauses.push(`create_time < ${quoted(new Date(flags.until).toISOString())}`);
  return clauses.join(" AND ");
}

function carryFlags(args: string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--page") {
      i++;
      continue;
    }
    kept.push(/\s/.test(args[i]) ? JSON.stringify(args[i]) : args[i]);
  }
  return kept.join(" ");
}

export async function chatSearchCommand(account: string, args: string[]): Promise<string> {
  const flags = parseSearchFlags(args);
  const api = await chatClient(account);

  let messages: chat_v1.Schema$Message[];
  let nextPage: string | undefined;
  try {
    const res = await retryingChat(() =>
      api.spaces.messages.search({
        parent: "spaces/-",
        requestBody: {
          filter: buildSearchFilter(flags),
          pageSize: flags.limit,
          pageToken: flags.page,
          orderBy: "createTime desc",
          markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
        },
      }),
    );
    messages = (res.data.results ?? []).flatMap((r) => (r.message ? [r.message] : []));
    nextPage = res.data.nextPageToken ?? undefined;
  } catch (err) {
    throw chatError(err, { account, operation: "chat.spaces.messages.search", space: flags.space });
  }

  const blocks: string[] = [renderObject({ account })];
  if (flags.since || flags.until) {
    blocks.push(renderObject({ range: rangeEcho(flags.since, flags.until) }));
  }

  if (messages.length === 0) {
    blocks.push(renderObject({ messages: "no messages matched" }));
    // On the empty result above all: "nothing matched" must not read as
    // "nothing was said".
    blocks.push(renderObject({ note: COVERAGE_NOTE }));
    const help = ["Loosen the search: fewer keywords, or drop a filter"];
    if (flags.space)
      help.push(`Run \`gws-axi chat messages ${flags.space}\` to read that conversation directly`);
    else help.push("Run `gws-axi chat spaces` to browse conversations");
    blocks.push(renderHelp(help));
    return joinBlocks(...blocks);
  }

  // Each conversation in the result is fetched once for the legend.
  const spaceNames = [...new Set(messages.map((m) => m.space?.name).filter(Boolean))] as string[];
  const spaces = await Promise.all(
    spaceNames.map(async (name): Promise<chat_v1.Schema$Space> => {
      try {
        return (await api.spaces.get({ name })).data;
      } catch {
        // A legend entry is decoration: fall back to the bare conversation.
        return { name };
      }
    }),
  );
  const [{ named }, { ledger, resolution }] = await Promise.all([
    nameSpaces(api, account, spaces),
    identifyPeople(account, messages),
  ]);

  const rows = messages.map((m) => toRow(m, ledger, { full: flags.full }));
  const unresolved = ledger.unresolved();

  blocks.push(
    renderObject({
      count: nextPage ? `${rows.length} (more available)` : rows.length,
      order: "newest → oldest",
      ...(nextPage ? { next_page: nextPage } : {}),
      ...(unresolved > 0 ? { unresolved } : {}),
    }),
  );
  blocks.push(
    renderList(
      "messages",
      rows as unknown as Array<Record<string, unknown>>,
      messageSchema({ withSpace: true, withThread: false, fields: [] }),
    ),
  );
  blocks.push(
    renderList(
      "spaces",
      named.map((s) => ({ id: s.id, type: s.type, name: s.name })),
      [field("id"), field("type"), field("name")],
    ),
  );
  blocks.push(
    renderList("senders", senderRows(messages, ledger), [
      field("id"),
      field("name"),
      field("email"),
      field("type"),
    ]),
  );

  const notes = [COVERAGE_NOTE];
  if (resolution.degraded) notes.push(resolution.degraded);
  else if (unresolved > 0) notes.push(UNRESOLVED_NOTE);
  blocks.push(renderObject({ note: notes.join(" ") }));

  const first = rows[0];
  const help: string[] = [];
  const carried = carryFlags(args);
  if (nextPage) help.push(`More results: \`gws-axi chat search ${carried} --page ${nextPage}\``);
  help.push(
    `Run \`gws-axi chat messages ${first.space} --thread ${first.thread}\` to read a result in context`,
  );
  if (rows.some((r) => r.text.includes("… (truncated,")) && !flags.full) {
    help.push(`Run \`gws-axi chat search ${carried} --full\` for untruncated text`);
  }
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
