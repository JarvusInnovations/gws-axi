import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  renderListResponse,
  type FieldDef,
} from "../../output/index.js";

export const LS_HELP = `usage: gws-axi drive ls [<folder-id>] [flags]
args[1]:
  <folder-id>          Folder ID to list (default: "root", aka My Drive).
                       Pass "shared-with-me" to list files shared with you
                       but not in any of your folders.
flags[6]:
  --recursive, -r      Walk the tree and emit a flat list with full paths
                       relative to the queried folder. Off by default; for
                       a quality overview of an entire client/project
                       folder, pass --recursive.
  --depth <n>          Cap recursion depth (default: unlimited — the
                       --limit safety bound stops runaway walks). Only
                       meaningful with --recursive; useful for "give me
                       a 2-level overview without diving into every
                       subfolder."
  --limit <n>          Max items to return (default: 500, max: 5000).
                       For --recursive, this is the total file count
                       across the walk; for non-recursive, it's the page
                       size against the API.
  --page <token>       Fetch next page (non-recursive only — recursive
                       walks paginate internally).
  --include-trashed    Include trashed files (default: trashed excluded)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive ls                                            # root contents
  gws-axi drive ls 1AbC...folder-id                           # one folder
  gws-axi drive ls 1AbC...folder-id --recursive               # whole tree
  gws-axi drive ls 1AbC... --recursive --depth 3 --limit 1000 # constrained walk
output:
  A \`files[N]{path,id,mime_type,size_bytes,modified}\` table. \`path\` is
  the name for non-recursive listings; the relative path within the walk
  for recursive ones (\`Subfolder/file.pdf\`). Folders have an empty
  size_bytes. \`mime_type\` is the raw Google MIME (\`application/vnd.google-apps.folder\`,
  \`application/vnd.google-apps.document\`, etc.) — use it to filter.
notes:
  Recursive walks make one API call per folder (Drive doesn't support
  recursive list natively). A folder with 10 subfolders × 3 levels deep
  ≈ 1+10+100+1000 calls — bounded by --depth and --limit. Trashed and
  shortcut items are skipped unless --include-trashed.
`;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
// Recursion defaults to unlimited depth; --limit (total file count)
// is the practical safety bound. Most folder trees aren't deeper
// than 5-6 levels anyway, so a depth cap rarely fires before --limit
// does. Callers who want a "shallow overview" pass --depth explicitly.
const DEFAULT_DEPTH = Number.POSITIVE_INFINITY;
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface ParsedFlags {
  folderId: string;
  recursive: boolean;
  depth: number;
  limit: number;
  page: string | undefined;
  includeTrashed: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  let folderId: string | undefined;
  let recursive = false;
  let depth = DEFAULT_DEPTH;
  let limit = DEFAULT_LIMIT;
  let page: string | undefined;
  let includeTrashed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--recursive":
      case "-r":
        recursive = true;
        break;
      case "--depth": {
        const parsed = parseInt(next, 10);
        depth = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEPTH;
        i++;
        break;
      }
      case "--limit":
        limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(next, 10) || DEFAULT_LIMIT));
        i++;
        break;
      case "--page":
        page = next;
        i++;
        break;
      case "--include-trashed":
        includeTrashed = true;
        break;
      default:
        if (!arg.startsWith("--") && folderId === undefined) {
          folderId = arg;
        }
    }
  }
  return {
    folderId: folderId ?? "root",
    recursive,
    depth,
    limit,
    page,
    includeTrashed,
  };
}

interface FileRow {
  path: string;
  id: string;
  mime_type: string;
  size_bytes: number | "";
  modified: string;
}

const FILES_FIELDS = "id,name,mimeType,size,modifiedTime,trashed";

async function listOneFolder(
  api: drive_v3.Drive,
  folderId: string,
  pageToken: string | undefined,
  pageSize: number,
  includeTrashed: boolean,
): Promise<{ files: drive_v3.Schema$File[]; nextPageToken?: string }> {
  const q = includeTrashed
    ? `'${folderId}' in parents`
    : `'${folderId}' in parents and trashed = false`;
  const res = await api.files.list({
    q,
    fields: `nextPageToken, files(${FILES_FIELDS})`,
    pageSize,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    orderBy: "folder, name",
  });
  return {
    files: res.data.files ?? [],
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

function toRow(file: drive_v3.Schema$File, path: string): FileRow {
  return {
    path,
    id: file.id ?? "",
    mime_type: file.mimeType ?? "",
    size_bytes: file.size ? parseInt(file.size, 10) : "",
    modified: file.modifiedTime ?? "",
  };
}

async function recursiveWalk(
  api: drive_v3.Drive,
  folderId: string,
  flags: ParsedFlags,
): Promise<{ rows: FileRow[]; truncated: boolean; foldersWalked: number }> {
  const rows: FileRow[] = [];
  let foldersWalked = 0;
  // BFS keyed by (folderId, prefixPath, depthFromRoot). Stable
  // ordering means a folder's own row is emitted before its children's,
  // which matches what humans expect from `ls -R`.
  const queue: Array<{ id: string; prefix: string; depth: number }> = [
    { id: folderId, prefix: "", depth: 0 },
  ];
  while (queue.length > 0 && rows.length < flags.limit) {
    const { id, prefix, depth } = queue.shift()!;
    foldersWalked += 1;
    let pageToken: string | undefined;
    do {
      // 1000 is Drive's max pageSize and lets us drain a folder quickly.
      const { files, nextPageToken } = await listOneFolder(
        api,
        id,
        pageToken,
        1000,
        flags.includeTrashed,
      );
      for (const file of files) {
        if (rows.length >= flags.limit) break;
        const path = prefix + (file.name ?? "");
        rows.push(toRow(file, path));
        if (file.mimeType === FOLDER_MIME && depth < flags.depth) {
          queue.push({
            id: file.id ?? "",
            prefix: `${path}/`,
            depth: depth + 1,
          });
        }
      }
      pageToken = nextPageToken;
    } while (pageToken && rows.length < flags.limit);
  }
  return {
    rows,
    truncated: rows.length >= flags.limit && queue.length > 0,
    foldersWalked,
  };
}

function fileSchema(): FieldDef[] {
  return [
    field("path"),
    field("id"),
    field("mime_type"),
    field("size_bytes"),
    field("modified"),
  ];
}

export async function driveLsCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);

  let rows: FileRow[];
  let nextPage: string | undefined;
  let truncated = false;
  let foldersWalked = 0;

  if (flags.recursive) {
    try {
      const result = await recursiveWalk(api, flags.folderId, flags);
      rows = result.rows;
      truncated = result.truncated;
      foldersWalked = result.foldersWalked;
    } catch (err) {
      const translated = translateGoogleError(err, {
        account,
        operation: "drive.files.list",
      });
      if (translated.code === "NOT_FOUND") {
        throw new AxiError(
          `Folder '${flags.folderId}' not found (or ${account} doesn't have access)`,
          "FOLDER_NOT_FOUND",
          [
            `Pass "root" or omit the argument to list My Drive root`,
            `Verify the folder ID is correct (from a Drive URL or \`drive search\`)`,
          ],
        );
      }
      throw translated;
    }
  } else {
    try {
      const result = await listOneFolder(
        api,
        flags.folderId,
        flags.page,
        flags.limit,
        flags.includeTrashed,
      );
      rows = result.files.map((f) => toRow(f, f.name ?? ""));
      nextPage = result.nextPageToken;
    } catch (err) {
      const translated = translateGoogleError(err, {
        account,
        operation: "drive.files.list",
      });
      if (translated.code === "NOT_FOUND") {
        throw new AxiError(
          `Folder '${flags.folderId}' not found (or ${account} doesn't have access)`,
          "FOLDER_NOT_FOUND",
          [
            `Pass "root" or omit the argument to list My Drive root`,
            `Verify the folder ID is correct (from a Drive URL or \`drive search\`)`,
          ],
        );
      }
      throw translated;
    }
  }

  const header: Record<string, unknown> = {
    account,
    folder: flags.folderId,
    mode: flags.recursive ? "recursive" : "shallow",
  };
  if (flags.recursive && foldersWalked > 0) {
    header.folders_walked = foldersWalked;
  }
  if (nextPage) header.next_page = nextPage;

  const summary: Record<string, unknown> = { count: rows.length };
  if (truncated) {
    summary.truncated = true;
    summary.note = `Hit --limit ${flags.limit} before walk completed — increase --limit or narrow --depth`;
  }

  const suggestions: string[] = [];
  if (rows.length > 0) {
    if (!flags.recursive) {
      const folderCount = rows.filter((r) => r.mime_type === FOLDER_MIME).length;
      if (folderCount > 0) {
        suggestions.push(
          `${folderCount} folder${folderCount === 1 ? "" : "s"} in this listing — run \`gws-axi drive ls ${flags.folderId} --recursive\` for the full tree (or \`drive ls <subfolder-id>\` to dive into one)`,
        );
      } else {
        // Even with no folders to descend into, mention recursion exists for
        // the case where this is a flat folder of files.
        suggestions.push(
          `Run with --recursive for a deep listing (if subfolders exist this would expand them; this folder appears flat)`,
        );
      }
    }
    suggestions.push(
      `Run \`gws-axi drive get <id>\` for full file metadata (sharing, owners, descriptions)`,
    );
    suggestions.push(
      `Run \`gws-axi docs read <id>\` or \`drive download <id>\` to read file contents`,
    );
    if (nextPage) {
      suggestions.push(
        `More items available — paginate with \`drive ls ${flags.folderId} --page ${nextPage}\``,
      );
    }
  }

  return renderListResponse({
    header,
    summary,
    name: "files",
    items: rows as unknown as Array<Record<string, unknown>>,
    schema: fileSchema(),
    suggestions,
    emptyMessage: flags.recursive
      ? `no files in or under \`${flags.folderId}\``
      : `no files in \`${flags.folderId}\` (try --recursive if you want subfolder contents, or --include-trashed)`,
  });
}
