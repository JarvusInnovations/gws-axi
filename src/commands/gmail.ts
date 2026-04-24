import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { gmailDownloadCommand, DOWNLOAD_HELP } from "./gmail/download.js";
import { gmailLabelsCommand, LABELS_HELP } from "./gmail/labels.js";
import { gmailReadCommand, READ_HELP } from "./gmail/read.js";
import { gmailSearchCommand, SEARCH_HELP } from "./gmail/search.js";

interface GmailSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

// Write subcommands still stubbed — per-command help describes the planned
// surface so agents can plan against it.
const FILTER_LIST_HELP = `usage: gws-axi gmail filter-list [flags]
status: planned — not yet implemented
notes:
  Will list Gmail server-side filters (auto-sort rules). Separate from
  user labels (\`gws-axi gmail labels\`).
`;
const SEND_HELP = `usage: gws-axi gmail send --to <email> --subject <text> --body <markdown> [flags]
status: planned for v1 writes — not yet implemented
`;
const DRAFT_HELP = `usage: gws-axi gmail draft --to <email> --subject <text> --body <markdown> [flags]
status: planned for v1 writes — not yet implemented
`;
const MODIFY_HELP = `usage: gws-axi gmail modify <message-id> [--add-label <name>...] [--remove-label <name>...] [flags]
status: planned for v1 writes — not yet implemented
`;
const BATCH_MODIFY_HELP = `usage: gws-axi gmail batch-modify --query <text> [--add-label <name>...] [--remove-label <name>...] [flags]
status: planned for v1 writes — not yet implemented
`;
const LABEL_CREATE_HELP = `usage: gws-axi gmail label-create --name <text> [flags]
status: planned for v1 writes — not yet implemented
`;
const LABEL_UPDATE_HELP = `usage: gws-axi gmail label-update <label-id> --name <text> [flags]
status: planned for v1 writes — not yet implemented
`;
const LABEL_DELETE_HELP = `usage: gws-axi gmail label-delete <label-id> [flags]
status: planned for v1 writes — not yet implemented
`;
const FILTER_CREATE_HELP = `usage: gws-axi gmail filter-create --criteria <json> --action <json> [flags]
status: planned for v1 writes — not yet implemented
`;
const FILTER_DELETE_HELP = `usage: gws-axi gmail filter-delete <filter-id> [flags]
status: planned for v1 writes — not yet implemented
`;

const SUBCOMMANDS: GmailSubcommand[] = [
  { name: "search", mutation: false, help: SEARCH_HELP, handler: gmailSearchCommand },
  { name: "read", mutation: false, help: READ_HELP, handler: gmailReadCommand },
  { name: "labels", mutation: false, help: LABELS_HELP, handler: gmailLabelsCommand },
  { name: "download", mutation: false, help: DOWNLOAD_HELP, handler: gmailDownloadCommand },
  { name: "filter-list", mutation: false, help: FILTER_LIST_HELP },
  { name: "send", mutation: true, help: SEND_HELP },
  { name: "draft", mutation: true, help: DRAFT_HELP },
  { name: "modify", mutation: true, help: MODIFY_HELP },
  { name: "batch-modify", mutation: true, help: BATCH_MODIFY_HELP },
  { name: "label-create", mutation: true, help: LABEL_CREATE_HELP },
  { name: "label-update", mutation: true, help: LABEL_UPDATE_HELP },
  { name: "label-delete", mutation: true, help: LABEL_DELETE_HELP },
  { name: "filter-create", mutation: true, help: FILTER_CREATE_HELP },
  { name: "filter-delete", mutation: true, help: FILTER_DELETE_HELP },
];

const SUB_BY_NAME: Record<string, GmailSubcommand> = Object.fromEntries(
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

export const GMAIL_HELP = `usage: gws-axi gmail <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
  Write subcommands (and filter-list) are scaffolded for the next slice;
  they throw NOT_IMPLEMENTED after account resolution runs.
subcommand help:
  gws-axi gmail search --help      for query syntax + inbox-default behavior
  gws-axi gmail read --help        for thread rendering + smart id resolution
  gws-axi gmail labels --help      for label types + counts
  gws-axi gmail download --help    for attachment fetching
examples:
  gws-axi gmail search
  gws-axi gmail search --query "from:boss@company.com is:unread"
  gws-axi gmail read 1a2b3c4d5e6f7890
  gws-axi gmail labels
`;

export async function gmailCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return GMAIL_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(
      `Unknown gmail subcommand: ${sub}`,
      "VALIDATION_ERROR",
      [`Run \`gws-axi gmail --help\` to see available subcommands`],
    );
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `gmail ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(
      `gws-axi gmail ${sub} is not yet implemented`,
      "NOT_IMPLEMENTED",
      [
        `Account resolution succeeded: would run as ${resolution.account}`,
        `See \`gws-axi gmail ${sub} --help\` for the planned surface`,
      ],
    );
  }

  return def.handler(resolution.account, remaining);
}
