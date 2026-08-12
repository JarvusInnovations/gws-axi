import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";
import { docsCommentsCommand, COMMENTS_HELP } from "./docs/comments.js";
import { docsDiffCommand, DIFF_HELP } from "./docs/diff.js";
import { docsDownloadCommand, DOWNLOAD_HELP } from "./docs/download.js";
import { docsFindCommand, FIND_HELP } from "./docs/find.js";
import { docsReadCommand, READ_HELP } from "./docs/read.js";
import { driveRevisionsCommand, REVISIONS_HELP } from "./drive/revisions.js";

interface DocsSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
  instead?: string[];
}

// Granular Docs edits need documents.batchUpdate, which isn't wired yet. The
// download → edit → upload round trip is the shipped substitute, and it
// replaces the whole document — so the lines say that rather than implying a
// targeted edit.
const ROUND_TRIP = [
  "gws-axi docs download <documentId> --out ./doc.md — export the current content to edit locally",
  "gws-axi drive upload ./doc.md --update <documentId> --convert --account <email> — write it back as a NEW REVISION, replacing the ENTIRE document",
  "Multi-tab Docs are refused with MULTI_TAB_TARGET unless --replace-all-tabs; `gws-axi docs diff <documentId> <revA>` compares revisions afterward",
];

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
  { name: "download", mutation: false, help: DOWNLOAD_HELP, handler: docsDownloadCommand },
  // Alias for `drive revisions` — version history is a Docs-shaped mental
  // model, but the implementation is Drive-wide (any file type).
  { name: "revisions", mutation: false, help: REVISIONS_HELP, handler: driveRevisionsCommand },
  { name: "diff", mutation: false, help: DIFF_HELP, handler: docsDiffCommand },
  { name: "append", mutation: true, help: APPEND_HELP, instead: ROUND_TRIP },
  { name: "insert-text", mutation: true, help: INSERT_TEXT_HELP, instead: ROUND_TRIP },
  { name: "delete-range", mutation: true, help: DELETE_RANGE_HELP, instead: ROUND_TRIP },
  { name: "style-text", mutation: true, help: STYLE_TEXT_HELP, instead: ROUND_TRIP },
  { name: "style-paragraph", mutation: true, help: STYLE_PARAGRAPH_HELP, instead: ROUND_TRIP },
  { name: "insert-table", mutation: true, help: INSERT_TABLE_HELP, instead: ROUND_TRIP },
  { name: "edit-cell", mutation: true, help: EDIT_CELL_HELP, instead: ROUND_TRIP },
  // Comment writes need the Drive comments API, which no shipped command
  // touches — the round trip below rewrites body content only.
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
${renderAlternatives(SUBCOMMANDS)}subcommand help:
  gws-axi docs read --help        for documentId + tab handling
  gws-axi docs find --help        for text-match search
  gws-axi docs comments --help    for review comments + replies
  gws-axi docs download --help    for native-file export / raw download
  gws-axi docs diff --help        for comparing two revisions
examples:
  gws-axi docs read 1BxAbc...
  gws-axi docs read 1BxAbc... --tab t.0 --full
  gws-axi docs find 1BxAbc... --query "sprint goal"
  gws-axi docs comments 1BxAbc...
  gws-axi docs download 1BxAbc... --out ./spec.docx
  gws-axi docs diff 1BxAbc... 841 865
`;

export async function docsCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return DOCS_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown docs subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi docs --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.handler ? def.help : withInstead(def.help, def.instead);
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `docs ${sub}`,
  });

  if (!def.handler) {
    throw notImplemented("docs", sub, resolution.account, def.instead);
  }

  return def.handler(resolution.account, remaining);
}
