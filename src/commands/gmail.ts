import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { gmailBatchModifyCommand, BATCH_MODIFY_HELP } from "./gmail/batch-modify.js";
import { gmailDownloadCommand, DOWNLOAD_HELP } from "./gmail/download.js";
import { gmailDraftCommand, DRAFT_HELP, SEND_HELP } from "./gmail/draft.js";
import {
  gmailFilterCreateCommand,
  gmailFilterDeleteCommand,
  gmailFilterListCommand,
  FILTER_CREATE_HELP,
  FILTER_DELETE_HELP,
  FILTER_LIST_HELP,
} from "./gmail/filters.js";
import {
  gmailLabelCreateCommand,
  gmailLabelDeleteCommand,
  gmailLabelUpdateCommand,
  LABEL_CREATE_HELP,
  LABEL_DELETE_HELP,
  LABEL_UPDATE_HELP,
} from "./gmail/label-ops.js";
import { gmailLabelsCommand, LABELS_HELP } from "./gmail/labels.js";
import { gmailModifyCommand, MODIFY_HELP } from "./gmail/modify.js";
import { gmailReadCommand, READ_HELP } from "./gmail/read.js";
import { gmailSearchCommand, SEARCH_HELP } from "./gmail/search.js";

interface GmailSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

const SUBCOMMANDS: GmailSubcommand[] = [
  { name: "search", mutation: false, help: SEARCH_HELP, handler: gmailSearchCommand },
  { name: "read", mutation: false, help: READ_HELP, handler: gmailReadCommand },
  { name: "labels", mutation: false, help: LABELS_HELP, handler: gmailLabelsCommand },
  { name: "download", mutation: false, help: DOWNLOAD_HELP, handler: gmailDownloadCommand },
  { name: "filter-list", mutation: false, help: FILTER_LIST_HELP, handler: gmailFilterListCommand },
  // `send` is deliberately unsupported — gmailCommand short-circuits it with
  // a NOT_SUPPORTED redirect to `draft` before account resolution.
  { name: "send", mutation: true, help: SEND_HELP },
  { name: "draft", mutation: true, help: DRAFT_HELP, handler: gmailDraftCommand },
  { name: "modify", mutation: true, help: MODIFY_HELP, handler: gmailModifyCommand },
  {
    name: "batch-modify",
    mutation: true,
    help: BATCH_MODIFY_HELP,
    handler: gmailBatchModifyCommand,
  },
  {
    name: "label-create",
    mutation: true,
    help: LABEL_CREATE_HELP,
    handler: gmailLabelCreateCommand,
  },
  {
    name: "label-update",
    mutation: true,
    help: LABEL_UPDATE_HELP,
    handler: gmailLabelUpdateCommand,
  },
  {
    name: "label-delete",
    mutation: true,
    help: LABEL_DELETE_HELP,
    handler: gmailLabelDeleteCommand,
  },
  {
    name: "filter-create",
    mutation: true,
    help: FILTER_CREATE_HELP,
    handler: gmailFilterCreateCommand,
  },
  {
    name: "filter-delete",
    mutation: true,
    help: FILTER_DELETE_HELP,
    handler: gmailFilterDeleteCommand,
  },
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
  \`send\` is intentionally NOT supported — gws-axi drafts mail for human
  review but never sends. Use \`draft\` then send from the Gmail UI.
  Filter commands need the gmail.settings.basic scope; if they 403, re-run
  \`gws-axi auth login --account <email>\` to re-consent.
subcommand help:
  gws-axi gmail search --help        for query syntax + inbox-default behavior
  gws-axi gmail read --help          for thread rendering + smart id resolution
  gws-axi gmail labels --help        for label types + counts
  gws-axi gmail modify --help        for archive/read/star/label triage recipes
  gws-axi gmail batch-modify --help  for query-driven bulk label changes
  gws-axi gmail draft --help         for composing reviewable drafts
  gws-axi gmail filter-create --help for server-side auto-sort rules
examples:
  gws-axi gmail search --query "from:boss@company.com is:unread"
  gws-axi gmail modify 1a2b3c4d --remove-label INBOX        # archive
  gws-axi gmail batch-modify --query "from:news@x.com" --remove-label INBOX
  gws-axi gmail draft --to alice@x.com --subject "Re: budget" --body "Approved."
  gws-axi gmail label-create --name Receipts
`;

export async function gmailCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return GMAIL_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown gmail subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi gmail --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  // `send` is unsupported by design — short-circuit before account
  // resolution so the redirect surfaces without demanding --account.
  if (sub === "send") {
    throw new AxiError(
      "gws-axi does not send mail — sending is intentionally out of scope",
      "NOT_SUPPORTED",
      [
        "Compose a draft instead with `gws-axi gmail draft --to <emails> --subject <text> --body <text>`",
        "Then review and send the draft yourself from the Gmail UI",
      ],
    );
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `gmail ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(`gws-axi gmail ${sub} is not yet implemented`, "NOT_IMPLEMENTED", [
      `Account resolution succeeded: would run as ${resolution.account}`,
      `See \`gws-axi gmail ${sub} --help\` for the planned surface`,
    ]);
  }

  return def.handler(resolution.account, remaining);
}
