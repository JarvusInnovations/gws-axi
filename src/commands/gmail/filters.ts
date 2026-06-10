import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { gmailClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderListResponse,
  renderObject,
  type FieldDef,
} from "../../output/index.js";
import {
  fetchLabels,
  labelNamesFor,
  resolveLabelIds,
} from "./labels-shared.js";

// Gmail filters live behind gmail.settings.basic, which is NOT granted by
// gmail.modify. Accounts authenticated before that scope was added will get
// a 403 here; translateGoogleError surfaces it as SCOPE_MISSING with a
// re-auth suggestion.
const SCOPE_NOTE =
  "Filters require the gmail.settings.basic scope. If this 403s, run `gws-axi auth login --account <email>` to re-consent.";

export const FILTER_LIST_HELP = `usage: gws-axi gmail filter-list [flags]
flags[1]:
  --account <email>    Account override when 2+ are configured
output:
  A \`filters[N]{id,criteria,action}\` table. Each row summarizes one
  server-side rule. Pass an \`id\` to \`gws-axi gmail filter-delete <id>\`.
notes:
  Filters are server-side auto-sort rules that run continuously on Google's
  side (separate from labels). ${SCOPE_NOTE}
`;

export const FILTER_CREATE_HELP = `usage: gws-axi gmail filter-create <criteria> <action> [flags]
criteria (>=1 required):
  --from <text>          Match sender
  --to <text>            Match recipient
  --subject <text>       Match subject
  --query <text>         Match an arbitrary Gmail search query
  --has-attachment       Match only messages with attachments
action (>=1 required):
  --add-label <name>     Apply a label. Repeatable / comma list. Accepts user
                         + system labels (e.g. STARRED, IMPORTANT)
  --remove-label <name>  Remove a label. Use INBOX to skip-inbox (archive),
                         UNREAD to mark read
  --forward <email>      Forward matching mail to this address (must be a
                         verified forwarding address in Gmail settings)
flags:
  --account <email>      REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi gmail filter-create --from newsletters@x.com --remove-label INBOX --add-label News
  gws-axi gmail filter-create --subject "[ALERT]" --add-label STARRED --add-label IMPORTANT
notes:
  Idempotent: an existing filter with identical criteria + action returns
  \`action: exists\`. ${SCOPE_NOTE}
`;

export const FILTER_DELETE_HELP = `usage: gws-axi gmail filter-delete <filter-id> [flags]
args[1]:
  <filter-id>          Filter ID (from \`gws-axi gmail filter-list\`)
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated
notes:
  Idempotent: deleting an unknown filter id returns \`action: noop\`.
  ${SCOPE_NOTE}
`;

function criteriaSummary(c: gmail_v1.Schema$FilterCriteria | undefined): string {
  if (!c) return "(any)";
  const parts: string[] = [];
  if (c.from) parts.push(`from:${c.from}`);
  if (c.to) parts.push(`to:${c.to}`);
  if (c.subject) parts.push(`subject:${c.subject}`);
  if (c.query) parts.push(`query:${c.query}`);
  if (c.hasAttachment) parts.push("has:attachment");
  return parts.join(" ") || "(any)";
}

function actionSummary(
  a: gmail_v1.Schema$FilterAction | undefined,
  labels: gmail_v1.Schema$Label[],
): string {
  if (!a) return "(none)";
  const parts: string[] = [];
  if (a.addLabelIds?.length) {
    parts.push(`+[${labelNamesFor(a.addLabelIds, labels).join(",")}]`);
  }
  if (a.removeLabelIds?.length) {
    parts.push(`-[${labelNamesFor(a.removeLabelIds, labels).join(",")}]`);
  }
  if (a.forward) parts.push(`forward:${a.forward}`);
  return parts.join(" ") || "(none)";
}

function schema(): FieldDef[] {
  return [field("id"), field("criteria"), field("action")];
}

export async function gmailFilterListCommand(
  account: string,
  _args: string[],
): Promise<string> {
  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);

  let data: gmail_v1.Schema$ListFiltersResponse;
  try {
    const res = await api.users.settings.filters.list({ userId: "me" });
    data = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.settings.filters.list",
    });
  }

  const rows = (data.filter ?? []).map((f) => ({
    id: f.id ?? "",
    criteria: criteriaSummary(f.criteria),
    action: actionSummary(f.action, labels),
  }));

  return renderListResponse({
    header: { account },
    summary: { count: rows.length },
    name: "filters",
    items: rows as unknown as Array<Record<string, unknown>>,
    schema: schema(),
    suggestions:
      rows.length > 0
        ? [`Delete one with \`gws-axi gmail filter-delete <id>\``]
        : [`Create one with \`gws-axi gmail filter-create --help\``],
    emptyMessage: "no filters configured",
  });
}

interface CreateFlags {
  from: string | undefined;
  to: string | undefined;
  subject: string | undefined;
  query: string | undefined;
  hasAttachment: boolean;
  add: string[];
  remove: string[];
  forward: string | undefined;
}

function collect(target: string[], value: string | undefined): void {
  if (!value) return;
  for (const part of value.split(",")) {
    const t = part.trim();
    if (t) target.push(t);
  }
}

function parseCreateFlags(args: string[]): CreateFlags {
  const flags: CreateFlags = {
    from: undefined,
    to: undefined,
    subject: undefined,
    query: undefined,
    hasAttachment: false,
    add: [],
    remove: [],
    forward: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--from": flags.from = next; i++; break;
      case "--to": flags.to = next; i++; break;
      case "--subject": flags.subject = next; i++; break;
      case "--query": flags.query = next; i++; break;
      case "--has-attachment": flags.hasAttachment = true; break;
      case "--add-label": collect(flags.add, next); i++; break;
      case "--remove-label": collect(flags.remove, next); i++; break;
      case "--forward": flags.forward = next; i++; break;
    }
  }
  return flags;
}

/** Compare two id arrays as sets (order/duplicates ignored). */
function sameIdSet(a: string[] | null | undefined, b: string[]): boolean {
  const setA = new Set(a ?? []);
  if (setA.size !== b.length) return false;
  return b.every((id) => setA.has(id));
}

export async function gmailFilterCreateCommand(
  account: string,
  args: string[],
): Promise<string> {
  const flags = parseCreateFlags(args);

  const criteria: gmail_v1.Schema$FilterCriteria = {};
  if (flags.from) criteria.from = flags.from;
  if (flags.to) criteria.to = flags.to;
  if (flags.subject) criteria.subject = flags.subject;
  if (flags.query) criteria.query = flags.query;
  if (flags.hasAttachment) criteria.hasAttachment = true;

  if (Object.keys(criteria).length === 0) {
    throw new AxiError(
      "At least one criterion is required",
      "VALIDATION_ERROR",
      ["Add e.g. --from <addr>, --subject <text>, or --query <gmail-query>"],
    );
  }
  if (flags.add.length === 0 && flags.remove.length === 0 && !flags.forward) {
    throw new AxiError("At least one action is required", "VALIDATION_ERROR", [
      "Add e.g. --add-label <name>, --remove-label INBOX, or --forward <addr>",
    ]);
  }

  const api = await gmailClient(account);
  const labels = await fetchLabels(api, account);
  const addLabelIds = resolveLabelIds(flags.add, labels);
  const removeLabelIds = resolveLabelIds(flags.remove, labels);

  const action: gmail_v1.Schema$FilterAction = {};
  if (addLabelIds.length) action.addLabelIds = addLabelIds;
  if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;
  if (flags.forward) action.forward = flags.forward;

  // Idempotency: scan existing filters for an identical criteria+action.
  let existingList: gmail_v1.Schema$ListFiltersResponse;
  try {
    const res = await api.users.settings.filters.list({ userId: "me" });
    existingList = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.settings.filters.list",
    });
  }
  const dup = (existingList.filter ?? []).find((f) => {
    const c = f.criteria ?? {};
    const a = f.action ?? {};
    return (
      (c.from ?? undefined) === (criteria.from ?? undefined) &&
      (c.to ?? undefined) === (criteria.to ?? undefined) &&
      (c.subject ?? undefined) === (criteria.subject ?? undefined) &&
      (c.query ?? undefined) === (criteria.query ?? undefined) &&
      Boolean(c.hasAttachment) === Boolean(criteria.hasAttachment) &&
      sameIdSet(a.addLabelIds, addLabelIds) &&
      sameIdSet(a.removeLabelIds, removeLabelIds) &&
      (a.forward ?? undefined) === (flags.forward ?? undefined)
    );
  });
  if (dup) {
    return renderObject({
      action: "exists",
      account,
      filter: {
        id: dup.id ?? "",
        criteria: criteriaSummary(dup.criteria),
        action: actionSummary(dup.action, labels),
      },
    });
  }

  let created: gmail_v1.Schema$Filter;
  try {
    const res = await api.users.settings.filters.create({
      userId: "me",
      requestBody: { criteria, action },
    });
    created = res.data;
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.settings.filters.create",
    });
  }

  return joinBlocks(
    renderObject({
      action: "created",
      account,
      filter: {
        id: created.id ?? "",
        criteria: criteriaSummary(created.criteria ?? criteria),
        action: actionSummary(created.action ?? action, labels),
      },
    }),
    renderHelp([
      "Filters only apply to NEW incoming mail — existing matches are unaffected",
      `To label existing mail too, run \`gws-axi gmail batch-modify --query ...\``,
    ]),
  );
}

export async function gmailFilterDeleteCommand(
  account: string,
  args: string[],
): Promise<string> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    throw new AxiError("Missing filter id argument", "VALIDATION_ERROR", [
      "Usage: gws-axi gmail filter-delete <filter-id>",
      "List ids with `gws-axi gmail filter-list`",
    ]);
  }

  const api = await gmailClient(account);
  try {
    await api.users.settings.filters.delete({ userId: "me", id });
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "gmail.settings.filters.delete",
    });
    if (translated.code === "NOT_FOUND") {
      return renderObject({
        action: "noop",
        account,
        filter_id: id,
        reason: "filter not found (already deleted or never existed)",
      });
    }
    throw translated;
  }

  return renderObject({ action: "deleted", account, filter_id: id });
}
