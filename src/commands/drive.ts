import { checkFlags, type FlagSpec } from "../util/flags.js";
import { AxiError } from "axi-sdk-js";
import { driveRenameCommand, RENAME_HELP } from "./drive/rename.js";
import { driveShareCommand, driveUnshareCommand, SHARE_HELP, UNSHARE_HELP } from "./drive/share.js";
import { resolveAccount, withAccountSource } from "../google/account.js";
import { notImplemented, renderAlternatives, withInstead } from "./stub-signposts.js";
import { docsDownloadCommand } from "./docs/download.js";
import { driveGetCommand, GET_HELP } from "./drive/get.js";
import { driveLsCommand, LS_HELP } from "./drive/ls.js";
import { drivePermissionsCommand, PERMISSIONS_HELP } from "./drive/permissions.js";
import { driveActivityCommand, ACTIVITY_HELP } from "./drive/activity.js";
import { driveRevisionsCommand, REVISIONS_HELP } from "./drive/revisions.js";
import { driveSearchCommand, SEARCH_HELP } from "./drive/search.js";
import { driveUploadCommand, UPLOAD_HELP } from "./drive/upload.js";
import { driveMkdirCommand, MKDIR_HELP } from "./drive/mkdir.js";
import {
  MOVE_HELP,
  TRASH_HELP,
  UNTRASH_HELP,
  driveMoveCommand,
  driveTrashCommand,
  driveUntrashCommand,
} from "./drive/move.js";

interface DriveSubcommand {
  /** Flags this subcommand takes — or "self" when its own parser validates them. */
  flags?: FlagSpec | "self";
  name: string;
  mutation: boolean;
  help: string;
  handler?: (account: string, args: string[]) => Promise<string>;
  instead?: string[];
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
const DELETE_HELP = `usage: gws-axi drive delete <file-id> [flags]
status: not planned — gws-axi trashes rather than destroys
`;

export const SUBCOMMANDS: DriveSubcommand[] = [
  {
    name: "search",
    mutation: false,
    flags: { value: ["--query", "--mime", "--limit", "--page"], boolean: [] },
    help: SEARCH_HELP,
    handler: driveSearchCommand,
  },
  {
    name: "get",
    mutation: false,
    flags: { value: [], boolean: [] },
    help: GET_HELP,
    handler: driveGetCommand,
  },
  {
    name: "ls",
    mutation: false,
    flags: {
      value: ["--depth", "--limit", "--page"],
      boolean: ["--recursive", "--include-trashed"],
    },
    help: LS_HELP,
    handler: driveLsCommand,
  },
  {
    name: "permissions",
    mutation: false,
    flags: { value: [], boolean: [] },
    help: PERMISSIONS_HELP,
    handler: drivePermissionsCommand,
  },
  {
    name: "download",
    mutation: false,
    flags: { value: ["--out", "--as", "--revision"], boolean: [] },
    help: DOWNLOAD_HELP,
    // Delegates to docs/download.ts — same impl handles any Drive file.
    handler: docsDownloadCommand,
  },
  {
    name: "revisions",
    mutation: false,
    flags: { value: ["--limit"], boolean: ["--full"] },
    help: REVISIONS_HELP,
    handler: driveRevisionsCommand,
  },
  {
    name: "activity",
    mutation: false,
    flags: {
      value: ["--since", "--until", "--action", "--limit"],
      boolean: ["--folder", "--recursive"],
    },
    help: ACTIVITY_HELP,
    handler: driveActivityCommand,
  },
  {
    name: "upload",
    mutation: true,
    flags: {
      value: ["--content", "--parent", "--name", "--mime", "--update"],
      boolean: ["--convert", "--replace-all-tabs"],
    },
    help: UPLOAD_HELP,
    handler: driveUploadCommand,
  },
  {
    name: "create",
    mutation: true,
    help: CREATE_HELP,
    instead: [
      "gws-axi drive upload <path|-|--content <string>> --name <name> --account <email> — creates a file from content (add --convert for a native Doc/Sheet/Slides)",
      'gws-axi drive mkdir "<name>" --account <email> — creates a folder',
    ],
  },
  // copy has no shipped equivalent.
  { name: "copy", mutation: true, help: COPY_HELP },
  { name: "move", mutation: true, flags: "self", help: MOVE_HELP, handler: driveMoveCommand },
  { name: "trash", mutation: true, flags: "self", help: TRASH_HELP, handler: driveTrashCommand },
  {
    name: "untrash",
    mutation: true,
    flags: "self",
    help: UNTRASH_HELP,
    handler: driveUntrashCommand,
  },
  { name: "rename", mutation: true, flags: "self", help: RENAME_HELP, handler: driveRenameCommand },
  { name: "share", mutation: true, flags: "self", help: SHARE_HELP, handler: driveShareCommand },
  {
    name: "unshare",
    mutation: true,
    flags: "self",
    help: UNSHARE_HELP,
    handler: driveUnshareCommand,
  },
  {
    name: "delete",
    mutation: true,
    help: DELETE_HELP,
    instead: [
      "gws-axi drive trash <file-id> --account <email> — moves it to the trash, reversible with `drive untrash` for 30 days (there is no permanent delete)",
    ],
  },
  {
    name: "mkdir",
    mutation: true,
    flags: { value: ["--parent"], boolean: [] },
    help: MKDIR_HELP,
    handler: driveMkdirCommand,
  },
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
  upload, mkdir, rename, move, trash, untrash, share, and unshare are live; create
  and copy are scaffolded and throw NOT_IMPLEMENTED after account resolution;
  delete is not offered — trash instead.
  share never makes anything public or domain-wide.
${renderAlternatives(SUBCOMMANDS)}subcommand help:
  gws-axi drive ls --help            for folder listing (incl. --recursive)
  gws-axi drive get --help           for full file metadata
  gws-axi drive search --help        for full-text search
  gws-axi drive permissions --help   for access / sharing
  gws-axi drive download --help      for fetching bytes (alias of docs download)
  gws-axi drive upload --help        for uploading a local file (incl. --convert)
  gws-axi drive mkdir --help         for creating a folder
  gws-axi drive rename --help        for renaming a file or folder
  gws-axi drive move --help          for filing into another folder (trash/untrash too)
  gws-axi drive share --help         for giving named people access (unshare removes it)
examples:
  gws-axi drive ls
  gws-axi drive ls <folder-id> --recursive
  gws-axi drive search --query "project plan"
  gws-axi drive get <file-id>
  gws-axi drive permissions <file-id>
  gws-axi drive upload ./report.pdf --account you@example.com
  gws-axi drive mkdir "Q2 Reports" --account you@example.com
  gws-axi drive move <file-id> --to <folder-id> --account you@example.com
  gws-axi drive share <file-id> --with lead@school.org --role reader --account you@example.com
`;

export async function driveCommand(args: string[]): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return DRIVE_HELP;
  }

  const sub = args[0];
  const def = SUB_BY_NAME[sub];
  if (!def) {
    throw new AxiError(`Unknown drive subcommand: ${sub}`, "VALIDATION_ERROR", [
      `Run \`gws-axi drive --help\` to see available subcommands`,
    ]);
  }

  const rest = args.slice(1);
  if (rest.includes("--help")) {
    return def.handler ? def.help : withInstead(def.help, def.instead);
  }

  const { account: accountFlag, rest: remaining } = parseAccountFlag(rest);
  if (def.handler && def.flags && def.flags !== "self") {
    checkFlags(remaining, def.flags, `drive ${sub}`);
  }
  const resolution = resolveAccount(accountFlag, {
    mutation: def.mutation,
    commandName: `drive ${sub}`,
  });

  if (!def.handler) {
    throw notImplemented("drive", sub, resolution.account, def.instead);
  }

  return withAccountSource(resolution, await def.handler(resolution.account, remaining));
}
