import { writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, extname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";

export const DOWNLOAD_HELP = `usage: gws-axi docs download <documentId> [flags]
args[1]:
  <documentId>         The Google Doc / Drive file ID (from the URL after /d/)
flags[3]:
  --out <path>         Where to save (default: ./<sanitized file name>; pass a
                       directory to save inside with the native name)
  --as <mime>          Export format for native Google files (default: docx for
                       Docs, xlsx for Sheets, pptx for Slides, png for Drawings).
                       Ignored for uploaded files (they download as-is).
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs download 1RxHZ...
  gws-axi docs download 1RxHZ... --out /tmp/source.docx
  gws-axi docs download 1Native... --as application/pdf --out ./spec.pdf
notes:
  Works on any Drive file, not just docs. Native Google files are exported
  on the server side (via Drive files.export); uploaded files (.docx, .pdf,
  images, etc.) are downloaded as-is. After download, agents can inspect
  the file with tools like \`file\`, \`pandoc\`, \`textutil -convert html\`,
  or language-specific parsers for the file's format.
`;

interface ParsedFlags {
  documentId: string;
  out: string | undefined;
  as: string | undefined;
}

// Default export mime types for native Google file types.
const NATIVE_EXPORT_DEFAULTS: Record<string, { mime: string; extension: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: ".pptx",
  },
  "application/vnd.google-apps.drawing": {
    mime: "image/png",
    extension: ".png",
  },
};

// When the user passes --as, try to guess a file extension from the mime.
const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/rtf": ".rtf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "application/epub+zip": ".epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
};

function parseFlags(args: string[]): ParsedFlags {
  let documentId: string | undefined;
  let out: string | undefined;
  let as: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--out":
        out = next;
        i++;
        break;
      case "--as":
        as = next;
        i++;
        break;
      default:
        if (!arg.startsWith("--") && documentId === undefined) {
          documentId = arg;
        }
    }
  }
  if (!documentId) {
    throw new AxiError(
      "Missing documentId argument",
      "VALIDATION_ERROR",
      ["Usage: gws-axi docs download <documentId>"],
    );
  }
  return { documentId, out, as };
}

// Strip path separators from a Drive file name so it can be used as a
// basename without risk of `../` escape or cross-directory writes.
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_").trim() || "download";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function resolveOutputPath(
  provided: string | undefined,
  baseName: string,
): Promise<string> {
  const sanitized = sanitizeFileName(baseName);
  if (!provided) return resolve(process.cwd(), sanitized);
  const absolute = resolve(process.cwd(), provided);
  // Trailing slash → always a directory; and an existing directory → append
  // the base name so agents can pass a folder without pre-constructing the
  // full path.
  if (provided.endsWith("/") || provided.endsWith("\\") || (await isDirectory(absolute))) {
    return join(absolute, sanitized);
  }
  return absolute;
}

export async function docsDownloadCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  // Step 1: metadata — we need name, mimeType, and size to decide whether
  // to export or media-download and to build a useful response.
  let meta: { name: string; mimeType: string; size: string | undefined };
  try {
    const res = await api.files.get({
      fileId: flags.documentId,
      fields: "id,name,mimeType,size",
      supportsAllDrives: true,
    });
    meta = {
      name: res.data.name ?? "download",
      mimeType: res.data.mimeType ?? "application/octet-stream",
      size: res.data.size ?? undefined,
    };
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.files.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `File '${flags.documentId}' not found (or ${account} doesn't have access)`,
        "FILE_NOT_FOUND",
        [
          `Verify the file ID is correct (the portion of the URL after /d/)`,
          `Confirm ${account} has at least view access to the file`,
        ],
      );
    }
    throw translated;
  }

  const isNative = meta.mimeType.startsWith("application/vnd.google-apps.");
  const nativeDefault = NATIVE_EXPORT_DEFAULTS[meta.mimeType];

  if (isNative && !nativeDefault && !flags.as) {
    throw new AxiError(
      `No default export format for native mime type ${meta.mimeType}`,
      "EXPORT_FORMAT_REQUIRED",
      [
        "Pass --as <mime> to choose an export format",
        "Common options: application/pdf, text/plain, text/html",
      ],
    );
  }

  // Step 2: fetch bytes.
  let bytes: Buffer;
  let effectiveMime: string;
  let extension: string;

  if (isNative) {
    effectiveMime = flags.as ?? nativeDefault!.mime;
    extension = EXTENSION_BY_MIME[effectiveMime] ?? nativeDefault?.extension ?? "";
    try {
      const res = await api.files.export(
        { fileId: flags.documentId, mimeType: effectiveMime },
        { responseType: "arraybuffer" },
      );
      bytes = Buffer.from(res.data as ArrayBuffer);
    } catch (err) {
      throw translateGoogleError(err, {
        account,
        operation: "drive.files.export",
      });
    }
  } else {
    if (flags.as) {
      throw new AxiError(
        `--as is only valid for native Google files; this is ${meta.mimeType}`,
        "VALIDATION_ERROR",
        [
          "Drop --as to download the file as-is",
          `The file will be saved with its original mime type (${meta.mimeType})`,
        ],
      );
    }
    effectiveMime = meta.mimeType;
    extension = extname(meta.name) || EXTENSION_BY_MIME[effectiveMime] || "";
    try {
      const res = await api.files.get(
        { fileId: flags.documentId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      bytes = Buffer.from(res.data as ArrayBuffer);
    } catch (err) {
      throw translateGoogleError(err, {
        account,
        operation: "drive.files.get(alt=media)",
      });
    }
  }

  // Step 3: compute output path. For native files we might need to append
  // the extension because meta.name doesn't carry one for Google-native
  // files (e.g., "My Doc" rather than "My Doc.docx").
  let baseName = meta.name;
  if (isNative && extension && !baseName.toLowerCase().endsWith(extension.toLowerCase())) {
    baseName += extension;
  }

  const outPath = await resolveOutputPath(flags.out, baseName);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);

  // Step 4: response.
  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      file: {
        id: flags.documentId,
        name: meta.name,
        source_mime_type: meta.mimeType,
        saved_mime_type: effectiveMime,
        size_bytes: bytes.length,
      },
    }),
  );
  blocks.push(renderObject({ saved: outPath }));

  const suggestions: string[] = [];
  if (effectiveMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    suggestions.push(
      `This is a .docx — extract text with \`pandoc "${basename(outPath)}" -t plain\` or \`textutil -convert txt "${basename(outPath)}"\``,
    );
  } else if (effectiveMime === "application/pdf") {
    suggestions.push(
      `This is a PDF — inspect with \`pdftotext "${basename(outPath)}" -\` or open in Preview`,
    );
  } else if (effectiveMime.startsWith("text/")) {
    suggestions.push(`Text file — \`cat "${outPath}"\` to view`);
  } else if (effectiveMime.startsWith("image/")) {
    suggestions.push(`Image file — open with \`open "${outPath}"\` on macOS`);
  } else {
    suggestions.push(
      `Inspect with \`file "${outPath}"\` to identify the format`,
    );
  }
  if (isNative) {
    suggestions.push(
      `Native Google file exported as ${effectiveMime} — use --as <mime> to pick a different format (e.g. application/pdf, text/plain)`,
    );
  }

  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
