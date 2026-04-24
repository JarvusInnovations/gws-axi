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
flags[5]:
  --query <text>             Gmail search query (defaults to \`in:inbox\` when
                             omitted). Supports full Gmail syntax: from:, to:,
                             subject:, is:unread, label:, has:attachment,
                             newer_than:, before:, after:, AND/OR/-.
  --in <label>               Shortcut for a \`label:<name>\` filter prepended
                             to --query (combine with other operators freely).
  --limit <n>                Max threads to return (default: 25, max: 500).
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
  includeSpamTrash: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  let query: string | undefined;
  let inLabel: string | undefined;
  let limit = DEFAULT_LIMIT;
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
      case "--include-spam-trash":
        includeSpamTrash = true;
        break;
    }
  }
  return { query, inLabel, limit, includeSpamTrash };
}

function effectiveQuery(flags: ParsedFlags): string {
  const parts: string[] = [];
  if (flags.inLabel) parts.push(`label:${quoteIfNeeded(flags.inLabel)}`);
  if (flags.query) {
    parts.push(flags.query);
  } else if (!flags.inLabel) {
    // Neither --query nor --in specified: default to recent inbox.
    parts.push("in:inbox");
  }
  return parts.join(" ");
}

function quoteIfNeeded(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
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
        labelSet.add(l);
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
): Promise<ThreadRow[]> {
  const results: Array<ThreadRow | null> = new Array(ids.length).fill(null);
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= ids.length) return;
      results[idx] = await fetchThreadSummary(api, account, ids[idx]);
    }
  }
  const workers = Array.from(
    { length: Math.min(THREAD_GET_CONCURRENCY, ids.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results.filter((r): r is ThreadRow => r !== null);
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

  let threadsListed: gmail_v1.Schema$ListThreadsResponse;
  try {
    const res = await api.users.threads.list({
      userId: "me",
      q: query,
      maxResults: flags.limit,
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
  const rows = await fetchAllThreadSummaries(api, account, ids);

  const header: Record<string, unknown> = {
    account,
    effective_query: query,
  };

  const summary: Record<string, unknown> = {
    count: rows.length,
  };
  if (threadsListed.nextPageToken) {
    summary.more_available = true;
  }
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
      suggestions.push(
        `More matches available — increase --limit (currently ${flags.limit}, max ${MAX_LIMIT}) or narrow --query`,
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
