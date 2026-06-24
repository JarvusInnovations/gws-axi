import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import {
  detectMimeType,
  googleConversionTarget,
} from "../../util/mime-types.js";

export const UPLOAD_HELP = `usage: gws-axi drive upload <source> [flags]
args[1]:
  <source>             Content source — exactly one of: a local file path
                       (default), \`-\` to read from stdin, or --content below
flags[6]:
  --content <string>   Inline upload body (alternative to a path or stdin)
  --parent <folder-id> Destination folder ID (default: My Drive root).
                       Cannot be combined with --update.
  --name <name>        Name to give the file in Drive (default: the local
                       file's basename). REQUIRED for stdin / --content (no
                       filename to infer). With --update, renames the target.
  --mime <type>        Override the source content type (default: detected from
                       the file — or, for stdin/--content, the --name —
                       extension; unknown → application/octet-stream)
  --convert            Convert to the matching native Google format on upload
                       (.docx→Doc, .xlsx/.csv→Sheet, .pptx→Slides). With
                       --update, only when the target is already that native type.
  --update <file-id>   Replace an existing file's content (new revision)
                       instead of creating a new file.
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi drive upload ./report.pdf
  gws-axi drive upload ./report.pdf --parent 1AbC... --name "Q2 Report.pdf"
  gws-axi drive upload ./notes.docx --convert
  echo '# Notes' | gws-axi drive upload - --name notes.md --convert
  gws-axi drive upload --content '# Notes' --name notes.md --convert
  gws-axi drive upload ./edited.md --convert --update 1XyZ...
notes:
  Without --update, every upload creates a NEW Drive file — re-running makes
  another copy (Drive allows duplicate names). Use --update <id> to replace an
  existing file's content in place.
output:
  An \`action: created\` (or \`updated\`) line plus a \`file{...}\` object with
  id, name, mime_type, size_bytes, parents, and web_view_link.
`;

export interface ParsedFlags {
  localPath: string | undefined;
  stdin: boolean;
  content: string | undefined;
  parent: string | undefined;
  name: string | undefined;
  mime: string | undefined;
  convert: boolean;
  update: string | undefined;
}

export function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    localPath: undefined,
    stdin: false,
    content: undefined,
    parent: undefined,
    name: undefined,
    mime: undefined,
    convert: false,
    update: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--content":
        flags.content = next;
        i++;
        break;
      case "--parent":
        flags.parent = next;
        i++;
        break;
      case "--name":
        flags.name = next;
        i++;
        break;
      case "--mime":
        flags.mime = next;
        i++;
        break;
      case "--convert":
        flags.convert = true;
        break;
      case "--update":
        flags.update = next;
        i++;
        break;
      case "-":
        // `-` as the positional means read the body from stdin.
        flags.stdin = true;
        break;
      default:
        if (!arg.startsWith("--") && flags.localPath === undefined) {
          flags.localPath = arg;
        }
        break;
    }
  }
  return flags;
}

const UPLOAD_FIELDS = "id,name,mimeType,size,parents,webViewLink";

/**
 * Validate the local path is present and the flag combination is legal,
 * before any FS/network work. Pure — throws `AxiError` on the same cases the
 * spec enumerates, so it's unit-testable without touching disk or Google.
 */
export function validateFlags(flags: ParsedFlags): void {
  const sourceCount =
    (flags.localPath !== undefined ? 1 : 0) +
    (flags.content !== undefined ? 1 : 0) +
    (flags.stdin ? 1 : 0);
  if (sourceCount === 0) {
    throw new AxiError("Missing content source", "VALIDATION_ERROR", [
      "Provide a local file path, `-` to read from stdin, or --content <string>",
      "Usage: gws-axi drive upload <source> [flags]",
    ]);
  }
  if (sourceCount > 1) {
    throw new AxiError(
      "Provide exactly one content source",
      "VALIDATION_ERROR",
      [
        "A local path, `-` (stdin), and --content are mutually exclusive",
        "Pick one source",
      ],
    );
  }
  // stdin / --content have no filename to infer a name (or mime) from.
  if ((flags.stdin || flags.content !== undefined) && !flags.name) {
    throw new AxiError(
      "--name is required when reading from stdin or --content",
      "VALIDATION_ERROR",
      [
        "Pass --name <name> (its extension also sets the default --mime)",
        "e.g. --name notes.md for a markdown upload",
      ],
    );
  }
  if (flags.update && flags.parent) {
    throw new AxiError(
      "--parent cannot be combined with --update",
      "VALIDATION_ERROR",
      [
        "--update replaces a file's content in place; moving folders is not supported here",
        "Drop --parent, or upload as a new file (omit --update) to place it in a folder",
      ],
    );
  }
  // --convert + --update is allowed, but only against a target that's already
  // the matching native type. That check needs the target's mimeType (a
  // files.get), so it lives in the command, not in this pure validator.
}

export async function driveUploadCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  validateFlags(flags);

  // Resolve the content source → { name, sourceMime, body }. stdin and
  // --content skip the filesystem entirely; their name/mime derive from --name
  // (validated present above).
  let name: string;
  let sourceMime: string;
  let body: Readable | string;

  if (flags.content !== undefined) {
    name = flags.name!;
    sourceMime = flags.mime ?? detectMimeType(name);
    body = flags.content;
  } else if (flags.stdin) {
    name = flags.name!;
    sourceMime = flags.mime ?? detectMimeType(name);
    body = process.stdin;
  } else {
    const absolutePath = resolve(process.cwd(), flags.localPath!);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new AxiError(
        `Local file not found: ${flags.localPath}`,
        "LOCAL_FILE_NOT_FOUND",
        ["Check the path; it must be a readable file on this machine"],
      );
    }
    if (fileStat.isDirectory()) {
      throw new AxiError(
        `Local path is a directory, not a file: ${flags.localPath}`,
        "LOCAL_PATH_NOT_FILE",
        ["Upload a single file; recursive directory upload is not supported"],
      );
    }
    name = flags.name ?? basename(absolutePath);
    sourceMime = flags.mime ?? detectMimeType(absolutePath);
    body = createReadStream(absolutePath);
  }

  let targetMime: string | undefined;
  if (flags.convert) {
    const target = googleConversionTarget(sourceMime);
    if (!target) {
      throw new AxiError(
        `Cannot convert ${sourceMime} to a native Google format`,
        "UNSUPPORTED_CONVERSION",
        [
          "Supported: word-processing/text → Doc, spreadsheets/CSV → Sheet, presentations → Slides",
          "Drop --convert to upload the file as-is",
        ],
      );
    }
    targetMime = target;
  }

  const api = await driveClient(account);

  // --convert + --update: the target must already be the native type the
  // source converts to. Verify before uploading so a mismatch fails clean
  // rather than producing a surprise revision.
  if (flags.update && flags.convert) {
    let existingMime: string;
    try {
      const res = await api.files.get({
        fileId: flags.update,
        fields: "id,mimeType",
        supportsAllDrives: true,
      });
      existingMime = res.data.mimeType ?? "";
    } catch (err) {
      const translated = translateGoogleError(err, {
        account,
        operation: "drive.files.get",
      });
      if (translated.code === "NOT_FOUND") {
        throw new AxiError(
          `File '${flags.update}' not found (or ${account} can't write to it)`,
          "FILE_NOT_FOUND",
          [
            "Verify the ID is correct (from a Drive URL or `drive search` / `drive ls`)",
            `Confirm ${account} has edit access`,
          ],
        );
      }
      throw translated;
    }
    if (!existingMime.startsWith("application/vnd.google-apps.")) {
      throw new AxiError(
        `--convert --update needs a native Google target, but '${flags.update}' is ${existingMime}`,
        "VALIDATION_ERROR",
        [
          "Converting a binary file's type in place isn't supported — upload a new file with --convert instead",
          "Or drop --convert to replace the binary content as-is",
        ],
      );
    }
    if (existingMime !== targetMime) {
      throw new AxiError(
        `${sourceMime} converts to ${targetMime}, but target file '${flags.update}' is ${existingMime}`,
        "VALIDATION_ERROR",
        [
          "The source's native type must match the existing file's type",
          "e.g. markdown/docx updates a Doc; csv/xlsx updates a Sheet",
        ],
      );
    }
  }

  const media = {
    mimeType: sourceMime,
    body,
  };

  let file: drive_v3.Schema$File;
  const updating = Boolean(flags.update);
  try {
    if (flags.update) {
      const requestBody: drive_v3.Schema$File = flags.name ? { name } : {};
      // Keep the file's native type and re-import the converted media as a
      // new revision (Drive converts the source bytes into the native file).
      if (flags.convert && targetMime) requestBody.mimeType = targetMime;
      const res = await api.files.update({
        fileId: flags.update,
        requestBody,
        media,
        fields: UPLOAD_FIELDS,
        supportsAllDrives: true,
      });
      file = res.data;
    } else {
      const requestBody: drive_v3.Schema$File = { name };
      if (flags.parent) requestBody.parents = [flags.parent];
      if (targetMime) requestBody.mimeType = targetMime;
      const res = await api.files.create({
        requestBody,
        media,
        fields: UPLOAD_FIELDS,
        supportsAllDrives: true,
      });
      file = res.data;
    }
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: updating ? "drive.files.update" : "drive.files.create",
    });
    if (translated.code === "NOT_FOUND") {
      // For --update, the missing item is the target file; for create it's the
      // --parent folder. Re-wrap with an access-check suggestion (cf. drive get).
      const missing = updating
        ? `File '${flags.update}' not found (or ${account} can't write to it)`
        : `Parent folder '${flags.parent}' not found (or ${account} can't write to it)`;
      throw new AxiError(missing, "FILE_NOT_FOUND", [
        "Verify the ID is correct (from a Drive URL or `drive search` / `drive ls`)",
        `Confirm ${account} has edit access`,
      ]);
    }
    throw translated;
  }

  const details: Record<string, unknown> = {
    id: file.id ?? "",
    name: file.name ?? name,
    mime_type: file.mimeType ?? "",
  };
  if (file.size) details.size_bytes = parseInt(file.size, 10);
  details.parents = file.parents?.length ? file.parents.join(", ") : "";
  if (file.webViewLink) details.web_view_link = file.webViewLink;

  const blocks: string[] = [];
  blocks.push(
    renderObject({ action: updating ? "updated" : "created", account }),
  );
  blocks.push(renderObject({ file: details }));

  const suggestions: string[] = [];
  const id = file.id ?? "";
  const isNativeDoc = file.mimeType === "application/vnd.google-apps.document";
  if (isNativeDoc) {
    suggestions.push(`Run \`gws-axi docs read ${id}\` to read it as markdown`);
  } else if ((file.mimeType ?? "").startsWith("application/vnd.google-apps.")) {
    suggestions.push(
      `Native Google file — run \`gws-axi docs download ${id} --as <mime>\` to export it`,
    );
  } else {
    suggestions.push(
      `Run \`gws-axi docs download ${id} --out <path>\` to fetch the bytes back`,
    );
  }
  suggestions.push(`Run \`gws-axi drive get ${id}\` for full metadata`);
  suggestions.push(
    `Run \`gws-axi drive permissions ${id}\` to see / change who has access`,
  );
  if (!updating) {
    suggestions.push(
      `Re-running creates another copy — pass \`--update ${id}\` to replace this file's content instead`,
    );
  }
  if (file.webViewLink) {
    suggestions.push(`Open in browser: ${file.webViewLink}`);
  }

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
