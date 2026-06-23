import { AxiError } from "axi-sdk-js";
import { resolveAccount } from "../google/account.js";
import { docsDownloadCommand } from "./docs/download.js";
import { driveGetCommand, GET_HELP } from "./drive/get.js";
import { driveLsCommand, LS_HELP } from "./drive/ls.js";
import {
  drivePermissionsCommand,
  PERMISSIONS_HELP,
} from "./drive/permissions.js";
import { driveActivityCommand, ACTIVITY_HELP } from "./drive/activity.js";
import {
  driveRevisionsCommand,
  REVISIONS_HELP,
} from "./drive/revisions.js";
import { driveSearchCommand, SEARCH_HELP } from "./drive/search.js";
import { driveUploadCommand, UPLOAD_HELP } from "./drive/upload.js";

interface DriveSubcommand {
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
}

// Drive `download` shares the docs/download.ts implementation — same code
// path handles native Google file export + uploaded-file media fetch.
const DOWNLOAD_HELP = `usage: gws-axi drive download <file-id> [flags]
args[1]:
  <file-id>            The Drive file ID
flags[4]:
  --out <path>         Where to save (default: ./<sanitized file name>)
  --as <mime>          Export format for native Google files (only valid
                       for Docs/Sheets/Slides/Drawings). Defaults: .docx
                       / .xlsx / .pptx / .png; text/markdown when --revision
                       is set.
  --revision <id>      Download a specific historical revision (id from
                       \`gws-axi drive revisions <id>\`) instead of the head.
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive download 1AbC...
  gws-axi drive download 1AbC... --out ./report.pdf --as application/pdf
  gws-axi drive download 1AbC... --revision 250
notes:
  This is an alias for \`gws-axi docs download\` — same implementation,
  same behavior. Either spelling works.
`;

// Write subcommands are still stubbed but each carries its planned --help.
const CREATE_HELP = `usage: gws-axi drive create --name <name> --parent <folder-id> [--mime <type>] [flags]
status: planned for v1 writes — not yet implemented
`;
const COPY_HELP = `usage: gws-axi drive copy <file-id> --parent <folder-id> [--name <name>] [flags]
status: planned for v1 writes — not yet implemented
`;
const MOVE_HELP = `usage: gws-axi drive move <file-id> --parent <folder-id> [flags]
status: planned for v1 writes — not yet implemented
`;
const RENAME_HELP = `usage: gws-axi drive rename <file-id> --name <new-name> [flags]
status: planned for v1 writes — not yet implemented
`;
const DELETE_HELP = `usage: gws-axi drive delete <file-id> [flags]
status: planned for v1 writes — not yet implemented
`;
const MKDIR_HELP = `usage: gws-axi drive mkdir --name <name> --parent <folder-id> [flags]
status: planned for v1 writes — not yet implemented
`;

const SUBCOMMANDS: DriveSubcommand[] = [
  { name: "search", mutation: false, help: SEARCH_HELP, handler: driveSearchCommand },
  { name: "get", mutation: false, help: GET_HELP, handler: driveGetCommand },
  { name: "ls", mutation: false, help: LS_HELP, handler: driveLsCommand },
  {
    name: "permissions",
    mutation: false,
    help: PERMISSIONS_HELP,
    handler: drivePermissionsCommand,
  },
  {
    name: "download",
    mutation: false,
    help: DOWNLOAD_HELP,
    // Delegates to docs/download.ts — same impl handles any Drive file.
    handler: docsDownloadCommand,
  },
  {
    name: "revisions",
    mutation: false,
    help: REVISIONS_HELP,
    handler: driveRevisionsCommand,
  },
  {
    name: "activity",
    mutation: false,
    help: ACTIVITY_HELP,
    handler: driveActivityCommand,
  },
  {
    name: "upload",
    mutation: true,
    help: UPLOAD_HELP,
    handler: driveUploadCommand,
  },
  { name: "create", mutation: true, help: CREATE_HELP },
  { name: "copy", mutation: true, help: COPY_HELP },
  { name: "move", mutation: true, help: MOVE_HELP },
  { name: "rename", mutation: true, help: RENAME_HELP },
  { name: "delete", mutation: true, help: DELETE_HELP },
  { name: "mkdir", mutation: true, help: MKDIR_HELP },
];

const SUB_BY_NAME: Record<string, DriveSubcommand> = Object.fromEntries(
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

export const DRIVE_HELP = `usage: gws-axi drive <subcommand> [args] [--account <email>] [flags]
reads[${reads.length}]:
  ${reads.join(", ")}
writes[${writes.length}]:
  ${writes.join(", ")}
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
  upload is live; the remaining write subcommands are scaffolded for the
  next slice and throw NOT_IMPLEMENTED after account resolution runs.
subcommand help:
  gws-axi drive ls --help            for folder listing (incl. --recursive)
  gws-axi drive get --help           for full file metadata
  gws-axi drive search --help        for full-text search
  gws-axi drive permissions --help   for access / sharing
  gws-axi drive download --help      for fetching bytes (alias of docs download)
  gws-axi drive upload --help        for uploading a local file (incl. --convert)
examples:
  gws-axi drive ls
  gws-axi drive ls <folder-id> --recursive
  gws-axi drive search --query "project plan"
  gws-axi drive get <file-id>
  gws-axi drive permissions <file-id>
  gws-axi drive upload ./report.pdf --account you@example.com
`;

export async function driveCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return DRIVE_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(
      `Unknown drive subcommand: ${sub}`,
      "VALIDATION_ERROR",
      [`Run \`gws-axi drive --help\` to see available subcommands`],
    );
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.help;
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `drive ${sub}`,
  });

  if (!def.handler) {
    throw new AxiError(
      `gws-axi drive ${sub} is not yet implemented`,
      "NOT_IMPLEMENTED",
      [
        `Account resolution succeeded: would run as ${resolution.account}`,
        `See \`gws-axi drive ${sub} --help\` for the planned surface`,
      ],
    );
  }

  return def.handler(resolution.account, remaining);
}
