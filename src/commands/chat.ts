import { AxiError } from "axi-sdk-js";
import { resolveAccount, withAccountSource } from "../google/account.js";
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
import { chatSpacesCommand, SPACES_HELP } from "./chat/spaces.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";

interface ChatSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
  instead?: string[];
}

const SUBCOMMANDS: ChatSubcommand[] = [
  { name: "spaces", mutation: false, help: SPACES_HELP, handler: chatSpacesCommand },
  { name: "messages", mutation: false, help: MESSAGES_HELP, handler: chatMessagesCommand },
  { name: "search", mutation: false, help: SEARCH_HELP, handler: chatSearchCommand },
  { name: "members", mutation: false, help: MEMBERS_HELP, handler: chatMembersCommand },
  { name: "download", mutation: false, help: DOWNLOAD_HELP, handler: chatDownloadCommand },
  { name: "send", mutation: true, help: SEND_HELP, handler: chatSendCommand },
  { name: "react", mutation: true, help: REACT_HELP, handler: chatReactCommand },
  { name: "unreact", mutation: true, help: UNREACT_HELP, handler: chatUnreactCommand },
  { name: "mark-read", mutation: true, help: MARK_READ_HELP, handler: chatMarkReadCommand },
  {
    name: "mark-unread",
    mutation: true,
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
  gws-axi chat send --help         post a message
  gws-axi chat react --help        add an emoji reaction (unreact removes it)
  gws-axi chat mark-read --help    mark conversations read
  gws-axi chat mark-unread --help  mark a conversation unread from a point
examples:
  gws-axi chat spaces
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
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `chat ${sub}`,
  });

  if (!def.handler) {
    throw notImplemented("chat", sub, resolution.account, def.instead);
  }

  return withAccountSource(resolution, await def.handler(resolution.account, remaining));
}
