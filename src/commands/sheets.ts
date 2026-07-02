import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { docsCommentsCommand } from "./docs/comments.js";
import { READ_HELP, sheetsReadCommand } from "./sheets/read.js";

// Google Sheets comments are Drive comments — the exact same file-agnostic API
// `docs comments` uses. Alias the handler (cf. `docs revisions` → `drive
// revisions`) and give it a Sheets-worded help block.
const COMMENTS_HELP = `usage: gws-axi sheets comments <spreadsheetId> [--include-resolved] [flags]
args[1]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
flags[2]:
  --include-resolved   Include resolved comment threads (hidden by default)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi sheets comments 1AbC...
output:
  A \`comments[N]{id,author,created,resolved,quoted_content,body,reply_count}\`
  table plus a \`replies[N]{comment,author,created,body}\` block.
notes:
  Sheets comments are Drive comments (file-type-agnostic); this is the same
  data as \`gws-axi docs comments\`. Cell *notes* are distinct — those come
  back in the notes[] block of \`gws-axi sheets read\`.
`;

interface SheetsSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

// Write subcommands are stubs for the next slice — kept with per-command --help
// so agents can plan around the future surface. They throw NOT_IMPLEMENTED after
// account resolution runs.
const UPDATE_HELP = `usage: gws-axi sheets update <spreadsheetId> --tab <name> --range <A1> --values <json|csv> [flags]
status: planned for writes — not yet implemented
notes:
  Will wrap spreadsheets.values.update. Requires --account <email> when 2+
  accounts are authenticated.
`;
const APPEND_HELP = `usage: gws-axi sheets append <spreadsheetId> --tab <name> --values <json|csv> [flags]
status: planned for writes — not yet implemented
notes:
  Will wrap spreadsheets.values.append (adds rows after the used range).
`;
const CLEAR_HELP = `usage: gws-axi sheets clear <spreadsheetId> --tab <name> --range <A1> [flags]
status: planned for writes — not yet implemented
`;
const CREATE_HELP = `usage: gws-axi sheets create --title <text> [--tab <name>...] [flags]
status: planned for writes — not yet implemented
notes:
  Will wrap spreadsheets.create. Produces the spreadsheetId that
  \`sheets read\` / \`sheets update\` consume.
`;
const ADD_TAB_HELP = `usage: gws-axi sheets add-tab <spreadsheetId> --title <text> [flags]
status: planned for writes — not yet implemented
notes:
  Will wrap spreadsheets.batchUpdate addSheet.
`;

const sheetsCommentsCommand = (account: string, args: string[]): Promise<string> =>
  docsCommentsCommand(account, args, {
    resource: "spreadsheet",
    notFoundCode: "SPREADSHEET_NOT_FOUND",
  });

const SUBCOMMANDS: SheetsSubcommand[] = [
  { name: "read", mutation: false, help: READ_HELP, handler: sheetsReadCommand },
  { name: "comments", mutation: false, help: COMMENTS_HELP, handler: sheetsCommentsCommand },
  { name: "update", mutation: true, help: UPDATE_HELP },
  { name: "append", mutation: true, help: APPEND_HELP },
  { name: "clear", mutation: true, help: CLEAR_HELP },
  { name: "create", mutation: true, help: CREATE_HELP },
  { name: "add-tab", mutation: true, help: ADD_TAB_HELP },
];

const SUB_BY_NAME: Record<string, SheetsSubcommand> = Object.fromEntries(
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

export const SHEETS_HELP = `usage: gws-axi sheets <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
  Write subcommands are scaffolded for the next slice — all currently
  throw NOT_IMPLEMENTED after account resolution runs.
subcommand help:
  gws-axi sheets read --help       for spreadsheetId + tab/range handling
  gws-axi sheets comments --help   for review comments (Drive comments)
examples:
  gws-axi sheets read 1AbC...
  gws-axi sheets read 1AbC... --tab Costs --range A1:D50
  gws-axi sheets read 1AbC... --tab Costs --header-row
  gws-axi sheets comments 1AbC...
`;

export async function sheetsCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return SHEETS_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown sheets subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi sheets --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `sheets ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(`gws-axi sheets ${sub} is not yet implemented`, "NOT_IMPLEMENTED", [
      `Account resolution succeeded: would run as ${resolution.account}`,
      `See \`gws-axi sheets ${sub} --help\` for the planned surface`,
    ]);
  }

  return def.handler(resolution.account, remaining);
}
