import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { fetchLabels, labelNamesFor, resolveLabelIds } from "./labels-shared.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000; // messages.batchModify accepts up to 1000 ids per call.

export const BATCH_MODIFY_HELP = `usage: gws-axi gmail batch-modify --query <text> [--add-label <name>...] [--remove-label <name>...] [flags]
flags[6]:
  --query <text>         REQUIRED — Gmail search query selecting the messages
                         to modify (full Gmail syntax: from:, is:unread, etc.)
  --add-label <name>     Label to apply to every match. Repeatable / comma list.
                         Accepts user + system labels (INBOX, UNREAD, STARRED…)
  --remove-label <name>  Label to remove from every match. Same name rules
  --limit <n>            Max messages to affect (default: 100, max: 1000)
  --include-spam-trash   Include spam/trash in the selection
  --account <email>      REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi gmail batch-modify --query "from:newsletters@x.com" --remove-label INBOX
  gws-axi gmail batch-modify --query "is:unread older_than:30d" --remove-label UNREAD
  gws-axi gmail batch-modify --query "from:boss@x.com" --add-label "Important/Boss"
notes:
  Operates on MESSAGES matching --query (not threads). At least one of
  --add-label / --remove-label is required. If more messages match than
  --limit, only the first --limit are modified and the response says so —
  re-run to continue. Idempotent per message (see \`gmail modify\`).
`;

interface ParsedFlags {
  query: string | undefined;
  add: string[];
  remove: string[];
  limit: number;
  includeSpamTrash: boolean;
}

function collect(target: string[], value: string | undefined): void {
  if (!value) return;
  for (const part of value.split(",")) {
    const t = part.trim();
    if (t) target.push(t);
  }
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    query: undefined,
    add: [],
    remove: [],
    limit: DEFAULT_LIMIT,
    includeSpamTrash: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--query":
        flags.query = next;
        i++;
        break;
      case "--add-label":
        collect(flags.add, next);
        i++;
        break;
      case "--remove-label":
        collect(flags.remove, next);
        i++;
        break;
      case "--limit":
        flags.limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(next, 10) || DEFAULT_LIMIT));
        i++;
        break;
      case "--include-spam-trash":
        flags.includeSpamTrash = true;
        break;
    }
  }
  return flags;
}

/** Page through messages.list until we hit `limit` ids or run out. */
async function collectMessageIds(
  api: gmail_v1.Gmail,
  account: string,
  query: string,
  limit: number,
  includeSpamTrash: boolean,
): Promise<{ ids: string[]; more: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  try {
    while (ids.length < limit) {
      const res = await api.users.messages.list({
        userId: "me",
        q: query,
        includeSpamTrash,
        maxResults: Math.min(500, limit - ids.length),
        pageToken,
      });
      for (const m of res.data.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) return { ids, more: false };
    }
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.messages.list",
    });
  }
  // Reached the limit; `more` is true iff another page exists.
  return { ids: ids.slice(0, limit), more: Boolean(pageToken) };
}

export async function gmailBatchModifyCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  if (!flags.query) {
    throw new AxiError("--query is required", "VALIDATION_ERROR", [
      "Usage: gws-axi gmail batch-modify --query <text> [--add-label <name>] [--remove-label <name>]",
    ]);
  }
  if (flags.add.length === 0 && flags.remove.length === 0) {
    throw new AxiError(
      "Nothing to do — pass --add-label and/or --remove-label",
      "VALIDATION_ERROR",
      ["Archive matches: --remove-label INBOX · Mark read: --remove-label UNREAD"],
    );
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);
  const addLabelIds = resolveLabelIds(flags.add, labels);
  const removeLabelIds = resolveLabelIds(flags.remove, labels);

  const { ids, more } = await collectMessageIds(
    api,
    account,
    flags.query,
    flags.limit,
    flags.includeSpamTrash,
  );

  if (ids.length === 0) {
    return joinBlocks(
      renderObject({
        action: "noop",
        account,
        query: flags.query,
        matched: 0,
        reason: "no messages matched the query",
      }),
      renderHelp([
        `Preview matches first with \`gws-axi gmail search --query ${JSON.stringify(flags.query)}\``,
      ]),
    );
  }

  try {
    await api.users.messages.batchModify({
      userId: "me",
      requestBody: { ids, addLabelIds, removeLabelIds },
    });
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.messages.batchModify",
    });
  }

  const result: Record<string, unknown> = {
    action: "batch_modified",
    account,
    query: flags.query,
    matched: ids.length,
  };
  if (flags.add.length) result.added = labelNamesFor(addLabelIds, labels).join(", ");
  if (flags.remove.length) {
    result.removed = labelNamesFor(removeLabelIds, labels).join(", ");
  }

  const suggestions: string[] = [];
  if (more) {
    suggestions.push(
      `More messages match than --limit ${flags.limit} — re-run the same command to modify the next batch`,
    );
  }
  suggestions.push(`Verify with \`gws-axi gmail search --query ${JSON.stringify(flags.query)}\``);

  return joinBlocks(renderObject(result), renderHelp(suggestions));
}
