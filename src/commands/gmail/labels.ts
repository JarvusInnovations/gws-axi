import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  renderListResponse,
  type FieldDef,
} from "../../output/index.js";

export const LABELS_HELP = `usage: gws-axi gmail labels [flags]
flags[2]:
  --type <kind>        Filter by label type: user | system | all (default: all)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi gmail labels
  gws-axi gmail labels --type user
output:
  A \`labels[N]{id,name,type,threads_total,threads_unread,messages_total,messages_unread}\`
  table. Use any \`name\` value with \`gws-axi gmail search --in <name>\` to
  filter by that label.
notes:
  System labels (INBOX, SENT, DRAFT, STARRED, UNREAD, TRASH, SPAM, and
  CATEGORY_* auto-filters) are always present; user labels are whatever
  you've created. \`threads_unread\` on INBOX is a useful at-a-glance
  "how many unread threads do I have" metric.
`;

interface ParsedFlags {
  type: "user" | "system" | "all";
}

function parseFlags(args: string[]): ParsedFlags {
  let type: "user" | "system" | "all" = "all";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--type" && next) {
      if (next === "user" || next === "system" || next === "all") {
        type = next;
      }
      i++;
    }
  }
  return { type };
}

function labelSchema(): FieldDef[] {
  return [
    field("id"),
    field("name"),
    field("type"),
    field("threads_total"),
    field("threads_unread"),
    field("messages_total"),
    field("messages_unread"),
  ];
}

export async function gmailLabelsCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseFlags(args);
  const api = await gmailClient(account);

  let data: gmail_v1.Schema$ListLabelsResponse;
  try {
    // labels.list returns only id/name/type/messageListVisibility/
    // labelListVisibility by default. We need to issue per-label get calls
    // to pick up the counts (messagesTotal, threadsUnread, etc.).
    const res = await api.users.labels.list({ userId: "me" });
    data = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.labels.list",
    });
  }

  const all = data.labels ?? [];
  const filtered = all.filter((l) => {
    if (flags.type === "all") return true;
    return l.type === flags.type;
  });

  // Fetch full label details (counts) in parallel. Gmail allows plenty of
  // RPS for this — label inventories are typically small.
  const full = await Promise.all(
    filtered.map((l) =>
      api.users.labels
        .get({ userId: "me", id: l.id ?? "" })
        .then((r) => r.data)
        .catch(() => l),
    ),
  );

  const rows = full.map((l) => ({
    id: l.id ?? "",
    name: l.name ?? "",
    type: l.type ?? "",
    threads_total: l.threadsTotal ?? 0,
    threads_unread: l.threadsUnread ?? 0,
    messages_total: l.messagesTotal ?? 0,
    messages_unread: l.messagesUnread ?? 0,
  }));

  // Sort: system first (INBOX at the very top), then user labels alpha.
  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === "system" ? -1 : 1;
    if (a.id === "INBOX") return -1;
    if (b.id === "INBOX") return 1;
    return a.name.localeCompare(b.name);
  });

  const suggestions: string[] = [];
  if (rows.length > 0) {
    const inbox = rows.find((r) => r.id === "INBOX");
    if (inbox && inbox.threads_unread > 0) {
      suggestions.push(
        `You have ${inbox.threads_unread} unread threads in INBOX — try \`gws-axi gmail search --query is:unread\``,
      );
    }
    suggestions.push(
      `Filter search by label with \`gws-axi gmail search --in <name>\` (use any \`name\` value above)`,
    );
  }

  return renderListResponse({
    header: { account },
    summary: { count: rows.length, filter: flags.type },
    name: "labels",
    items: rows as unknown as Array<Record<string, unknown>>,
    schema: labelSchema(),
    suggestions,
    emptyMessage: `no ${flags.type === "all" ? "" : `${flags.type} `}labels found`,
  });
}
