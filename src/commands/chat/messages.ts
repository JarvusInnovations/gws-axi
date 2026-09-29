import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { resolveWindow, toLocalOffsetISO } from "../calendar/dateish.js";
import { resolveSpaceTarget, type SpaceTarget } from "./address.js";
import { parseArgs, parseChoices, parseLimit } from "./flags.js";
import { UNRESOLVED_NOTE } from "./identity.js";
import {
  ATTACHMENT_SCHEMA,
  attachmentRows,
  FIELD_CHOICES,
  identifyPeople,
  messageSchema,
  senderRows,
  threadsCarryInformation,
  toRow,
  type OptionalField,
} from "./message-rows.js";
import { bareId, chatError, nameSpaces, resolveSpace, retryingChat } from "./shared.js";

export const MESSAGES_HELP = `usage: gws-axi chat messages <space> [flags]
       gws-axi chat messages --with <email> [flags]
args[1]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL.
                       Get one from \`gws-axi chat spaces\`.
flags[9]:
  --with <email>       Read the 1:1 direct message with this person instead
                       of naming a conversation
  --since <when>       Only messages at/after this time. A date-only value
                       opens at that day's local midnight.
  --until <when>       Only messages before this time. A date-only value
                       closes at the END of that day, so
                       --since D --until D is all of day D. Both accept
                       tokens: now, today, tomorrow, yesterday, +Nd/-Nd,
                       +Nw/-Nw, +Nh/-Nh.
  --thread <id>        Only this thread
  --limit <n>          Max messages to return (default: 50, max: 1000)
  --page <token>       Continue from a previous response's next_page — the
                       next-OLDER messages. Keep the other flags the same.
  --fields <list>      Extra columns, comma-separated: thread, attachments,
                       reactions, edited, quoted
  --full               Don't truncate message text (default cap: 500 chars)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi chat messages AAAAxyz
  gws-axi chat messages --with bob@example.com --since today
  gws-axi chat messages AAAAxyz --since -7d --fields attachments,reactions
  gws-axi chat messages AAAAxyz --thread t8Q…
output:
  A \`space{id,type,name}\` header, then \`messages[N]{id,time,sender,text}\`
  and a \`senders[N]{id,name,email,type}\` legend.
notes:
  The LATEST messages are selected, and shown oldest first so they read as
  a conversation. Text is Markdown; mentions read @Name.
  A \`thread\` column appears when messages in the result share a thread.
  Reading never changes what is marked read.
  Attachments can't be downloaded through gws-axi. Ones that are Drive
  files are listed with their file id under --fields attachments.
`;

const COMMAND = "chat messages";
const USAGE = "Usage: gws-axi chat messages <space> | --with <email>";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

interface Flags {
  target: SpaceTarget;
  since: string | undefined;
  until: string | undefined;
  thread: string | undefined;
  limit: number;
  page: string | undefined;
  fields: OptionalField[];
  full: boolean;
}

export function parseMessagesFlags(args: string[], now: Date = new Date()): Flags {
  const parsed = parseArgs(
    args,
    {
      value: ["--with", "--since", "--until", "--thread", "--limit", "--page", "--fields"],
      boolean: ["--full"],
    },
    COMMAND,
  );
  if (parsed.positionals.length > 1) {
    throw new AxiError(
      `\`${COMMAND}\` reads one conversation, got ${parsed.positionals.length}: ${parsed.positionals.join(", ")}`,
      "VALIDATION_ERROR",
      [USAGE],
    );
  }
  const target = resolveSpaceTarget(
    { positional: parsed.positionals[0], withEmail: parsed.values["--with"] },
    USAGE,
  );
  const window = resolveWindow(
    { from: parsed.values["--since"], to: parsed.values["--until"] },
    { flagNames: { from: "--since", to: "--until" }, shortcuts: false, now },
  );
  return {
    target,
    since: window.from,
    until: window.to,
    thread: parsed.values["--thread"] ? bareId(parsed.values["--thread"]) : undefined,
    limit: parseLimit(
      parsed.values["--limit"],
      { fallback: DEFAULT_LIMIT, max: MAX_LIMIT },
      COMMAND,
    ),
    page: parsed.values["--page"],
    fields: parseChoices("--fields", parsed.values["--fields"], FIELD_CHOICES),
    full: parsed.booleans.has("--full"),
  };
}

/**
 * The `filter` for a message list. The API offers only strict `>` and `<`, so
 * the inclusive lower edge of a half-open window is sent as "after the
 * millisecond before it".
 */
export function buildListFilter(
  spaceName: string,
  flags: { since?: string; until?: string; thread?: string },
): string | undefined {
  const clauses: string[] = [];
  if (flags.since) {
    const justBefore = new Date(new Date(flags.since).getTime() - 1).toISOString();
    clauses.push(`createTime > "${justBefore}"`);
  }
  if (flags.until) clauses.push(`createTime < "${new Date(flags.until).toISOString()}"`);
  if (flags.thread) clauses.push(`thread.name = ${spaceName}/threads/${flags.thread}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

/** `--since`/`--until` as they appear in the `range:` echo. */
export function rangeEcho(since: string | undefined, until: string | undefined): string {
  return `${since ? toLocalOffsetISO(since) : "(any)"} → ${until ? toLocalOffsetISO(until) : "(any)"}`;
}

/** The flags of this invocation, rebuilt for a `help[]` line. */
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

export async function chatMessagesCommand(account: string, args: string[]): Promise<string> {
  const flags = parseMessagesFlags(args);
  const api = await chatClient(account);
  const space = await resolveSpace(api, account, flags.target);
  const spaceName = space.name ?? "";
  const spaceId = bareId(spaceName);

  let messages: chat_v1.Schema$Message[];
  let nextPage: string | undefined;
  try {
    const res = await retryingChat(() =>
      api.spaces.messages.list({
        parent: spaceName,
        pageSize: flags.limit,
        pageToken: flags.page,
        // Newest first, so a bounded read is the latest messages rather than
        // the conversation's first ones. Rendering reverses it below.
        orderBy: "createTime desc",
        filter: buildListFilter(spaceName, flags),
        markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
      }),
    );
    messages = res.data.messages ?? [];
    nextPage = res.data.nextPageToken ?? undefined;
  } catch (err) {
    throw chatError(err, {
      account,
      operation: "chat.spaces.messages.list",
      space: spaceId,
      thread: flags.thread,
    });
  }

  const [{ named }, { ledger, resolution }] = await Promise.all([
    nameSpaces(api, account, [space]),
    identifyPeople(account, messages),
  ]);
  const header = named[0];

  const blocks: string[] = [
    renderObject({ account }),
    renderObject({ space: { id: header.id, type: header.type, name: header.name } }),
  ];
  if (flags.since || flags.until) {
    blocks.push(renderObject({ range: rangeEcho(flags.since, flags.until) }));
  }

  if (messages.length === 0) {
    const scope = flags.thread
      ? `in thread ${flags.thread}`
      : flags.since || flags.until
        ? "in that time range"
        : "in this conversation";
    blocks.push(renderObject({ messages: `no messages ${scope}` }));
    const help = [`Run \`gws-axi chat messages ${spaceId}\` to read the latest messages`];
    if (flags.since || flags.until) help.unshift("Widen the window with `--since` / `--until`");
    blocks.push(renderHelp(help));
    return joinBlocks(...blocks);
  }

  // Oldest first, so the rows read top to bottom as the conversation did.
  const ordered = [...messages].reverse();
  const rows = ordered.map((m) => toRow(m, ledger, { full: flags.full }));
  const unresolved = ledger.unresolved();

  blocks.push(
    renderObject({
      count: nextPage
        ? `${rows.length} (latest ${rows.length}; older messages exist)`
        : rows.length,
      order: "oldest → newest",
      ...(nextPage ? { next_page: nextPage } : {}),
      ...(unresolved > 0 ? { unresolved } : {}),
    }),
  );
  blocks.push(
    renderList(
      "messages",
      rows as unknown as Array<Record<string, unknown>>,
      messageSchema({
        withSpace: false,
        withThread: !flags.thread && threadsCarryInformation(messages),
        fields: flags.fields,
      }),
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

  const attachments = attachmentRows(ordered);
  const showAttachments = flags.fields.includes("attachments");
  if (showAttachments && attachments.length > 0) {
    blocks.push(
      renderList(
        "attachments",
        attachments as unknown as Array<Record<string, unknown>>,
        ATTACHMENT_SCHEMA,
      ),
    );
  }

  const notes: string[] = [];
  if (resolution.degraded) notes.push(resolution.degraded);
  else if (unresolved > 0) notes.push(UNRESOLVED_NOTE);
  if (showAttachments && attachments.some((a) => a.source === "upload")) {
    notes.push(
      "Uploaded attachments can't be retrieved through gws-axi; no command downloads them.",
    );
  }
  if (notes.length > 0) blocks.push(renderObject({ note: notes.join(" ") }));

  const help: string[] = [];
  const carried = carryFlags(args);
  if (nextPage) {
    help.push(`Older messages: \`gws-axi chat messages ${carried} --page ${nextPage}\``);
  }
  if (rows.some((r) => r.text.includes("… (truncated,")) && !flags.full) {
    help.push(`Run \`gws-axi chat messages ${carried} --full\` for untruncated text`);
  }
  if (!showAttachments && attachments.length > 0) {
    const carrying = new Set(attachments.map((a) => a.message)).size;
    help.push(
      `${carrying} message(s) carry attachments — add \`--fields attachments\` to list them`,
    );
  }
  const driveFile = showAttachments ? attachments.find((a) => a.drive_file) : undefined;
  if (driveFile) {
    help.push(
      `Run \`gws-axi drive get ${driveFile.drive_file}\` for an attached Drive file's details`,
    );
  }
  if (!flags.since && !flags.until) {
    help.push(`Bound the window: \`gws-axi chat messages ${spaceId} --since today\``);
  }
  help.push(`Run \`gws-axi chat members ${spaceId}\` to see who is in this conversation`);
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
