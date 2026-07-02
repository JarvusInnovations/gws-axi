import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { docsCommentsCommand } from "./docs/comments.js";
import { GET_HELP, slidesGetCommand } from "./slides/get.js";
import { PAGE_HELP, slidesPageCommand } from "./slides/page.js";
import { SUMMARIZE_HELP, slidesSummarizeCommand } from "./slides/summarize.js";

// Slides comments are Drive comments — the same file-agnostic API `docs
// comments` / `sheets comments` use. Alias the shared handler with a
// presentation-worded resource label + not-found code.
const COMMENTS_HELP = `usage: gws-axi slides comments <presentation-id> [--include-resolved] [flags]
args[1]:
  <presentation-id>    The Slides presentation ID (the portion of the URL after /d/)
flags[2]:
  --include-resolved   Include resolved comment threads (hidden by default)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi slides comments 1AbC...
output:
  A \`comments[N]{id,author,created,resolved,quoted_content,body,reply_count}\`
  table plus a \`replies[N]{comment,author,created,body}\` block.
notes:
  Slides comments are Drive comments (file-type-agnostic); this is the same
  data as \`gws-axi docs comments\` / \`gws-axi sheets comments\`.
`;

const slidesCommentsCommand = (account: string, args: string[]): Promise<string> =>
  docsCommentsCommand(account, args, {
    resource: "presentation",
    notFoundCode: "PRESENTATION_NOT_FOUND",
  });

interface SlidesSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

const CREATE_HELP = `usage: gws-axi slides create --title <text> [--from <template-id>] [flags]
status: planned for v1 writes — not yet implemented
`;
const UPDATE_HELP = `usage: gws-axi slides update <presentation-id> --requests <json-file> [flags]
status: planned for v1 writes — not yet implemented
notes:
  Will wrap batchUpdate. Until implemented, programmatic edits require
  the raw Slides API or the Drive copy/edit flow.
`;

const SUBCOMMANDS: SlidesSubcommand[] = [
  { name: "get", mutation: false, help: GET_HELP, handler: slidesGetCommand },
  {
    name: "page",
    mutation: false,
    help: PAGE_HELP,
    handler: slidesPageCommand,
  },
  {
    name: "summarize",
    mutation: false,
    help: SUMMARIZE_HELP,
    handler: slidesSummarizeCommand,
  },
  { name: "comments", mutation: false, help: COMMENTS_HELP, handler: slidesCommentsCommand },
  { name: "create", mutation: true, help: CREATE_HELP },
  { name: "update", mutation: true, help: UPDATE_HELP },
];

const SUB_BY_NAME: Record<string, SlidesSubcommand> = Object.fromEntries(
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

export const SLIDES_HELP = `usage: gws-axi slides <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
  Write subcommands are scaffolded for the next slice; they throw
  NOT_IMPLEMENTED after account resolution runs.
subcommand help:
  gws-axi slides get --help        for metadata + slide list
  gws-axi slides page --help       for a single slide's content
  gws-axi slides summarize --help  for the whole deck as markdown
  gws-axi slides comments --help   for review comments (Drive comments)
examples:
  gws-axi slides get 1AbC...
  gws-axi slides summarize 1AbC...
  gws-axi slides page 1AbC... gd87cbcb3a4_0_42
  gws-axi slides comments 1AbC...
`;

export async function slidesCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return SLIDES_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown slides subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi slides --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `slides ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(`gws-axi slides ${sub} is not yet implemented`, "NOT_IMPLEMENTED", [
      `Account resolution succeeded: would run as ${resolution.account}`,
      `See \`gws-axi slides ${sub} --help\` for the planned surface`,
    ]);
  }

  return def.handler(resolution.account, remaining);
}
