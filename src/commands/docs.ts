import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { docsCommentsCommand, COMMENTS_HELP } from "./docs/comments.js";
import { docsFindCommand, FIND_HELP } from "./docs/find.js";
import { docsReadCommand, READ_HELP } from "./docs/read.js";

interface DocsSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

// Write subcommands are still stubs but we keep per-command --help text
// so agents can plan around the future surface.
const APPEND_HELP = `usage: gws-axi docs append <documentId> --text <markdown> [--tab <id>] [flags]
status: planned for v1 writes — not yet implemented
notes:
  Will append the given markdown to the end of the body. Requires
  --account <email> when 2+ accounts are authenticated.
`;
const INSERT_TEXT_HELP = `usage: gws-axi docs insert-text <documentId> --at <ref|index> --text <markdown> [flags]
status: planned for v1 writes — not yet implemented
notes:
  Will accept either a \`@N\` ref from \`docs find\` or a raw character
  index. Requires --account <email> when 2+ accounts are authenticated.
`;
const DELETE_RANGE_HELP = `usage: gws-axi docs delete-range <documentId> --start <index> --end <index> [flags]
status: planned for v1 writes — not yet implemented
`;
const STYLE_TEXT_HELP = `usage: gws-axi docs style-text <documentId> --start <index> --end <index> [--bold] [--italic] [...] [flags]
status: planned for v1 writes — not yet implemented
`;
const STYLE_PARAGRAPH_HELP = `usage: gws-axi docs style-paragraph <documentId> --start <index> --end <index> --style <type> [flags]
status: planned for v1 writes — not yet implemented
`;
const INSERT_TABLE_HELP = `usage: gws-axi docs insert-table <documentId> --at <index> --rows <n> --cols <n> [flags]
status: planned for v1 writes — not yet implemented
`;
const EDIT_CELL_HELP = `usage: gws-axi docs edit-cell <documentId> --table <index> --row <n> --col <n> --text <markdown> [flags]
status: planned for v1 writes — not yet implemented
`;
const COMMENT_ADD_HELP = `usage: gws-axi docs comment-add <documentId> --anchor <text> --body <text> [flags]
status: planned for v1 writes — not yet implemented
`;
const COMMENT_REPLY_HELP = `usage: gws-axi docs comment-reply <documentId> --comment <id> --body <text> [flags]
status: planned for v1 writes — not yet implemented
`;
const COMMENT_RESOLVE_HELP = `usage: gws-axi docs comment-resolve <documentId> --comment <id> [flags]
status: planned for v1 writes — not yet implemented
`;

const SUBCOMMANDS: DocsSubcommand[] = [
  { name: "read", mutation: false, help: READ_HELP, handler: docsReadCommand },
  { name: "find", mutation: false, help: FIND_HELP, handler: docsFindCommand },
  { name: "comments", mutation: false, help: COMMENTS_HELP, handler: docsCommentsCommand },
  { name: "append", mutation: true, help: APPEND_HELP },
  { name: "insert-text", mutation: true, help: INSERT_TEXT_HELP },
  { name: "delete-range", mutation: true, help: DELETE_RANGE_HELP },
  { name: "style-text", mutation: true, help: STYLE_TEXT_HELP },
  { name: "style-paragraph", mutation: true, help: STYLE_PARAGRAPH_HELP },
  { name: "insert-table", mutation: true, help: INSERT_TABLE_HELP },
  { name: "edit-cell", mutation: true, help: EDIT_CELL_HELP },
  { name: "comment-add", mutation: true, help: COMMENT_ADD_HELP },
  { name: "comment-reply", mutation: true, help: COMMENT_REPLY_HELP },
  { name: "comment-resolve", mutation: true, help: COMMENT_RESOLVE_HELP },
];

const SUB_BY_NAME: Record<string, DocsSubcommand> = Object.fromEntries(
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

export const DOCS_HELP = `usage: gws-axi docs <subcommand> [args] [--account <email>] [flags]
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
  gws-axi docs read --help        for documentId + tab handling
  gws-axi docs find --help        for text-match search
  gws-axi docs comments --help    for review comments + replies
examples:
  gws-axi docs read 1BxAbc...
  gws-axi docs read 1BxAbc... --tab t.0 --full
  gws-axi docs find 1BxAbc... --query "sprint goal"
  gws-axi docs comments 1BxAbc...
`;

export async function docsCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return DOCS_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(
      `Unknown docs subcommand: ${sub}`,
      "VALIDATION_ERROR",
      [`Run \`gws-axi docs --help\` to see available subcommands`],
    );
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `docs ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(
      `gws-axi docs ${sub} is not yet implemented`,
      "NOT_IMPLEMENTED",
      [
        `Account resolution succeeded: would run as ${resolution.account}`,
        `See \`gws-axi docs ${sub} --help\` for the planned surface`,
      ],
    );
  }

  return def.handler(resolution.account, remaining);
}
