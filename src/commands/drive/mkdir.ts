import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";

export const MKDIR_HELP = `usage: gws-axi drive mkdir <name> [flags]
args[1]:
  <name>               REQUIRED — the folder name
flags[2]:
  --parent <folder-id> Parent folder ID (default: My Drive root)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi drive mkdir "Q2 Reports"
  gws-axi drive mkdir Invoices --parent 1AbC...
notes:
  Drive allows duplicate folder names — re-running creates ANOTHER folder.
  Capture the returned id to nest uploads with \`drive upload --parent <id>\`.
output:
  An \`action: created\` line plus a \`folder{...}\` object with id, name,
  parents, and web_view_link.
`;

const FOLDER_MIME = "application/vnd.google-apps.folder";
const MKDIR_FIELDS = "id,name,parents,webViewLink";

export interface ParsedFlags {
  name: string | undefined;
  parent: string | undefined;
}

export function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { name: undefined, parent: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--parent":
        flags.parent = next;
        i++;
        break;
      default:
        if (!arg.startsWith("--") && flags.name === undefined) {
          flags.name = arg;
        }
        break;
    }
  }
  return flags;
}

export async function driveMkdirCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);

  if (!flags.name) {
    throw new AxiError("Missing folder name", "VALIDATION_ERROR", [
      "Usage: gws-axi drive mkdir <name> [--parent <folder-id>]",
    ]);
  }

  const api = await driveClient(account);
  const requestBody: drive_v3.Schema$File = {
    name: flags.name,
    mimeType: FOLDER_MIME,
  };
  if (flags.parent) requestBody.parents = [flags.parent];

  let folder: drive_v3.Schema$File;
  try {
    const res = await api.files.create({
      requestBody,
      fields: MKDIR_FIELDS,
      supportsAllDrives: true,
    });
    folder = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.files.create",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Parent folder '${flags.parent}' not found (or ${account} can't write to it)`,
        "FILE_NOT_FOUND",
        [
          "Verify the --parent ID is correct (from a Drive URL or `drive ls` / `drive search`)",
          `Confirm ${account} has edit access`,
        ],
      );
    }
    throw translated;
  }

  const id = folder.id ?? "";
  const details: Record<string, unknown> = {
    id,
    name: folder.name ?? flags.name,
    parents: folder.parents?.length ? folder.parents.join(", ") : "",
  };
  if (folder.webViewLink) details.web_view_link = folder.webViewLink;

  const blocks: string[] = [];
  blocks.push(renderObject({ action: "created", account }));
  blocks.push(renderObject({ folder: details }));

  const suggestions: string[] = [
    `Run \`gws-axi drive upload <file> --parent ${id}\` to put a file in this folder`,
    `Run \`gws-axi drive ls ${id}\` to list its contents`,
    `Run \`gws-axi drive get ${id}\` for full metadata`,
    `Run \`gws-axi drive permissions ${id}\` to see / change who has access`,
    `Re-running creates another folder (Drive allows duplicate names) — capture this id to reuse it`,
  ];
  if (folder.webViewLink) {
    suggestions.push(`Open in browser: ${folder.webViewLink}`);
  }

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
