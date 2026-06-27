import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";

export const REVISIONS_HELP = `usage: gws-axi drive revisions <fileId> [flags]
args[1]:
  <fileId>             The Drive file ID (the portion of the URL after /d/)
flags[3]:
  --full               Add size_bytes, mime_type, kept, published columns
                       (empty where they don't apply to the file's type)
  --limit <n>          Max revisions to return, newest first (default: 100)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive revisions 1V09rp...
  gws-axi drive revisions 1V09rp... --full
output:
  A \`document{id,name,type,revision_count,head_revision}\` header followed by
  a \`revisions[N]{id,modified,author}\` list, newest first. \`id\` is the value
  to pass to \`gws-axi docs download <fileId> --revision <id>\`.
notes:
  For native Google files (Docs/Sheets/Slides) the API exposes only the
  revisions Drive retained — a sparse, session-level sample, NOT the full
  per-edit timeline in the editor's version-history UI, and without
  user-assigned version names. For uploaded/binary files every saved upload
  is a discrete revision (auto-purged 30 days after newer content unless
  pinned). Download a listed revision's content with
  \`gws-axi docs download <fileId> --revision <revisionId>\`.
  \`gws-axi docs revisions\` is an alias for this command.
`;

const DEFAULT_LIMIT = 100;

interface ParsedFlags {
  fileId: string;
  full: boolean;
  limit: number;
}

export function parseFlags(args: string[]): ParsedFlags {
  let fileId: string | undefined;
  let full = false;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--full":
        full = true;
        break;
      case "--limit":
        limit = Math.max(1, parseInt(next, 10) || DEFAULT_LIMIT);
        i++;
        break;
      default:
        if (!arg.startsWith("--") && fileId === undefined) {
          fileId = arg;
        }
    }
  }
  if (!fileId) {
    throw new AxiError("Missing fileId argument", "VALIDATION_ERROR", [
      "Usage: gws-axi drive revisions <fileId>",
      "Get a file ID from `gws-axi drive search` or `gws-axi drive ls`",
    ]);
  }
  return { fileId, full, limit };
}

export function isNative(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}

/** Sort revisions newest-first by modifiedTime (API order is undocumented). */
export function sortRevisionsNewestFirst<T extends { modifiedTime?: string | null }>(
  revisions: T[],
): T[] {
  return [...revisions].sort((a, b) => {
    const ta = Date.parse(a.modifiedTime ?? "") || 0;
    const tb = Date.parse(b.modifiedTime ?? "") || 0;
    return tb - ta;
  });
}

interface RevisionRow {
  id: string;
  modified: string;
  author: string;
  size_bytes: number | "";
  mime_type: string;
  kept: boolean | "";
  published: boolean | "";
}

export async function driveRevisionsCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  // Step 1: file metadata — name + type classification.
  let meta: { name: string; mimeType: string };
  try {
    const res = await api.files.get({
      fileId: flags.fileId,
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    });
    meta = {
      name: res.data.name ?? "(unnamed)",
      mimeType: res.data.mimeType ?? "application/octet-stream",
    };
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
          "Verify the file ID is correct (the portion of the URL after /d/)",
          `Confirm ${account} has at least view access to the file`,
        ],
      );
    }
    throw translated;
  }

  const native = isNative(meta.mimeType);

  // Step 2: paginate the full revision list.
  const revisions: drive_v3.Schema$Revision[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await api.revisions.list({
        fileId: flags.fileId,
        fields:
          "nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever,published,mimeType,size)",
        pageSize: 1000,
        pageToken,
      });
      revisions.push(...(res.data.revisions ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "drive.revisions.list",
    });
  }

  // Step 3: sort newest-first by modifiedTime (API order is not documented).
  const sorted = sortRevisionsNewestFirst(revisions);
  const headRevision = sorted[0]?.id ?? "";
  const limited = sorted.slice(0, flags.limit);

  const rows: RevisionRow[] = limited.map((r) => ({
    id: r.id ?? "",
    modified: r.modifiedTime ?? "",
    author: r.lastModifyingUser?.displayName ?? "",
    size_bytes: r.size != null ? Number(r.size) : "",
    mime_type: r.mimeType ?? "",
    kept: r.keepForever ?? "",
    published: r.published ?? "",
  }));

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      document: {
        id: flags.fileId,
        name: meta.name,
        type: native ? "native" : "binary",
        revision_count: revisions.length,
        head_revision: headRevision,
      },
    }),
  );

  const schema = flags.full
    ? [
        field("id"),
        field("modified"),
        field("author"),
        field("size_bytes"),
        field("mime_type"),
        field("kept"),
        field("published"),
      ]
    : [field("id"), field("modified"), field("author")];

  if (rows.length === 0) {
    blocks.push(renderObject({ revisions: "0 revisions found" }));
  } else {
    blocks.push(renderList("revisions", rows as unknown as Array<Record<string, unknown>>, schema));
  }

  // Completeness disclosure for native files (API may omit older revisions).
  if (native) {
    blocks.push(
      renderObject({
        note: "Native-file revision history may be incomplete — the Drive API can omit older revisions of frequently-edited Docs/Sheets/Slides; the editor's version-history UI may show more.",
      }),
    );
  }

  const suggestions: string[] = [];
  if (rows.length > 0) {
    suggestions.push(
      `Download a revision's content: \`gws-axi docs download ${flags.fileId} --revision ${rows[0].id}\``,
    );
  }
  if (native) {
    suggestions.push(
      "This list may be incomplete — the editor's version-history UI may show more revisions, and version names aren't exposed by the API",
    );
  } else {
    suggestions.push(
      "Binary revisions older than the head may have purged content unless pinned (keepForever)",
    );
  }
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}
