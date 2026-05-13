import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";

export const GET_HELP = `usage: gws-axi drive get <file-id> [flags]
args[1]:
  <file-id>            The Drive file ID (from the URL or \`drive search\` / ls output)
flags[1]:
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive get 1AbC...
output:
  A \`file{...}\` object with name, mime_type, size, owners, parents,
  modified/created times, and view-link. For native Google files
  (Docs, Sheets, Slides) we include hints pointing at \`docs read\` /
  \`docs download\`; for other types, \`drive download\`.
`;

interface ParsedFlags {
  fileId: string;
}

function parseFlags(args: string[]): ParsedFlags {
  let fileId: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("--") && fileId === undefined) {
      fileId = arg;
    }
  }
  if (!fileId) {
    throw new AxiError(
      "Missing file ID argument",
      "VALIDATION_ERROR",
      ["Usage: gws-axi drive get <file-id>"],
    );
  }
  return { fileId };
}

const GET_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,owners(emailAddress,displayName),parents,description,trashed,starred,shared,webViewLink,iconLink,sha256Checksum,fileExtension";

export async function driveGetCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  let file: drive_v3.Schema$File;
  try {
    const res = await api.files.get({
      fileId: flags.fileId,
      fields: GET_FIELDS,
      supportsAllDrives: true,
    });
    file = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.files.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `File '${flags.fileId}' not found (or ${account} doesn't have access)`,
        "FILE_NOT_FOUND",
        [
          `Verify the file ID is correct (from a Drive URL or \`drive search\`)`,
          `Confirm ${account} has at least view access`,
        ],
      );
    }
    throw translated;
  }

  const isNative = (file.mimeType ?? "").startsWith("application/vnd.google-apps.");
  const isFolder = file.mimeType === "application/vnd.google-apps.folder";

  const details: Record<string, unknown> = {
    id: file.id ?? flags.fileId,
    name: file.name ?? "",
    mime_type: file.mimeType ?? "",
  };
  if (file.size) details.size_bytes = parseInt(file.size, 10);
  if (file.createdTime) details.created = file.createdTime;
  if (file.modifiedTime) details.modified = file.modifiedTime;
  if (file.owners?.length) {
    details.owners = file.owners
      .map((o) => o.emailAddress ?? o.displayName ?? "")
      .filter(Boolean)
      .join(", ");
  }
  if (file.parents?.length) details.parents = file.parents.join(", ");
  if (file.description) details.description = file.description;
  if (file.shared !== undefined) details.shared = file.shared;
  if (file.starred) details.starred = true;
  if (file.trashed) details.trashed = true;
  if (file.webViewLink) details.web_view_link = file.webViewLink;
  if (file.fileExtension) details.file_extension = file.fileExtension;

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(renderObject({ file: details }));

  const suggestions: string[] = [];
  if (isFolder) {
    suggestions.push(
      `Run \`gws-axi drive ls ${file.id} --recursive\` to walk this folder's contents`,
    );
  } else if (file.mimeType === "application/vnd.google-apps.document") {
    suggestions.push(
      `Run \`gws-axi docs read ${file.id}\` to read this Doc as markdown`,
    );
    suggestions.push(
      `Run \`gws-axi docs comments ${file.id}\` to see review comments`,
    );
  } else if (isNative) {
    suggestions.push(
      `Native Google file — run \`gws-axi docs download ${file.id} --as <mime>\` to export (e.g. application/pdf, text/csv)`,
    );
  } else {
    suggestions.push(
      `Run \`gws-axi docs download ${file.id} --out <path>\` to fetch the raw file`,
    );
  }
  suggestions.push(
    `Run \`gws-axi drive permissions ${file.id}\` to see who has access`,
  );
  if (file.webViewLink) {
    suggestions.push(`Open in browser: ${file.webViewLink}`);
  }

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
