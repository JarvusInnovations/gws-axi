import { checkFlags, type FlagSpec } from "../util/flags.js";
import { AxiError } from "axi-sdk-js";
import { accountSourceLabel, resolveAccount, withAccountSource } from "../google/account.js";
import { chatDownloadCommand, DOWNLOAD_HELP } from "./chat/download.js";
import { chatMembersCommand, MEMBERS_HELP } from "./chat/members.js";
import { chatMessagesCommand, MESSAGES_HELP } from "./chat/messages.js";
import {
  chatMarkReadCommand,
  chatMarkUnreadCommand,
  MARK_READ_HELP,
  MARK_UNREAD_HELP,
} from "./chat/read-state.js";
import { chatSearchCommand, SEARCH_HELP } from "./chat/search.js";
import { chatReactCommand, chatUnreactCommand, REACT_HELP, UNREACT_HELP } from "./chat/react.js";
import { chatSendCommand, SEND_HELP } from "./chat/send.js";
import { chatWaitCommand, chatWatchCommand, WAIT_HELP, WATCH_HELP } from "./chat/watch.js";
import { chatSpacesCommand, SPACES_HELP } from "./chat/spaces.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";

interface ChatSubcommand {
  /** Flags this subcommand takes — or "self" when its own parser validates them. */
  flags?: FlagSpec | "self";
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[], source?: string) => Promise<string>;
  /**
   * Writes its own header as a streamed first line, so the dispatcher passes
   * the account source in rather than splicing it into the final output.
   */
  streams?: boolean;
  instead?: string[];
}

export const SUBCOMMANDS: ChatSubcommand[] = [
  { name: "spaces", mutation: false, flags: "self", help: SPACES_HELP, handler: chatSpacesCommand },
  {
    name: "messages",
    mutation: false,
    flags: "self",
    help: MESSAGES_HELP,
    handler: chatMessagesCommand,
  },
  { name: "search", mutation: false, flags: "self", help: SEARCH_HELP, handler: chatSearchCommand },
  {
    name: "members",
    mutation: false,
    flags: "self",
    help: MEMBERS_HELP,
    handler: chatMembersCommand,
  },
  {
    name: "download",
    mutation: false,
    flags: "self",
    help: DOWNLOAD_HELP,
    handler: chatDownloadCommand,
  },
  { name: "wait", mutation: false, flags: "self", help: WAIT_HELP, handler: chatWaitCommand },
  {
    name: "watch",
    mutation: false,
    flags: "self",
    help: WATCH_HELP,
    handler: chatWatchCommand,
    streams: true,
  },
  { name: "send", mutation: true, flags: "self", help: SEND_HELP, handler: chatSendCommand },
  { name: "react", mutation: true, flags: "self", help: REACT_HELP, handler: chatReactCommand },
  {
    name: "unreact",
    mutation: true,
    flags: "self",
    help: UNREACT_HELP,
    handler: chatUnreactCommand,
  },
  {
    name: "mark-read",
    mutation: true,
    flags: "self",
    help: MARK_READ_HELP,
    handler: chatMarkReadCommand,
  },
  {
    name: "mark-unread",
    mutation: true,
    flags: "self",
    help: MARK_UNREAD_HELP,
    handler: chatMarkUnreadCommand,
  },
];

const SUB_BY_NAME: Record<string, ChatSubcommand> = Object.fromEntries(
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

export const CHAT_HELP = `usage: gws-axi chat <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Conversations are addressed by id (from \`chat spaces\`), or by
  \`--with <email>\` for a 1:1 direct message — never by name.
  Reading never changes what is marked read.
  Writes require --account <email> when 2+ accounts are authenticated
  (or set GWS_AXI_ACCOUNT).
  \`chat send\` SENDS — there is no draft step, and gws-axi can't delete
  what it posts. It goes to one conversation per command.
${renderAlternatives(SUBCOMMANDS)}subcommand help:
  gws-axi chat spaces --help       list and find conversations
  gws-axi chat messages --help     read one conversation
  gws-axi chat search --help       search messages across conversations
  gws-axi chat members --help      who is in a conversation
  gws-axi chat download --help     save a message's attachments
  gws-axi chat wait --help         block until a new message arrives
  gws-axi chat watch --help        stream new messages, one line each
  gws-axi chat send --help         post a message
  gws-axi chat react --help        add an emoji reaction (unreact removes it)
  gws-axi chat mark-read --help    mark conversations read
  gws-axi chat mark-unread --help  mark a conversation unread from a point
examples:
  gws-axi chat spaces
  gws-axi chat send AAAAxyz --text "@bob@example.com the feed is back up" --account you@example.com
  gws-axi chat messages AAAAxyz --since today
  gws-axi chat messages --with bob@example.com
  gws-axi chat search budget --since -7d
  gws-axi chat members AAAAxyz
`;

export async function chatCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return CHAT_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown chat subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi chat --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.handler ? def.help : withInstead(def.help, def.instead);
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  if (def.handler && def.flags && def.flags !== "self") {
    checkFlags(remaining, def.flags, `chat ${sub}`);
  }
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `chat ${sub}`,
  });

  if (!def.handler) {
    throw notImplemented("chat", sub, resolution.account, def.instead);
  }

  if (def.streams) {
    return def.handler(resolution.account, remaining, accountSourceLabel(resolution));
  }
  return withAccountSource(resolution, await def.handler(resolution.account, remaining));
}
