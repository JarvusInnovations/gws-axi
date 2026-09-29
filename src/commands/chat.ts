import { AxiError } from "axi-sdk-js";
import { resolveAccount, withAccountSource } from "../google/account.js";
import { chatMembersCommand, MEMBERS_HELP } from "./chat/members.js";
import { chatMessagesCommand, MESSAGES_HELP } from "./chat/messages.js";
import { chatSearchCommand, SEARCH_HELP } from "./chat/search.js";
import { chatSpacesCommand, SPACES_HELP } from "./chat/spaces.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";

interface ChatSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
  instead?: string[];
}

// Write subcommands are stubs for the next slice — kept with per-command --help
// so agents can plan around the surface. They throw NOT_IMPLEMENTED after
// account resolution runs. None has an alternative: nothing else in gws-axi
// posts to Chat or changes what is marked read.
const SEND_HELP = `usage: gws-axi chat send <space> (--text <string> | --body-file <path> | -) [--thread <id>] [--request-id <key>] [flags]
status: planned — not yet implemented
`;
const MARK_READ_HELP = `usage: gws-axi chat mark-read <space> [<space>…] [flags]
status: planned — not yet implemented
`;
const MARK_UNREAD_HELP = `usage: gws-axi chat mark-unread <space> (--from <messageId> | --at <time>) [flags]
status: planned — not yet implemented
`;

const SUBCOMMANDS: ChatSubcommand[] = [
  { name: "spaces", mutation: false, help: SPACES_HELP, handler: chatSpacesCommand },
  { name: "messages", mutation: false, help: MESSAGES_HELP, handler: chatMessagesCommand },
  { name: "search", mutation: false, help: SEARCH_HELP, handler: chatSearchCommand },
  { name: "members", mutation: false, help: MEMBERS_HELP, handler: chatMembersCommand },
  { name: "send", mutation: true, help: SEND_HELP },
  { name: "mark-read", mutation: true, help: MARK_READ_HELP },
  { name: "mark-unread", mutation: true, help: MARK_UNREAD_HELP },
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
  Writes require --account <email> when 2+ accounts are authenticated.
  Write subcommands are scaffolded for the next slice — all currently
  throw NOT_IMPLEMENTED after account resolution runs, and nothing else
  in gws-axi posts to Chat or changes read state.
${renderAlternatives(SUBCOMMANDS)}subcommand help:
  gws-axi chat spaces --help       list and find conversations
  gws-axi chat messages --help     read one conversation
  gws-axi chat search --help       search messages across conversations
  gws-axi chat members --help      who is in a conversation
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
