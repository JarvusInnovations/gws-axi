import { checkFlags, type FlagSpec } from "../util/flags.js";
import { AxiError } from "axi-sdk-js";
import { resolveAccount, withAccountSource } from "../google/account.js";
import { docsCommentsCommand } from "./docs/comments.js";
import { ADD_TAB_FLAGS, ADD_TAB_HELP, sheetsAddTabCommand } from "./sheets/add-tab.js";
import { CELL_FLAGS, CELL_HELP, sheetsCellCommand } from "./sheets/cell.js";
import { CREATE_FLAGS, CREATE_HELP, sheetsCreateCommand } from "./sheets/create.js";
import { NOTE_FLAGS, NOTE_HELP, sheetsNoteCommand } from "./sheets/note.js";
import { READ_HELP, sheetsReadCommand } from "./sheets/read.js";
import {
  APPEND_FLAGS,
  APPEND_HELP,
  CLEAR_FLAGS,
  CLEAR_HELP,
  UPDATE_FLAGS,
  UPDATE_HELP,
  sheetsAppendCommand,
  sheetsClearCommand,
  sheetsUpdateCommand,
} from "./sheets/write.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";

// Google Sheets comments are Drive comments — the exact same file-agnostic API
// `docs comments` uses. Alias the handler (cf. `docs revisions` → `drive
// revisions`) and give it a Sheets-worded help block.
const COMMENTS_HELP = `usage: gws-axi sheets comments <spreadsheetId> [--include-resolved] [flags]
args[1]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
flags[4]:
  --include-resolved   Include resolved comment threads (hidden by default)
  --full               Don't truncate comment/reply bodies (default cap: 500 chars)
  --limit <n>          Max comments to return (default: 50)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi sheets comments 1AbC...
output:
  A \`comments[N]{id,author,created,resolved,quoted_content,body,reply_count}\`
  table plus a \`replies[N]{comment,author,created,body}\` block.
notes:
  Sheets comments are Drive comments (file-type-agnostic); this is the same
  data as \`gws-axi docs comments\`. Cell *notes* are distinct — those come
  back in the notes[] block of \`gws-axi sheets read\` and are set with
  \`gws-axi sheets note\`.
`;

interface SheetsSubcommand {
  /** Flags this subcommand takes — or "self" when its own parser validates them. */
  flags?: FlagSpec | "self";
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
  instead?: string[];
}

const sheetsCommentsCommand = (account: string, args: string[]): Promise<string> =>
  docsCommentsCommand(account, args, {
    resource: "spreadsheet",
    notFoundCode: "SPREADSHEET_NOT_FOUND",
  });

export const SUBCOMMANDS: SheetsSubcommand[] = [
  { name: "read", mutation: false, flags: "self", help: READ_HELP, handler: sheetsReadCommand },
  {
    name: "comments",
    mutation: false,
    flags: { value: ["--limit"], boolean: ["--include-resolved", "--full"] },
    help: COMMENTS_HELP,
    handler: sheetsCommentsCommand,
  },
  { name: "cell", mutation: false, flags: CELL_FLAGS, help: CELL_HELP, handler: sheetsCellCommand },
  {
    name: "update",
    mutation: true,
    flags: UPDATE_FLAGS,
    help: UPDATE_HELP,
    handler: sheetsUpdateCommand,
  },
  {
    name: "append",
    mutation: true,
    flags: APPEND_FLAGS,
    help: APPEND_HELP,
    handler: sheetsAppendCommand,
  },
  {
    name: "clear",
    mutation: true,
    flags: CLEAR_FLAGS,
    help: CLEAR_HELP,
    handler: sheetsClearCommand,
  },
  {
    name: "create",
    mutation: true,
    flags: CREATE_FLAGS,
    help: CREATE_HELP,
    handler: sheetsCreateCommand,
  },
  {
    name: "add-tab",
    mutation: true,
    flags: ADD_TAB_FLAGS,
    help: ADD_TAB_HELP,
    handler: sheetsAddTabCommand,
  },
  {
    name: "note",
    mutation: true,
    flags: NOTE_FLAGS,
    help: NOTE_HELP,
    handler: sheetsNoteCommand,
  },
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
  Writes put values into one tab and touch nothing else (formats, widths,
  validation, other tabs). Each reads back what Sheets made of the values and
  reports any formula errors it left in the tab.
${renderAlternatives(SUBCOMMANDS)}subcommand help:
  gws-axi sheets read --help       for spreadsheetId + tab/range handling
  gws-axi sheets cell --help       for one cell: its formula and what it reads
  gws-axi sheets update --help     for writing a block, or single cells
  gws-axi sheets append --help     for adding rows (CSV, JSON, header-keyed)
  gws-axi sheets comments --help   for review comments (Drive comments)
  gws-axi sheets note --help       for setting or clearing one cell's note
examples:
  gws-axi sheets read 1AbC...
  gws-axi sheets read 1AbC... --tab Costs --range A1:D50
  gws-axi sheets cell 1AbC... D2 --tab Costs
  gws-axi sheets update 1AbC... --tab Costs --range B2 costs.csv --account you@example.com
  gws-axi sheets append 1AbC... --tab Costs --content 'bolts,40' --account you@example.com
  gws-axi sheets create --title "Q4 Tracker" costs.csv --header --account you@example.com
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
    return def.handler ? def.help : withInstead(def.help, def.instead);
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  if (def.handler && def.flags && def.flags !== "self") {
    checkFlags(remaining, def.flags, `sheets ${sub}`);
  }
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `sheets ${sub}`,
  });

  if (!def.handler) {
    throw notImplemented("sheets", sub, resolution.account, def.instead);
  }

  return withAccountSource(resolution, await def.handler(resolution.account, remaining));
}
