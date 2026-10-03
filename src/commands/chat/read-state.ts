import { AxiError } from "axi-sdk-js";
import type { chat_v1 } from "googleapis";
import { chatClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { parseDateishFlag } from "../calendar/dateish.js";
import { parseSpaceId, spaceResourceName } from "./address.js";
import { parseArgs } from "../../util/flags.js";
import { bareId, chatError, localTime, nameSpaces, retryingChat } from "./shared.js";

/**
 * Marking conversations read and unread. Both are WRITES: they change what
 * the account's owner sees in Chat, and marking something read can hide a
 * message from the person it was meant for. Reading never does either.
 *
 * See specs/commands/chat-read-state.md.
 */

export const MARK_READ_HELP = `usage: gws-axi chat mark-read <space> [<space>…] [flags]
args[1]:
  <space>              One or more conversation ids (AAAA… or spaces/AAAA…)
                       or Chat URLs
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated
                       (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi chat mark-read AAAAxyz --account you@example.com
  gws-axi chat mark-read AAAAxyz BBBBabc --account you@example.com
output:
  \`results[N]{space,name,status,last_read}\`. status is marked_read,
  already_read, or failed.
notes:
  This changes what you see as unread in Chat.
  Thread replies are tracked separately and are NOT affected — Google's API
  cannot mark a thread read. A conversation marked read here can still show
  unread replies in Chat.
  Each conversation is handled on its own: one failing doesn't stop the rest.
`;

export const MARK_UNREAD_HELP = `usage: gws-axi chat mark-unread <space> (--from <messageId> | --at <time>) [flags]
args[1]:
  <space>              A conversation id (AAAA… or spaces/AAAA…) or a Chat URL
flags[3]:
  --from <messageId>   Mark this message and everything after it unread
  --at <time>          Mark everything after this moment unread
                       (2026-04-20T14:00, or with an offset)
  --account <email>    REQUIRED when 2+ accounts are authenticated
                       (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi chat mark-unread AAAAxyz --from Hk2… --account you@example.com
  gws-axi chat mark-unread AAAAxyz --at 2026-04-20T09:00 --account you@example.com
output:
  \`results[1]{space,name,status,last_read}\`. status is marked_unread or
  already_unread_from_earlier.
notes:
  Exactly one of --from / --at is required — there is no default point.
  Thread replies are tracked separately and are NOT affected.
`;

const THREAD_NOTE = "Thread replies are tracked separately and are not affected.";

type Chat = chat_v1.Chat;

export interface ResultRow {
  space: string;
  name: string;
  status: string;
  last_read: string;
  reason?: string;
}

const readStateName = (spaceId: string): string =>
  `users/me/${spaceResourceName(spaceId)}/spaceReadState`;

async function latestMessageTime(api: Chat, spaceId: string): Promise<string | undefined> {
  const res = await retryingChat(() =>
    api.spaces.messages.list({
      parent: spaceResourceName(spaceId),
      pageSize: 1,
      orderBy: "createTime desc",
    }),
  );
  return res.data.messages?.[0]?.createTime ?? undefined;
}

/** Already read when the read position is at or past the newest message. */
export function isAlreadyRead(lastRead: string | undefined, latest: string | undefined): boolean {
  if (!latest) return true;
  if (!lastRead) return false;
  return new Date(lastRead).getTime() >= new Date(latest).getTime();
}

/** Nothing to do when the requested point is not earlier than the read position. */
export function isAlreadyUnreadFrom(lastRead: string | undefined, point: string): boolean {
  if (!lastRead) return true;
  return new Date(point).getTime() >= new Date(lastRead).getTime();
}

async function spaceLabels(
  api: Chat,
  account: string,
  ids: string[],
): Promise<Map<string, string>> {
  const found = await Promise.all(
    ids.map(async (id): Promise<chat_v1.Schema$Space | undefined> => {
      try {
        return (await api.spaces.get({ name: spaceResourceName(id) })).data;
      } catch {
        // No name for a conversation that can't be described; its row says why.
        return undefined;
      }
    }),
  );
  const spaces = found.filter((s): s is chat_v1.Schema$Space => s !== undefined);
  const { named } = await nameSpaces(api, account, spaces);
  return new Map(named.map((s) => [s.id, s.name]));
}

const CHANGED = new Set(["marked_read", "marked_unread"]);

function render(account: string, verb: string, rows: ResultRow[], spaceId: string): string {
  const failed = rows.some((r) => r.status === "failed");
  // The command's name is not its outcome: say so when nothing changed.
  const action = rows.some((r) => CHANGED.has(r.status)) ? verb : "no_change";
  const schema = [field("space"), field("name"), field("status"), field("last_read")];
  if (failed) schema.push(field("reason"));
  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderList("results", rows as unknown as Array<Record<string, unknown>>, schema),
    renderObject({ note: THREAD_NOTE }),
    renderHelp([`Run \`gws-axi chat messages ${spaceId}\` to read the conversation`]),
  );
}

export async function chatMarkReadCommand(account: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args, {}, "chat mark-read");
  if (parsed.positionals.length === 0) {
    throw new AxiError("Missing conversation: pass one or more ids", "VALIDATION_ERROR", [
      "Usage: gws-axi chat mark-read <space> [<space>…]",
      "Run `gws-axi chat spaces` to find conversation ids",
    ]);
  }
  // Every id is validated before any conversation is touched.
  const ids = [...new Set(parsed.positionals.map(parseSpaceId))];
  const api = await chatClient(account);
  const labels = await spaceLabels(api, account, ids);

  const rows: ResultRow[] = [];
  for (const id of ids) {
    const base = { space: id, name: labels.get(id) ?? "" };
    try {
      const [state, latest] = await Promise.all([
        retryingChat(() => api.users.spaces.getSpaceReadState({ name: readStateName(id) })),
        latestMessageTime(api, id),
      ]);
      const lastRead = state.data.lastReadTime ?? undefined;
      if (isAlreadyRead(lastRead, latest)) {
        rows.push({ ...base, status: "already_read", last_read: localTime(lastRead) });
        continue;
      }
      const updated = await retryingChat(() =>
        api.users.spaces.updateSpaceReadState({
          name: readStateName(id),
          updateMask: "lastReadTime",
          requestBody: { lastReadTime: new Date().toISOString() },
        }),
      );
      // Reported from the response: Chat coerces the value to the newest message.
      rows.push({
        ...base,
        status: "marked_read",
        last_read: localTime(updated.data.lastReadTime),
      });
    } catch (err) {
      const translated = chatError(err, {
        account,
        operation: "chat.users.spaces.updateSpaceReadState",
        space: id,
      });
      // A scope or auth failure will fail every conversation the same way.
      if (["SCOPE_MISSING", "TOKEN_INVALID", "API_NOT_ENABLED"].includes(translated.code)) {
        throw translated;
      }
      rows.push({ ...base, status: "failed", last_read: "", reason: translated.message });
    }
  }

  const output = render(account, "marked_read", rows, ids[0]);
  if (rows.some((r) => r.status === "failed")) process.exitCode = 1;
  return output;
}

interface UnreadFlags {
  space: string;
  from: string | undefined;
  at: string | undefined;
}

export function parseMarkUnreadFlags(args: string[]): UnreadFlags {
  const parsed = parseArgs(args, { value: ["--from", "--at"] }, "chat mark-unread");
  const usage = "Usage: gws-axi chat mark-unread <space> (--from <messageId> | --at <time>)";
  if (parsed.positionals.length !== 1) {
    throw new AxiError(
      parsed.positionals.length === 0
        ? "Missing conversation id"
        : "`chat mark-unread` takes one conversation",
      "VALIDATION_ERROR",
      [usage],
    );
  }
  const from = parsed.values["--from"];
  const at = parsed.values["--at"];
  if ((from === undefined) === (at === undefined)) {
    throw new AxiError(
      from === undefined
        ? "Say where unread starts: pass --from <messageId> or --at <time>"
        : "Pass --from or --at, not both",
      "VALIDATION_ERROR",
      [usage, "There is no default point — gws-axi won't guess how far back to go"],
    );
  }
  return {
    space: parseSpaceId(parsed.positionals[0]),
    from: from ? bareId(from) : undefined,
    // --at names one moment, so it is parsed literally, not as a range edge.
    at: at ? parseDateishFlag(at) : undefined,
  };
}

export async function chatMarkUnreadCommand(account: string, args: string[]): Promise<string> {
  const flags = parseMarkUnreadFlags(args);
  const api = await chatClient(account);
  const labels = await spaceLabels(api, account, [flags.space]);
  const base = { space: flags.space, name: labels.get(flags.space) ?? "" };

  let point: string;
  if (flags.from) {
    try {
      const message = await api.spaces.messages.get({
        name: `${spaceResourceName(flags.space)}/messages/${flags.from}`,
      });
      const created = message.data.createTime;
      if (!created) throw new Error("message has no create time");
      // Just before the message, so the message itself reads as unread.
      point = new Date(new Date(created).getTime() - 1).toISOString();
    } catch (err) {
      if (err instanceof AxiError) throw err;
      throw new AxiError(
        `No message ${flags.from} in conversation ${flags.space}`,
        "MESSAGE_NOT_FOUND",
        [`Run \`gws-axi chat messages ${flags.space}\` to see message ids`],
      );
    }
  } else {
    point = flags.at as string;
  }

  try {
    const state = await retryingChat(() =>
      api.users.spaces.getSpaceReadState({ name: readStateName(flags.space) }),
    );
    const lastRead = state.data.lastReadTime ?? undefined;
    if (isAlreadyUnreadFrom(lastRead, point)) {
      return render(
        account,
        "marked_unread",
        [{ ...base, status: "already_unread_from_earlier", last_read: localTime(lastRead) }],
        flags.space,
      );
    }
    const updated = await retryingChat(() =>
      api.users.spaces.updateSpaceReadState({
        name: readStateName(flags.space),
        updateMask: "lastReadTime",
        requestBody: { lastReadTime: point },
      }),
    );
    return render(
      account,
      "marked_unread",
      [{ ...base, status: "marked_unread", last_read: localTime(updated.data.lastReadTime) }],
      flags.space,
    );
  } catch (err) {
    throw chatError(err, {
      account,
      operation: "chat.users.spaces.updateSpaceReadState",
      space: flags.space,
    });
  }
}
