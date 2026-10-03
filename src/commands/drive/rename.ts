import { AxiError } from "axi-sdk-js";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { parseArgs } from "../../util/flags.js";

export const RENAME_HELP = `usage: gws-axi drive rename <file-id> --name <new-name> [flags]
args[1]:
  <file-id>            The file or folder to rename
flags[2]:
  --name <new-name>    REQUIRED — the new name, exactly as it should read
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi drive rename 1AbC... --name "Slate — Lincoln HS" --account you@example.com
output:
  \`action\` (renamed | unchanged) and \`file{id,name,previous_name,mime_type}\`.
notes:
  Only the name changes — content, location, sharing, and id stay the same.
  Renaming to the current name is a no-op. Drive allows duplicate names.
`;

const COMMAND = "drive rename";
const USAGE = 'Usage: gws-axi drive rename <file-id> --name "<new name>"';

export function parseRenameFlags(args: string[]): { fileId: string; name: string } {
  const parsed = parseArgs(args, { value: ["--name"] }, COMMAND);
  if (parsed.positionals.length !== 1) {
    throw new AxiError(
      parsed.positionals.length === 0 ? "Missing file id" : "Rename one file at a time",
      "VALIDATION_ERROR",
      [USAGE],
    );
  }
  const name = parsed.values["--name"];
  if (name === undefined || name.trim() === "") {
    throw new AxiError("Missing --name", "VALIDATION_ERROR", [USAGE]);
  }
  return { fileId: parsed.positionals[0], name };
}

function notFound(fileId: string, account: string): AxiError {
  return new AxiError(`File ${fileId} not found, or ${account} can't see it`, "FILE_NOT_FOUND", [
    "Check the id — `gws-axi drive search <query>` finds files by name",
    `Confirm ${account} has access to it`,
  ]);
}

export async function driveRenameCommand(account: string, args: string[]): Promise<string> {
  const flags = parseRenameFlags(args);
  const api = await driveClient(account);
  const fields = "id,name,mimeType";

  let current;
  try {
    current = (await api.files.get({ fileId: flags.fileId, fields, supportsAllDrives: true })).data;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "drive.files.get" });
    if (translated.code === "NOT_FOUND") throw notFound(flags.fileId, account);
    throw translated;
  }

  const previous = current.name ?? "";
  let action: "renamed" | "unchanged" = "unchanged";
  let result = current;
  if (previous !== flags.name) {
    try {
      result = (
        await api.files.update({
          fileId: flags.fileId,
          requestBody: { name: flags.name },
          fields,
          supportsAllDrives: true,
        })
      ).data;
      action = "renamed";
    } catch (err) {
      const translated = translateGoogleError(err, { account, operation: "drive.files.update" });
      if (translated.code === "NOT_FOUND") throw notFound(flags.fileId, account);
      if (translated.code === "FORBIDDEN") {
        translated.suggestions.unshift(`Renaming needs edit access; ${account} doesn't have it`);
      }
      throw translated;
    }
  }

  const help = [`Run \`gws-axi drive get ${flags.fileId}\` for its details`];
  if (action === "renamed") {
    help.push(
      `Run \`gws-axi drive rename ${flags.fileId} --name ${JSON.stringify(previous)} --account ${account}\` to undo`,
    );
  }
  return joinBlocks(
    renderObject({ account }),
    renderObject({ action }),
    renderObject({
      file: {
        id: result.id ?? flags.fileId,
        name: result.name ?? flags.name,
        previous_name: previous,
        mime_type: result.mimeType ?? "",
      },
    }),
    renderHelp(help),
  );
}
