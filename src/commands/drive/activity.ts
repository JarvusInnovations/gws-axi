import { AxiError } from "axi-sdk-js";
import { oauthClientForAccount, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { parseDateishFlag } from "../calendar/dateish.js";

export const ACTIVITY_HELP = `usage: gws-axi drive activity <itemId> [flags]
args[1]:
  <itemId>             A Drive file or folder ID (the portion of the URL
                       after /d/ or /folders/)
flags[5]:
  --folder             Treat <itemId> as a folder: report activity for it and
                       all descendants (ancestorName), not just the item itself
  --since <date>       Only activity at/after this time (ISO or YYYY-MM-DD)
  --until <date>       Only activity before this time (ISO or YYYY-MM-DD)
  --action <list>      Comma-separated action types to include: create, edit,
                       move, rename, delete, restore, permission_change,
                       comment
  --limit <n>          Max activities to return, newest first (default: 50)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi drive activity 1V09rp...
  gws-axi drive activity 1AbCfolder... --folder --action permission_change,delete
  gws-axi drive activity 1V09rp... --since 2026-01-01 --until 2026-04-01
output:
  An \`item{id,scope}\` header followed by an \`activities[N]{time,action,actor,target}\`
  list, newest first. Actions cover create/edit/move/rename/delete/restore,
  permission changes, and comments — richer than \`drive revisions\` (content
  versions only).
notes:
  Requires the drive.activity.readonly scope (read-only). Accounts authorized
  before this command shipped must re-auth once: \`gws-axi auth login --account
  <email>\`. Results are limited to activity visible to the authenticated
  account — items never shared with it contribute no history. Actors are
  reported best-effort; some (anonymous/deleted/unknown) cannot be identified.
`;

const DEFAULT_LIMIT = 50;
const ACTIVITY_ENDPOINT = "https://driveactivity.googleapis.com/v2/activity:query";

// Map our friendly --action tokens to the API's action_detail_case enum.
const ACTION_FILTER_MAP: Record<string, string> = {
  create: "CREATE",
  edit: "EDIT",
  move: "MOVE",
  rename: "RENAME",
  delete: "DELETE",
  restore: "RESTORE",
  permission_change: "PERMISSION_CHANGE",
  comment: "COMMENT",
};

// Map the API's actionDetail object key to a short label for output.
const ACTION_LABELS: Record<string, string> = {
  create: "create",
  edit: "edit",
  move: "move",
  rename: "rename",
  delete: "delete",
  restore: "restore",
  permissionChange: "permission_change",
  comment: "comment",
  dlpChange: "dlp_change",
  reference: "reference",
  settingsChange: "settings_change",
  appliedLabelChange: "applied_label_change",
};

interface ParsedFlags {
  itemId: string;
  folder: boolean;
  since: string | undefined;
  until: string | undefined;
  actions: string[];
  limit: number;
}

export function parseFlags(args: string[]): ParsedFlags {
  let itemId: string | undefined;
  let folder = false;
  let since: string | undefined;
  let until: string | undefined;
  let actions: string[] = [];
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--folder":
      case "--recursive":
        folder = true;
        break;
      case "--since":
        since = parseDateishFlag(next);
        i++;
        break;
      case "--until":
        until = parseDateishFlag(next);
        i++;
        break;
      case "--action":
        actions = (next ?? "")
          .split(",")
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean);
        i++;
        break;
      case "--limit":
        limit = Math.max(1, parseInt(next, 10) || DEFAULT_LIMIT);
        i++;
        break;
      default:
        if (!arg.startsWith("--") && itemId === undefined) {
          itemId = arg;
        }
    }
  }
  if (!itemId) {
    throw new AxiError("Missing itemId argument", "VALIDATION_ERROR", [
      "Usage: gws-axi drive activity <itemId>",
      "Get a file/folder ID from `gws-axi drive search` or `gws-axi drive ls`",
    ]);
  }
  // Validate action tokens early so a typo doesn't silently match nothing.
  for (const a of actions) {
    if (!ACTION_FILTER_MAP[a]) {
      throw new AxiError(`Unknown --action type: ${a}`, "VALIDATION_ERROR", [
        `Valid types: ${Object.keys(ACTION_FILTER_MAP).join(", ")}`,
      ]);
    }
  }
  return { itemId, folder, since, until, actions, limit };
}

/** Build the `filter` string for the Activity query from time + action flags. */
export function buildFilter(flags: ParsedFlags): string {
  const clauses: string[] = [];
  if (flags.since) clauses.push(`time >= "${flags.since}"`);
  if (flags.until) clauses.push(`time < "${flags.until}"`);
  if (flags.actions.length > 0) {
    const cases = flags.actions.map((a) => ACTION_FILTER_MAP[a]).join(" ");
    clauses.push(`detail.action_detail_case:(${cases})`);
  }
  return clauses.join(" AND ");
}

/** The primary action label for an activity's first action with a detail. */
export function primaryActionLabel(activity: Record<string, unknown>): string {
  const actions = (activity.actions as Array<Record<string, unknown>>) ?? [];
  for (const action of actions) {
    const detail = action.detail as Record<string, unknown> | undefined;
    if (!detail) continue;
    for (const key of Object.keys(detail)) {
      if (ACTION_LABELS[key]) return ACTION_LABELS[key];
    }
  }
  // Fall back to the activity-level primaryActionDetail if present.
  const primary = activity.primaryActionDetail as Record<string, unknown> | undefined;
  if (primary) {
    for (const key of Object.keys(primary)) {
      if (ACTION_LABELS[key]) return ACTION_LABELS[key];
    }
  }
  return "unknown";
}

/** Best-effort actor identity from an activity's actors[]. */
export function primaryActor(activity: Record<string, unknown>): string {
  const actors = (activity.actors as Array<Record<string, unknown>>) ?? [];
  for (const actor of actors) {
    const user = actor.user as Record<string, unknown> | undefined;
    if (user) {
      const known = user.knownUser as Record<string, unknown> | undefined;
      if (known?.personName) return String(known.personName);
      if (user.deletedUser) return "deleted-user";
      if (user.unknownUser) return "unknown-user";
    }
    if (actor.anonymous) return "anonymous";
    if (actor.impersonation) return "impersonation";
    if (actor.administrator) return "administrator";
    if (actor.system) return "system";
  }
  return "unknown";
}

/**
 * Best-effort target label from an activity's targets[]. Prefers the title,
 * but always keeps the item id reachable (ids-are-first-class): renders
 * "<title> (<id>)" when both are present, the id alone when only it is.
 * driveItem.name has the form "items/<id>".
 */
export function primaryTarget(activity: Record<string, unknown>): string {
  const targets = (activity.targets as Array<Record<string, unknown>>) ?? [];
  for (const target of targets) {
    const item = target.driveItem as Record<string, unknown> | undefined;
    if (item) {
      const title = item.title ? String(item.title) : "";
      const id = item.name ? String(item.name).replace(/^items\//, "") : "";
      if (title && id) return `${title} (${id})`;
      if (title) return title;
      if (id) return id;
    }
    const drive = target.drive as Record<string, unknown> | undefined;
    if (drive?.title) return String(drive.title);
    const comment = target.fileComment as Record<string, unknown> | undefined;
    if (comment) return "(comment)";
  }
  return "";
}

/** The timestamp (or end of timeRange) for an activity. */
function activityTime(activity: Record<string, unknown>): string {
  if (typeof activity.timestamp === "string") return activity.timestamp;
  const range = activity.timeRange as Record<string, unknown> | undefined;
  if (range?.endTime) return String(range.endTime);
  return "";
}

interface ActivityRow {
  time: string;
  action: string;
  actor: string;
  target: string;
}

export async function driveActivityCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);

  const requestBody: Record<string, unknown> = flags.folder
    ? { ancestorName: `items/${flags.itemId}` }
    : { itemName: `items/${flags.itemId}` };
  const filter = buildFilter(flags);
  if (filter) requestBody.filter = filter;
  requestBody.pageSize = Math.min(flags.limit, 100);

  const auth = await oauthClientForAccount(account);
  const { token } = await auth.getAccessToken();

  // Paginate until we have `limit` rows or run out.
  const activities: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  try {
    do {
      const body = pageToken ? { ...requestBody, pageToken } : requestBody;
      const resp = await fetch(ACTIVITY_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw await activityError(resp, account);
      }
      const data = (await resp.json()) as {
        activities?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      };
      activities.push(...(data.activities ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken && activities.length < flags.limit);
  } catch (err) {
    if (err instanceof AxiError) throw err;
    throw translateGoogleError(err, {
      account,
      operation: "driveactivity.activity.query",
    });
  }

  const rows: ActivityRow[] = activities.slice(0, flags.limit).map((a) => ({
    time: activityTime(a),
    action: primaryActionLabel(a),
    actor: primaryActor(a),
    target: primaryTarget(a),
  }));
  // Newest-first.
  rows.sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));

  const blocks: string[] = [];
  blocks.push(renderObject({ account }));
  blocks.push(
    renderObject({
      item: { id: flags.itemId, scope: flags.folder ? "ancestor" : "item" },
    }),
  );

  if (rows.length === 0) {
    blocks.push(renderObject({ activities: "0 activities found" }));
  } else {
    blocks.push(
      renderList("activities", rows as unknown as Array<Record<string, unknown>>, [
        field("time"),
        field("action"),
        field("actor"),
        field("target"),
      ]),
    );
  }

  blocks.push(
    renderObject({
      note: "Limited to activity visible to this account — items never shared with it contribute no history. Actors are best-effort; some cannot be identified.",
    }),
  );

  const suggestions: string[] = [];
  if (flags.folder) {
    // Already broad — point at narrowing levers instead of widening.
    if (flags.actions.length === 0) {
      suggestions.push("Narrow by action type, e.g. `--action permission_change,delete`");
    }
  } else {
    suggestions.push(
      `Widen to a folder's whole subtree: \`gws-axi drive activity ${flags.itemId} --folder\``,
    );
  }
  if (!flags.since && !flags.until) {
    suggestions.push("Bound the window with `--since <date>` / `--until <date>`");
  }
  suggestions.push(
    `Fetch an item surfaced here: \`gws-axi drive get <id>\` or \`gws-axi docs download <id>\``,
  );
  suggestions.push(
    `Cross-reference content versions with \`gws-axi drive revisions ${flags.itemId}\``,
  );
  blocks.push(renderHelp(suggestions));
  return joinBlocks(...blocks);
}

async function activityError(resp: Response, account: string): Promise<AxiError> {
  let message = `HTTP ${resp.status}`;
  try {
    const body = (await resp.json()) as {
      error?: { message?: string; status?: string };
    };
    if (body.error?.message) message = body.error.message;
  } catch {
    // keep the status-only message
  }
  if (resp.status === 401) {
    return new AxiError(
      `Authentication failed for ${account} — token revoked or expired`,
      "TOKEN_INVALID",
      [`Run \`gws-axi auth login --account ${account}\` to re-authenticate`],
    );
  }
  if (resp.status === 403) {
    if (/scope|insufficient|permission/i.test(message)) {
      return new AxiError(
        `Missing the drive.activity.readonly scope for ${account}`,
        "INSUFFICIENT_SCOPE",
        [
          `Re-authenticate to grant it: \`gws-axi auth login --account ${account}\``,
          "This scope was added with the `drive activity` command; pre-existing accounts must re-auth once",
        ],
      );
    }
    if (/disabled|not enabled|has not been used/i.test(message)) {
      return new AxiError(
        "The Drive Activity API is not enabled for this project",
        "API_NOT_ENABLED",
        ["Enable driveactivity.googleapis.com — run `gws-axi auth setup` to re-check/enable APIs"],
      );
    }
    return new AxiError(`403 forbidden — ${message}`, "PERMISSION_DENIED", []);
  }
  if (resp.status === 404) {
    return new AxiError(`Item not found, or ${account} has no access to it`, "NOT_FOUND", [
      "Verify the file/folder ID",
      `Confirm ${account} can see the item`,
    ]);
  }
  return new AxiError(`${resp.status} — ${message}`, "API_ERROR", []);
}
