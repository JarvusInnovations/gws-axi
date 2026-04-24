import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import {
  gmailClient,
  translateGoogleError,
  withRateLimitRetry,
} from "../../google/client.js";
import {
  field,
  renderListResponse,
  truncated,
  type FieldDef,
} from "../../output/index.js";

export const SEARCH_HELP = `usage: gws-axi gmail search [flags]
flags[6]:
  --query <text>             Gmail search query (defaults to \`in:inbox\` when
                             omitted). Supports full Gmail syntax: from:, to:,
                             subject:, is:unread, has:attachment, newer_than:,
                             before:, after:, AND/OR/-. Use --in for label
                             filtering (see below).
  --in <label>               Filter by label name (e.g. "Work/Clients",
                             "INBOX"). Resolves the name to an internal
                             label ID via the API, so nested labels with
                             slashes and spaces work correctly.
  --limit <n>                Max threads to return (default: 25, max: 500).
  --page <token>             Fetch the next page of results. Token comes
                             from the \`next_page\` field of a prior run.
  --include-spam-trash       Include spam/trash in results.
  --account <email>          Account override when 2+ are configured.
examples:
  gws-axi gmail search
  gws-axi gmail search --query "from:boss@company.com is:unread"
  gws-axi gmail search --query "has:attachment newer_than:7d"
  gws-axi gmail search --in "Work/Clients" --query "is:starred"
output:
  A \`threads[N]{id,from,subject,last_date,message_count,unread,labels,snippet}\`
  table. Pass any \`id\` to \`gws-axi gmail read <id>\` to see the full thread.
notes:
  An omitted --query defaults to \`in:inbox\` for a "what's recent" view. Any
  explicit --query searches across ALL mail (Gmail's default behavior) — no
  inbox filter is added. The response header shows the effective_query so
  there's never ambiguity about what was searched.
`;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;
// Cap concurrent threads.get calls; Gmail allows ~15 rps per user but being
// conservative here lets --limit 500 finish without rate limit errors.
const THREAD_GET_CONCURRENCY = 10;

interface ParsedFlags {
  query: string | undefined;
  inLabel: string | undefined;
  limit: number;
  page: string | undefined;
  includeSpamTrash: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  let query: string | undefined;
  let inLabel: string | undefined;
  let limit = DEFAULT_LIMIT;
  let page: string | undefined;
  let includeSpamTrash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--query":
        query = next;
        i++;
        break;
      case "--in":
        inLabel = next;
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
      case "--include-spam-trash":
        includeSpamTrash = true;
        break;
    }
  }
  return { query, inLabel, limit, page, includeSpamTrash };
}

function effectiveQuery(flags: ParsedFlags): string {
  // --in is applied via the labelIds API parameter, not by injecting a
  // `label:X` operator into the text query. Labels with slashes or spaces
  // need exact-ID matching; the text operator is lenient and can miss.
  if (flags.query) return flags.query;
  // Neither --query nor --in specified: default to recent inbox.
  if (!flags.inLabel) return "in:inbox";
  // --in without --query: no text query; the labelIds param does the work.
  return "";
}

// Build the labelIds param for threads.list from a --in value. Resolves
// user-supplied label names (e.g. "Work/Clients") to Gmail's internal
// label IDs so the search is robust against name-operator quirks.
async function resolveLabelId(
  api: gmail_v1.Gmail,
  name: string,
  labels: gmail_v1.Schema$Label[],
): Promise<string> {
  // Try exact name match first (case-sensitive; Gmail labels are).
  const exact = labels.find((l) => l.name === name);
  if (exact?.id) return exact.id;
  // Case-insensitive fallback for usability.
  const insensitive = labels.find(
    (l) => l.name?.toLowerCase() === name.toLowerCase(),
  );
  if (insensitive?.id) return insensitive.id;
  // Accept a raw label ID passthrough (system labels like INBOX, or
  // Label_XXXX ids copied from another command).
  const byId = labels.find((l) => l.id === name);
  if (byId?.id) return byId.id;
  throw new AxiError(
    `Label '${name}' not found`,
    "LABEL_NOT_FOUND",
    [
      `Run \`gws-axi gmail labels\` to see all available labels`,
      `Label names are case-sensitive; check for typos or extra whitespace`,
    ],
  );
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

interface ThreadRow {
  id: string;
  from: string;
  subject: string;
  last_date: string;
  message_count: number;
  unread: boolean;
  labels: string;
  snippet: string;
}

async function fetchThreadSummary(
  api: gmail_v1.Gmail,
  account: string,
  id: string,
  labelNames: Map<string, string>,
): Promise<ThreadRow | null> {
  try {
    const res = await withRateLimitRetry(
      { account, operation: "gmail.threads.get" },
      () =>
        api.users.threads.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        }),
    );
    const thread = res.data;
    const messages = thread.messages ?? [];
    if (messages.length === 0) return null;

    const latest = messages[messages.length - 1];
    const first = messages[0];
    const from = getHeader(latest.payload?.headers, "From");
    const subject = getHeader(first.payload?.headers, "Subject");
    const lastDate = getHeader(latest.payload?.headers, "Date");

    // Aggregate labels across all messages in the thread (thread-level
    // labels aren't directly exposed; derive from union of message labels).
    // Skip system labels like INBOX, SENT, UNREAD — the `labels` column is
    // for user-applied categorization; system state shows via dedicated
    // columns (unread) or is implied by the query filter.
    const labelSet = new Set<string>();
    let unread = false;
    for (const m of messages) {
      for (const l of m.labelIds ?? []) {
        if (l === "UNREAD") {
          unread = true;
          continue;
        }
        if (isSystemLabel(l)) continue;
        // Resolve the internal id (e.g., Label_4234223) to the
        // user-facing name. Fall back to the id if we somehow have a
        // label we couldn't look up.
        labelSet.add(labelNames.get(l) ?? l);
      }
    }

    return {
      id: id,
      from,
      subject,
      last_date: lastDate,
      message_count: messages.length,
      unread,
      labels: [...labelSet].join(","),
      snippet: thread.snippet ?? "",
    };
  } catch {
    // One thread failing shouldn't break the whole search; skip silently
    // (the count reflects successful fetches).
    return null;
  }
}

function isSystemLabel(id: string): boolean {
  // Gmail's system labels are ALL_CAPS; user labels use mixed case / nested
  // slashes / Label_<n> format. The built-in system set is finite but
  // matching on all-caps catches any future additions cheaply.
  return /^[A-Z_]+$/.test(id);
}

async function fetchAllThreadSummaries(
  api: gmail_v1.Gmail,
  account: string,
  ids: string[],
  labelNames: Map<string, string>,
): Promise<ThreadRow[]> {
  const results: Array<ThreadRow | null> = new Array(ids.length).fill(null);
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= ids.length) return;
      results[idx] = await fetchThreadSummary(
        api,
        account,
        ids[idx],
        labelNames,
      );
    }
  }
  const workers = Array.from(
    { length: Math.min(THREAD_GET_CONCURRENCY, ids.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results.filter((r): r is ThreadRow => r !== null);
}

function rebuildSearchInvocation(flags: ParsedFlags, pageToken: string): string {
  const parts = ["gws-axi gmail search"];
  if (flags.query) parts.push(`--query ${shellQuote(flags.query)}`);
  if (flags.inLabel) parts.push(`--in ${shellQuote(flags.inLabel)}`);
  if (flags.limit !== DEFAULT_LIMIT) parts.push(`--limit ${flags.limit}`);
  if (flags.includeSpamTrash) parts.push(`--include-spam-trash`);
  parts.push(`--page ${pageToken}`);
  return parts.join(" ");
}

function shellQuote(v: string): string {
  if (!/[\s"'$`\\]/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function schema(): FieldDef[] {
  return [
    field("id"),
    truncated("from", 40),
    truncated("subject", 60),
    field("last_date"),
    field("message_count"),
    {
      name: "unread",
      extract: (item) => (item.unread ? "✓" : ""),
    },
    field("labels"),
    truncated("snippet", 100),
  ];
}

export async function gmailSearchCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await gmailClient(account);
  const query = effectiveQuery(flags);

  // Always fetch labels once per command — the resulting id→name map is
  // used both to resolve --in <name> to a label ID for the API, and to
  // translate the thread summaries' labelIds back to user-facing names.
  let labelList: gmail_v1.Schema$Label[];
  try {
    const res = await api.users.labels.list({ userId: "me" });
    labelList = res.data.labels ?? [];
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.labels.list",
    });
  }
  const labelNames = new Map<string, string>();
  for (const l of labelList) {
    if (l.id && l.name) labelNames.set(l.id, l.name);
  }

  const labelIds: string[] = [];
  if (flags.inLabel) {
    labelIds.push(await resolveLabelId(api, flags.inLabel, labelList));
  }

  let threadsListed: gmail_v1.Schema$ListThreadsResponse;
  try {
    const res = await api.users.threads.list({
      userId: "me",
      q: query || undefined,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      maxResults: flags.limit,
      pageToken: flags.page,
      includeSpamTrash: flags.includeSpamTrash,
    });
    threadsListed = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.threads.list",
    });
  }

  const stubs = threadsListed.threads ?? [];
  const ids = stubs.map((t) => t.id ?? "").filter(Boolean);
  const rows = await fetchAllThreadSummaries(api, account, ids, labelNames);

  const header: Record<string, unknown> = {
    account,
    effective_query: query || "(none)",
  };
  if (flags.inLabel) {
    header.label_filter = flags.inLabel;
  }
  if (threadsListed.nextPageToken) {
    header.next_page = threadsListed.nextPageToken;
  }

  const summary: Record<string, unknown> = {
    count: rows.length,
  };
  const estimate = threadsListed.resultSizeEstimate ?? 0;
  if (estimate > rows.length) {
    summary.estimated_total = estimate;
  }

  const suggestions: string[] = [];
  if (rows.length > 0) {
    suggestions.push(
      `Run \`gws-axi gmail read <id>\` on any id to see the full thread (smart — accepts thread-id or message-id)`,
    );
    if (threadsListed.nextPageToken) {
      // Echo the full next-page command with the token filled in so the
      // agent can copy-paste or parse the exact invocation.
      const invocation = rebuildSearchInvocation(flags, threadsListed.nextPageToken);
      suggestions.push(
        `More matches available — paginate with \`${invocation}\``,
      );
    }
  } else {
    if (flags.query || flags.inLabel) {
      suggestions.push(
        `No matches — broaden --query or drop --in to widen the search`,
      );
    } else {
      suggestions.push(
        `Inbox is empty (or --query didn't match). Try \`gws-axi gmail search --query is:unread\` or check \`gws-axi gmail labels\``,
      );
    }
  }

  return renderListResponse({
    header,
    summary,
    name: "threads",
    items: rows as unknown as Array<Record<string, unknown>>,
    schema: schema(),
    suggestions,
    emptyMessage: `no threads matched \`${query}\``,
  });
}
