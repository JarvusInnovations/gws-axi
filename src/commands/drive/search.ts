import type { drive_v3 } from "googleapis";
import { driveClient, translateGoogleError } from "../../google/client.js";
import { field, renderListResponse, truncated, type FieldDef } from "../../output/index.js";

export const SEARCH_HELP = `usage: gws-axi drive search [flags]
flags[5]:
  --query <text>             Full-text search across file names AND content
                             (Drive's fullText index). Quote multi-word
                             phrases. Default when omitted: all files
                             modified in the last 30 days.
  --mime <type>              Filter by mime type (e.g.,
                             "application/vnd.google-apps.document" for
                             only Google Docs; "application/pdf" for PDFs).
  --limit <n>                Max files to return (default: 100, max: 1000).
  --page <token>             Fetch the next page (from prior \`next_page\`).
  --account <email>          Account override when 2+ are configured.
examples:
  gws-axi drive search --query "smart data hub"
  gws-axi drive search --query "tides" --mime application/vnd.google-apps.document
  gws-axi drive search --query "invoice" --mime application/pdf --limit 25
output:
  A \`files[N]{id,name,mime_type,size_bytes,modified,owners}\` table.
  Pass any \`id\` to \`drive get\` for full metadata, \`docs read\` (for
  Docs), or \`docs download\` (any file). The \`mime_type\` lets agents
  filter for the file type they care about.
notes:
  fullText matching uses Drive's index, which lags edits by minutes.
  Recently-modified docs may not be indexed yet — for those, use
  \`drive ls\` on the parent folder instead.
`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface ParsedFlags {
  query: string | undefined;
  mime: string | undefined;
  limit: number;
  page: string | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  let query: string | undefined;
  let mime: string | undefined;
  let limit = DEFAULT_LIMIT;
  let page: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--query":
        query = next;
        i++;
        break;
      case "--mime":
        mime = next;
        i++;
        break;
      case "--limit":
        limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(next, 10) || DEFAULT_LIMIT));
        i++;
        break;
      case "--page":
        page = next;
        i++;
        break;
    }
  }
  return { query, mime, limit, page };
}

function buildQuery(flags: ParsedFlags): string {
  const parts: string[] = ["trashed = false"];
  if (flags.query) {
    // Escape any embedded quotes; Drive accepts double-quoted phrases.
    const safe = flags.query.replace(/"/g, '\\"');
    parts.push(`fullText contains "${safe}"`);
  } else {
    // Sensible default — no --query specified, show recently-modified.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    parts.push(`modifiedTime > '${thirtyDaysAgo}'`);
  }
  if (flags.mime) {
    parts.push(`mimeType = '${flags.mime}'`);
  }
  return parts.join(" and ");
}

function schema(): FieldDef[] {
  return [
    field("id"),
    truncated("name", 60),
    field("mime_type"),
    field("size_bytes"),
    field("modified"),
    truncated("owners", 40),
  ];
}

export async function driveSearchCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await driveClient(account);
  const q = buildQuery(flags);

  let data: drive_v3.Schema$FileList;
  try {
    const res = await api.files.list({
      q,
      pageSize: flags.limit,
      pageToken: flags.page,
      fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,owners(emailAddress))",
      orderBy: "modifiedTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    data = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "drive.files.list",
    });
  }

  const items = (data.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mime_type: f.mimeType ?? "",
    size_bytes: f.size ? parseInt(f.size, 10) : "",
    modified: f.modifiedTime ?? "",
    owners: (f.owners ?? [])
      .map((o) => o.emailAddress ?? "")
      .filter(Boolean)
      .join(", "),
  }));

  const header: Record<string, unknown> = {
    account,
    effective_query: q,
  };
  if (data.nextPageToken) header.next_page = data.nextPageToken;

  const summary: Record<string, unknown> = { count: items.length };

  const suggestions: string[] = [];
  if (items.length > 0) {
    suggestions.push(`Run \`gws-axi drive get <id>\` on any file for full metadata`);
    suggestions.push(
      `Run \`gws-axi docs read <id>\` (for Docs) or \`docs download <id>\` (for other files) to read contents`,
    );
    if (data.nextPageToken) {
      const next = rebuildInvocation(flags, data.nextPageToken);
      suggestions.push(`More results — paginate with \`${next}\``);
    }
  } else if (flags.query) {
    suggestions.push(
      `No matches — fullText index lags by minutes; for very recent files try \`drive ls\` on the parent folder`,
    );
  }

  return renderListResponse({
    header,
    summary,
    name: "files",
    items: items as unknown as Array<Record<string, unknown>>,
    schema: schema(),
    suggestions,
    emptyMessage: flags.query
      ? `no files matched "${flags.query}"`
      : `no files modified in the last 30 days`,
  });
}

function rebuildInvocation(flags: ParsedFlags, pageToken: string): string {
  const parts = ["gws-axi drive search"];
  if (flags.query) parts.push(`--query ${shellQuote(flags.query)}`);
  if (flags.mime) parts.push(`--mime ${flags.mime}`);
  if (flags.limit !== DEFAULT_LIMIT) parts.push(`--limit ${flags.limit}`);
  parts.push(`--page ${pageToken}`);
  return parts.join(" ");
}

function shellQuote(v: string): string {
  if (!/[\s"'$`\\]/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
