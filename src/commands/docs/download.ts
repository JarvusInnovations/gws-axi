import { writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import {
  driveClient,
  oauthClientForAccount,
  translateGoogleError,
} from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { resolveOutputPath } from "../../util/paths.js";

export const DOWNLOAD_HELP = `usage: gws-axi docs download <documentId> [flags]
args[1]:
  <documentId>         The Google Doc / Drive file ID (from the URL after /d/)
flags[4]:
  --out <path>         Where to save (default: ./<sanitized file name>; pass a
                       directory to save inside with the native name)
  --as <mime>          Export format for native Google files (default: docx for
                       Docs, xlsx for Sheets, pptx for Slides, png for Drawings;
                       text/markdown when --revision is set). Ignored for
                       uploaded files (they download as-is).
  --revision <id>      Download a specific historical revision (id from
                       \`gws-axi drive revisions <id>\`) instead of the head.
                       Native files export via that revision's links
                       (markdown by default); binary files return the exact
                       stored bytes for that revision.
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi docs download 1RxHZ...
  gws-axi docs download 1RxHZ... --out /tmp/source.docx
  gws-axi docs download 1Native... --as application/pdf --out ./spec.pdf
  gws-axi docs download 1Native... --revision 250
notes:
  Works on any Drive file, not just docs. Native Google files are exported
  on the server side (via Drive files.export); uploaded files (.docx, .pdf,
  images, etc.) are downloaded as-is. After download, agents can inspect
  the file with tools like \`file\`, \`pandoc\`, \`textutil -convert html\`,
  or language-specific parsers for the file's format.
  --revision content for native files is a relevance preview (markdown by
  default, lossy); binary revision content may be unavailable if it was
  purged (only pinned/keepForever revisions retain old content).
`;

interface ParsedFlags {
  documentId: string;
  out: string | undefined;
  as: string | undefined;
  revision: string | undefined;
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

export function parseFlags(args: string[]): ParsedFlags {
  let documentId: string | undefined;
  let out: string | undefined;
  let as: string | undefined;
  let revision: string | undefined;
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
      case "--revision":
        revision = next;
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
  return { documentId, out, as, revision };
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

  // Revision download takes a distinct path: native files export via the
  // revision's exportLinks (markdown default), binary files fetch the
  // revision's stored bytes via revisions.get(alt=media).
  if (flags.revision) {
    return downloadRevision(api, account, flags, meta, isNative);
  }

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

/**
 * Download a specific historical revision's content. Native files export
 * via the revision's exportLinks map (markdown default — this is a
 * relevance preview, not a fidelity-preserving capture); binary files
 * fetch the revision's stored bytes via revisions.get(alt=media).
 */
async function downloadRevision(
  api: drive_v3.Drive,
  account: string,
  flags: ParsedFlags,
  meta: { name: string; mimeType: string; size: string | undefined },
  isNative: boolean,
): Promise<string> {
  const revisionId = flags.revision as string;

  // Fetch the revision metadata: modifiedTime + (native) exportLinks.
  let revision: {
    modifiedTime?: string | null;
    exportLinks?: { [k: string]: string } | null;
  };
  try {
    const res = await api.revisions.get({
      fileId: flags.documentId,
      revisionId,
      fields: "id,modifiedTime,exportLinks",
    });
    revision = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.revisions.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Revision '${revisionId}' not found on file '${flags.documentId}'`,
        "REVISION_NOT_FOUND",
        [
          `List valid revisions with \`gws-axi drive revisions ${flags.documentId}\``,
        ],
      );
    }
    throw translated;
  }

  let bytes: Buffer;
  let effectiveMime: string;
  let extension: string;
  const notes: string[] = [];

  if (isNative) {
    const links = revision.exportLinks ?? {};
    const requested = flags.as ?? "text/markdown";
    let chosen = requested;
    let url = links[requested];
    // Fallback chain only applies to the default (markdown); an explicit
    // --as that isn't available is an error the caller must resolve.
    if (!url && !flags.as) {
      const fallback = links["text/plain"] ?? Object.values(links)[0];
      const fallbackMime =
        Object.keys(links).find((k) => links[k] === fallback) ?? "";
      if (fallback) {
        chosen = fallbackMime;
        url = fallback;
        notes.push(
          `text/markdown not available for this revision — exported as ${fallbackMime} instead`,
        );
      }
    }
    if (!url) {
      throw new AxiError(
        `Export format ${requested} not available for revision ${revisionId}`,
        "EXPORT_FORMAT_REQUIRED",
        [
          `Available formats: ${Object.keys(links).join(", ") || "(none)"}`,
          "Pass a supported --as <mime>",
        ],
      );
    }
    effectiveMime = chosen;
    extension = EXTENSION_BY_MIME[chosen] ?? "";
    // exportLinks are arbitrary URLs (not a googleapis method), so fetch
    // directly with the account's bearer token.
    const auth = await oauthClientForAccount(account);
    const { token } = await auth.getAccessToken();
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new AxiError(
        `Failed to export revision ${revisionId} as ${chosen} (HTTP ${resp.status})`,
        "REVISION_CONTENT_UNAVAILABLE",
        [
          `List valid revisions with \`gws-axi drive revisions ${flags.documentId}\``,
        ],
      );
    }
    bytes = Buffer.from(await resp.arrayBuffer());
  } else {
    if (flags.as) {
      throw new AxiError(
        `--as is only valid for native Google files; this is ${meta.mimeType}`,
        "VALIDATION_ERROR",
        ["Drop --as to download the binary revision as-is"],
      );
    }
    effectiveMime = meta.mimeType;
    extension = extname(meta.name) || EXTENSION_BY_MIME[effectiveMime] || "";
    try {
      const res = await api.revisions.get(
        { fileId: flags.documentId, revisionId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      bytes = Buffer.from(res.data as ArrayBuffer);
    } catch (err) {
      const translated = translateGoogleError(err, {
        account,
        operation: "drive.revisions.get(alt=media)",
      });
      if (translated.code === "NOT_FOUND") {
        throw new AxiError(
          `Content for revision '${revisionId}' is unavailable — it may have been purged (only pinned/keepForever binary revisions retain old content)`,
          "REVISION_CONTENT_UNAVAILABLE",
          [
            `List revisions with \`gws-axi drive revisions ${flags.documentId}\` to see which retain content`,
          ],
        );
      }
      throw translated;
    }
  }

  // Default filename suffixes the revision so it never clobbers a head
  // download: "<base>.r<revisionId><ext>".
  const defaultName = `${stripExt(meta.name)}.r${revisionId}${extension}`;
  const outPath = await resolveOutputPath(flags.out, defaultName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);

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
        revision: revisionId,
        revision_modified: revision.modifiedTime ?? "",
      },
    }),
  );
  blocks.push(renderObject({ saved: outPath }));
  for (const n of notes) blocks.push(renderObject({ note: n }));

  const suggestions: string[] = [];
  if (isNative) {
    suggestions.push(
      `Revision exported as ${effectiveMime} (relevance preview) — use --as <mime> for another format`,
    );
  }
  suggestions.push(
    `List all revisions with \`gws-axi drive revisions ${flags.documentId}\``,
  );
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}

/** Strip a trailing extension from a filename, if present. */
function stripExt(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
