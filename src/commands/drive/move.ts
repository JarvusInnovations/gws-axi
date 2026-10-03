import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { parseArgs } from "../../util/flags.js";

/**
 * `drive move`, `drive trash`, `drive untrash` (specs/commands/drive-move-trash.md).
 * All three are `files.update` under the existing `drive` scope, each preceded
 * by a read so a no-op is reported rather than written.
 */

export const MOVE_HELP = `usage: gws-axi drive move <file-id> --to <folder-id> [flags]
args[1]:
  <file-id>            The file or folder to move
flags[2]:
  --to <folder-id>     REQUIRED — the destination folder (\`root\` for My Drive)
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive move 1AbC... --to 1SuBmItTeD... --account you@example.com
output:
  \`action\` (moved | unchanged) and \`file{id,name,mime_type,from,to}\`.
notes:
  The id, content, and direct sharing stay the same. Access inherited from the old
  folder stops applying; the item inherits from the new one. Moving into the folder
  it is already in is a no-op. A folder can't move into itself or beneath itself.
`;

export const TRASH_HELP = `usage: gws-axi drive trash <file-id> [flags]
args[1]:
  <file-id>            The file or folder to move to the trash
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive trash 1AbC... --account you@example.com
output:
  \`action\` (trashed | already_trashed) and \`file{id,name,mime_type}\`.
notes:
  Reversible: \`drive untrash <file-id>\` restores it, until Drive empties the trash
  after 30 days. A trashed folder takes its contents with it. There is no
  permanent delete.
`;

export const UNTRASH_HELP = `usage: gws-axi drive untrash <file-id> [flags]
args[1]:
  <file-id>            The file or folder to restore from the trash
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive untrash 1AbC... --account you@example.com
output:
  \`action\` (restored | not_trashed) and \`file{id,name,mime_type}\`.
notes:
  An item that is in the trash only because its folder is must be restored by
  untrashing the folder.
`;

const FOLDER = "application/vnd.google-apps.folder";
const ITEM_FIELDS = "id,name,mimeType,parents,trashed,explicitlyTrashed";
/** Deep enough for any real tree; a cap so a pathological one can't loop. */
const MAX_ANCESTORS = 20;

export function parseMoveFlags(args: string[]): { fileId: string; to: string } {
  const parsed = parseArgs(args, { value: ["--to"] }, "drive move");
  const usage = "Usage: gws-axi drive move <file-id> --to <folder-id>";
  if (parsed.positionals.length !== 1) {
    throw new AxiError(
      parsed.positionals.length === 0 ? "Missing file id" : "Move one item at a time",
      "VALIDATION_ERROR",
      [usage],
    );
  }
  const to = parsed.values["--to"];
  if (!to) throw new AxiError("Missing --to <folder-id>", "VALIDATION_ERROR", [usage]);
  return { fileId: parsed.positionals[0], to };
}

export function parseIdOnly(args: string[], command: string): string {
  const parsed = parseArgs(args, {}, command);
  if (parsed.positionals.length !== 1) {
    throw new AxiError(
      parsed.positionals.length === 0 ? "Missing file id" : "One item at a time",
      "VALIDATION_ERROR",
      [`Usage: gws-axi ${command} <file-id>`],
    );
  }
  return parsed.positionals[0];
}

function notFound(id: string, account: string, what = "File"): AxiError {
  return new AxiError(`${what} ${id} not found, or ${account} can't see it`, "FILE_NOT_FOUND", [
    "Check the id — `gws-axi drive search <query>` finds files by name",
    `Confirm ${account} has access to it`,
  ]);
}

type File = drive_v3.Schema$File;

export interface DriveReads {
  get(fileId: string, fields: string): Promise<File>;
}

async function getOrNotFound(
  reads: DriveReads,
  id: string,
  fields: string,
  account: string,
  what?: string,
): Promise<File> {
  try {
    return await reads.get(id, fields);
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.files.get" });
    if (translated.code === "NOT_FOUND") throw notFound(id, account, what);
    throw translated;
  }
}

/**
 * True when `folderId` is `targetId` or one of its ancestors — i.e. moving the
 * folder to the target would put it inside itself. Drive answers that move with
 * a bare 400, so it is checked first.
 */
export async function wouldContainItself(
  reads: DriveReads,
  folderId: string,
  targetId: string,
): Promise<boolean> {
  let current: string | undefined = targetId;
  for (let i = 0; current && i < MAX_ANCESTORS; i++) {
    if (current === folderId) return true;
    const file: File = await reads.get(current, "id,parents");
    current = file.parents?.[0] ?? undefined;
  }
  return false;
}

function readsFor(api: drive_v3.Drive): DriveReads {
  return {
    get: async (fileId, fields) =>
      (await api.files.get({ fileId, fields, supportsAllDrives: true })).data,
  };
}

async function update(
  api: drive_v3.Drive,
  account: string,
  params: drive_v3.Params$Resource$Files$Update,
  verb: string,
): Promise<File> {
  try {
    return (await api.files.update({ ...params, fields: ITEM_FIELDS, supportsAllDrives: true }))
      .data;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.files.update" });
    if (translated.code === "NOT_FOUND") throw notFound(params.fileId ?? "", account);
    if (translated.code === "FORBIDDEN") {
      translated.suggestions.unshift(`${verb} needs edit access; ${account} may not have it`);
    }
    throw translated;
  }
}

function fileBlock(file: File, fallbackId: string): Record<string, unknown> {
  return { id: file.id ?? fallbackId, name: file.name ?? "", mime_type: file.mimeType ?? "" };
}

export async function driveMoveCommand(account: string, args: string[]): Promise<string> {
  const flags = parseMoveFlags(args);
  const api = await driveClient(account);
  const reads = readsFor(api);

  const item = await getOrNotFound(reads, flags.fileId, ITEM_FIELDS, account);
  const target = await getOrNotFound(reads, flags.to, "id,name,mimeType", account, "Folder");
  const targetId = target.id ?? flags.to;
  if (target.mimeType !== FOLDER) {
    throw new AxiError(
      `${flags.to} (${target.name ?? "?"}) is a file, not a folder`,
      "NOT_A_FOLDER",
      [
        "Pass a folder id to --to — `gws-axi drive ls` lists folders, `gws-axi drive mkdir` makes one",
        "Nothing was moved",
      ],
    );
  }

  const from = item.parents ?? [];
  const fromLabel = from.join(",");
  let action: "moved" | "unchanged" = "unchanged";
  let result = item;
  if (!(from.length === 1 && from[0] === targetId)) {
    if (item.mimeType === FOLDER && (await wouldContainItself(reads, flags.fileId, targetId))) {
      throw new AxiError(
        `Can't move folder ${item.name ?? flags.fileId} into itself or one of its subfolders`,
        "MOVE_INTO_SELF",
        ["Pick a destination outside this folder", "Nothing was moved"],
      );
    }
    result = await update(
      api,
      account,
      { fileId: flags.fileId, addParents: targetId, removeParents: fromLabel || undefined },
      "Moving",
    );
    action = "moved";
  }

  const help: string[] = [];
  if (action === "moved") {
    help.push(
      `Access inherited from the old folder no longer applies; the item now inherits from ${target.name ?? targetId} — check with \`gws-axi drive permissions ${flags.fileId}\``,
    );
  }
  if (result.trashed)
    help.push(
      `It is still in the trash — \`gws-axi drive untrash ${flags.fileId} --account ${account}\` restores it`,
    );
  help.push(`Run \`gws-axi drive ls ${targetId}\` to see the folder`);
  if (action === "moved" && from.length === 1) {
    help.push(
      `Run \`gws-axi drive move ${flags.fileId} --to ${from[0]} --account ${account}\` to undo`,
    );
  }
  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({
      file: { ...fileBlock(result, flags.fileId), from: fromLabel, to: targetId },
    }),
    renderHelp(help),
  );
}

export async function driveTrashCommand(account: string, args: string[]): Promise<string> {
  const fileId = parseIdOnly(args, "drive trash");
  const api = await driveClient(account);
  const item = await getOrNotFound(readsFor(api), fileId, ITEM_FIELDS, account);

  let action: "trashed" | "already_trashed" = "already_trashed";
  let result = item;
  if (!item.trashed) {
    result = await update(api, account, { fileId, requestBody: { trashed: true } }, "Trashing");
    action = "trashed";
  }
  const help: string[] = [];
  if (item.mimeType === FOLDER) help.push("Everything inside the folder went to the trash with it");
  help.push(
    `Run \`gws-axi drive untrash ${fileId} --account ${account}\` to restore it (Drive empties the trash after 30 days)`,
  );
  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({ file: fileBlock(result, fileId) }),
    renderHelp(help),
  );
}

export async function driveUntrashCommand(account: string, args: string[]): Promise<string> {
  const fileId = parseIdOnly(args, "drive untrash");
  const api = await driveClient(account);
  const item = await getOrNotFound(readsFor(api), fileId, ITEM_FIELDS, account);

  if (item.trashed && !item.explicitlyTrashed) {
    const parent = item.parents?.[0] ?? "<folder-id>";
    throw new AxiError(
      `${item.name ?? fileId} is in the trash because its folder is`,
      "TRASHED_WITH_FOLDER",
      [
        `Run \`gws-axi drive untrash ${parent} --account ${account}\` to restore the folder with its contents`,
        "Nothing was restored",
      ],
    );
  }
  let action: "restored" | "not_trashed" = "not_trashed";
  let result = item;
  if (item.trashed) {
    result = await update(api, account, { fileId, requestBody: { trashed: false } }, "Restoring");
    action = "restored";
  }
  const help = [`Run \`gws-axi drive get ${fileId}\` for its details`];
  if (action === "restored")
    help.push(`Run \`gws-axi drive trash ${fileId} --account ${account}\` to undo`);
  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({ file: fileBlock(result, fileId) }),
    renderHelp(help),
  );
}
