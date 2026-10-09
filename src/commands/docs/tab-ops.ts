import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import {
  PLACEMENT_FLAGS,
  type Placement,
  type TabInfo,
  descendantIds,
  describeTabs,
  parsePlacement,
  renderTabListing,
  resolvePlacement,
} from "./tabs.js";
import {
  type DocState,
  type TabTarget,
  batch,
  paragraphSpacingRequest,
  readState,
} from "./write.js";

/**
 * `docs tabs`, `docs tabs update`, `docs tabs delete`
 * (specs/commands/docs-tabs.md). Tabs as objects: list, move/rename/mark,
 * delete. The placement flags are the ones `docs write --new-tab` takes.
 */

export const TABS_HELP = `usage: gws-axi docs tabs <documentId> [flags]
       gws-axi docs tabs update <documentId> <tabId> [--title <title>] [--emoji <emoji> | --no-emoji] [placement] [flags]
       gws-axi docs tabs delete <documentId> <tabId> [--with-children] [flags]
args[1]:
  <documentId>         The Doc whose tabs to list
flags[1]:
  --account <email>    Account to read with (default: the default account)
examples:
  gws-axi docs tabs 1BxAbc...
  gws-axi docs tabs update 1BxAbc... t.k3j2 --first --account you@example.com
  gws-axi docs tabs delete 1BxAbc... t.k3j2 --account you@example.com
notes:
  Lists every tab with its id, title, index within its parent, parent, and
  emoji — properties only, no content, so it is cheap on a long Doc. The id is
  what every other docs command takes for --tab. \`docs tabs update --help\` and
  \`docs tabs delete --help\` describe the writes.
`;

export const TABS_UPDATE_HELP = `usage: gws-axi docs tabs update <documentId> <tabId> [--title <title>] [--emoji <emoji> | --no-emoji] [--first | --last | --before <tabId> | --after <tabId>] [--under <tabId> | --top-level] [flags]
args[2]:
  <documentId>         The Doc
  <tabId>              The tab to change (id as \`docs tabs\` lists it)
flags[10]:
  --title <title>      Rename the tab
  --emoji <emoji>      Set the tab's icon (one emoji)
  --no-emoji           Clear the icon
  --paragraph-spacing <pt>
                       Space after every Normal-text paragraph in the tab (the
                       tab's Normal text style); 0 removes it. Docs' default is 10
  --first              Move to the start of its parent (or of --under / --top-level)
  --last               Move to the end of its parent (or of --under / --top-level)
  --before <tabId>     Move next to an existing tab, into that tab's parent —
  --after <tabId>      this nests or un-nests when the anchor is at another level
  --under <tabId>      Nest as a child of that tab (last child, or --first)
  --top-level          Un-nest to the top level (last, or --first)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs tabs update 1BxAbc... t.k3j2 --first --account you@example.com
  gws-axi docs tabs update 1BxAbc... t.k3j2 --title "Round 3 (old)" --emoji ✅ --account you@example.com
  gws-axi docs tabs update 1BxAbc... t.k3j2 --after t.0 --account you@example.com
  gws-axi docs tabs update 1BxAbc... t.k3j2 --under t.0 --account you@example.com
notes:
  One request, every flag combinable. Idempotent: when the tab already matches,
  action: unchanged and nothing is written. The response lists every tab in its
  new order, and an undo line restores what this call changed. Refused if the
  Doc changed since it was read.
`;

export const TABS_DELETE_HELP = `usage: gws-axi docs tabs delete <documentId> <tabId> [--with-children] [flags]
args[2]:
  <documentId>         The Doc
  <tabId>              The tab to delete (id as \`docs tabs\` lists it)
flags[2]:
  --with-children      Also delete the tab's child tabs (refused without it)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs tabs delete 1BxAbc... t.k3j2 --account you@example.com
  gws-axi docs tabs delete 1BxAbc... t.k3j2 --with-children --account you@example.com
notes:
  Removes the tab from the live Doc; its content stays in version history
  (\`docs revisions\`). A Doc's only tab can't be deleted — \`docs write --content ""\`
  empties it instead. The response lists every tab removed and every tab left.
`;

export const TABS_FLAGS: FlagSpec = { value: [], boolean: [] };
export const TABS_UPDATE_FLAGS: FlagSpec = {
  value: ["--title", "--emoji", "--paragraph-spacing", ...(PLACEMENT_FLAGS.value ?? [])],
  boolean: ["--no-emoji", ...(PLACEMENT_FLAGS.boolean ?? [])],
};
export const TABS_DELETE_FLAGS: FlagSpec = { boolean: ["--with-children"] };

// ---------------------------------------------------------------------------
// Shared

function requireDocumentId(positionals: string[], usage: string): string {
  const id = positionals[0];
  if (!id) {
    throw new AxiError("Missing documentId argument", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "The documentId is the portion of the URL after /d/ and before /edit",
    ]);
  }
  return id;
}

function requireTabId(positionals: string[], usage: string): string {
  const id = positionals[1];
  if (!id) {
    throw new AxiError("Missing tabId argument", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "Run `gws-axi docs tabs <documentId>` to see the ids",
    ]);
  }
  if (positionals.length > 2) {
    throw new AxiError(`Unexpected argument: ${positionals[2]}`, "VALIDATION_ERROR", [
      `Usage: ${usage}`,
    ]);
  }
  return id;
}

function findTab(state: DocState, tabId: string): TabTarget {
  const found = state.tabs.find((t) => t.id === tabId);
  if (found) return found;
  throw new AxiError(`Tab '${tabId}' not found in document '${state.id}'`, "TAB_NOT_FOUND", [
    `Available tabs: ${describeTabs(state.tabs)}`,
    `Run \`gws-axi docs tabs ${state.id}\` to see the tabs list`,
  ]);
}

function accountFlag(account: string): string {
  return ` --account ${account}`;
}

/** The five listed properties, without the state's internal fields. */
function tabView(tab: TabInfo & { spaceBelowPt?: number }): Record<string, unknown> {
  return {
    id: tab.id,
    title: tab.title,
    index: tab.index,
    parent: tab.parent,
    emoji: tab.emoji,
    paragraph_spacing: tab.spaceBelowPt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// docs tabs

export async function docsTabsCommand(account: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args, TABS_FLAGS, "docs tabs");
  const first = parsed.positionals[0];
  // A bare lowercase word is a verb someone guessed, never a document id.
  if (first && /^[a-z-]+$/.test(first)) {
    throw new AxiError(`Unknown docs tabs subcommand: ${first}`, "VALIDATION_ERROR", [
      "Valid subcommands: update, delete — or pass a documentId to list its tabs",
      "Run `gws-axi docs tabs --help` for usage",
    ]);
  }
  const documentId = requireDocumentId(parsed.positionals, "gws-axi docs tabs <documentId>");
  if (parsed.positionals.length > 1) {
    throw new AxiError(`Unexpected argument: ${parsed.positionals[1]}`, "VALIDATION_ERROR", [
      "Usage: gws-axi docs tabs <documentId>",
    ]);
  }
  const api = await docsClient(account);
  const state = await readState(api, account, documentId, { properties: true });
  return joinBlocks(
    renderObject({ account }),
    renderObject({ document: { id: state.id, title: state.title, revision_id: state.revisionId } }),
    renderTabListing(state.tabs),
    renderHelp([
      `Run \`gws-axi docs read ${state.id} --tab <id>\` to read one`,
      `Run \`gws-axi docs tabs update ${state.id} <id> --first|--title "<title>"|--emoji <emoji> --account <email>\` to move, rename or mark a tab`,
      `Run \`gws-axi docs tabs delete ${state.id} <id> --account <email>\` to delete one`,
    ]),
  );
}

// ---------------------------------------------------------------------------
// docs tabs update

interface UpdateFlags {
  documentId: string;
  tabId: string;
  title?: string;
  /** `""` clears. */
  emoji?: string;
  placement?: Placement;
  /** Points of space after Normal-text paragraphs; the tab's named style. */
  paragraphSpacing?: number;
}

const UPDATE_USAGE =
  "gws-axi docs tabs update <documentId> <tabId> [--title …] [--emoji …] [placement]";

export function parseUpdateFlags(args: string[]): UpdateFlags {
  const parsed = parseArgs(args, TABS_UPDATE_FLAGS, "docs tabs update");
  const documentId = requireDocumentId(parsed.positionals, UPDATE_USAGE);
  const tabId = requireTabId(parsed.positionals, UPDATE_USAGE);
  const flags: UpdateFlags = { documentId, tabId };
  if (parsed.values["--title"] !== undefined) {
    if (!parsed.values["--title"].trim()) {
      throw new AxiError("--title can't be empty", "VALIDATION_ERROR", ["Pass the tab's new name"]);
    }
    flags.title = parsed.values["--title"];
  }
  if (parsed.values["--emoji"] !== undefined && parsed.booleans.has("--no-emoji")) {
    throw new AxiError("--emoji and --no-emoji are mutually exclusive", "VALIDATION_ERROR", [
      "--emoji sets the icon; --no-emoji clears it. Pick one",
    ]);
  }
  if (parsed.values["--emoji"] !== undefined) flags.emoji = parsed.values["--emoji"];
  if (parsed.booleans.has("--no-emoji")) flags.emoji = "";
  flags.placement = parsePlacement(parsed);
  const spacing = parsed.values["--paragraph-spacing"];
  if (spacing !== undefined) {
    const pt = Number(spacing);
    if (!Number.isFinite(pt) || pt < 0) {
      throw new AxiError(
        `--paragraph-spacing expects points (0 or more), got: ${spacing}`,
        "VALIDATION_ERROR",
        ["Docs' default is 10"],
      );
    }
    flags.paragraphSpacing = pt;
  }
  if (
    flags.title === undefined &&
    flags.emoji === undefined &&
    !flags.placement &&
    flags.paragraphSpacing === undefined
  ) {
    throw new AxiError("Nothing to update: no property flags given", "VALIDATION_ERROR", [
      "Pass --title <title>, --emoji <emoji> / --no-emoji, --paragraph-spacing <pt>, and/or a placement (--first, --last, --before <tabId>, --after <tabId>, --under <tabId>, --top-level)",
      `Run \`gws-axi docs tabs ${documentId}\` to see the tabs`,
    ]);
  }
  return flags;
}

/** The placement that puts `tab` back where it was, as flags. */
function undoPlacement(before: TabInfo, tabs: TabInfo[]): string {
  const predecessor = tabs.find((t) => t.parent === before.parent && t.index === before.index - 1);
  if (predecessor) return `--after ${predecessor.id}`;
  return before.parent ? `--first --under ${before.parent}` : "--first --top-level";
}

export async function docsTabsUpdateCommand(account: string, args: string[]): Promise<string> {
  const flags = parseUpdateFlags(args);
  const api = await docsClient(account);
  const state = await readState(api, account, flags.documentId, { properties: true });
  const before = findTab(state, flags.tabId);

  const props: docs_v1.Schema$TabProperties = { tabId: before.id };
  const fields: string[] = [];
  const changed: string[] = [];
  const undo: string[] = [];

  if (flags.title !== undefined && flags.title !== before.title) {
    props.title = flags.title;
    fields.push("title");
    changed.push("title");
    undo.push(`--title ${JSON.stringify(before.title)}`);
  }
  if (flags.emoji !== undefined && flags.emoji !== before.emoji) {
    if (flags.emoji) props.iconEmoji = flags.emoji;
    fields.push("iconEmoji");
    changed.push("emoji");
    undo.push(before.emoji ? `--emoji ${before.emoji}` : "--no-emoji");
  }
  // The one knob past the tab's properties: its Normal-text style's space-below.
  const extraRequests: docs_v1.Schema$Request[] = [];
  if (
    flags.paragraphSpacing !== undefined &&
    flags.paragraphSpacing !== (before.spaceBelowPt ?? 0)
  ) {
    extraRequests.push(paragraphSpacingRequest(before.id, flags.paragraphSpacing));
    changed.push("paragraph_spacing");
    undo.push(`--paragraph-spacing ${before.spaceBelowPt ?? 0}`);
  }
  if (flags.placement) {
    const placed = resolvePlacement(flags.placement, state.tabs, before);
    if (placed !== "unchanged") {
      props.index = placed.index;
      fields.push("index");
      changed.push("index");
      if (placed.parent !== before.parent) {
        if (placed.parent) props.parentTabId = placed.parent;
        fields.push("parentTabId");
        changed.push("parent");
      }
      undo.push(undoPlacement(before, state.tabs));
    }
  }

  if (!fields.length && !extraRequests.length) {
    return joinBlocks(
      renderObject({ account, action: "unchanged" }),
      renderObject({ tab: tabView(before), revision_id: state.revisionId }),
      renderTabListing(state.tabs),
      renderHelp([`Already as requested; nothing was written`]),
    );
  }

  const reply = await batch(
    api,
    account,
    state.id,
    [
      ...(fields.length
        ? [{ updateDocumentTabProperties: { tabProperties: props, fields: fields.join(",") } }]
        : []),
      ...extraRequests,
    ],
    state.revisionId,
  );
  const after = await readState(api, account, state.id, { properties: true });
  const tab = after.tabs.find((t) => t.id === before.id) ?? before;
  const revisionId = reply.writeControl?.requiredRevisionId ?? after.revisionId;
  return joinBlocks(
    renderObject({ account, action: "updated", changed }),
    renderObject({ tab: tabView(tab), revision_id: revisionId }),
    renderTabListing(after.tabs),
    renderHelp([
      `Run \`gws-axi docs read ${state.id} --tab ${tab.id}\` to read it`,
      `Run \`gws-axi docs tabs update ${state.id} ${tab.id} ${undo.join(" ")}${accountFlag(account)}\` to undo`,
    ]),
  );
}

// ---------------------------------------------------------------------------
// docs tabs delete

const DELETE_USAGE = "gws-axi docs tabs delete <documentId> <tabId> [--with-children]";

export async function docsTabsDeleteCommand(account: string, args: string[]): Promise<string> {
  const parsed = parseArgs(args, TABS_DELETE_FLAGS, "docs tabs delete");
  const documentId = requireDocumentId(parsed.positionals, DELETE_USAGE);
  const tabId = requireTabId(parsed.positionals, DELETE_USAGE);
  const withChildren = parsed.booleans.has("--with-children");

  const api = await docsClient(account);
  const state = await readState(api, account, documentId, { properties: true });
  const target = findTab(state, tabId);
  const children = descendantIds(state.tabs, target.id).map(
    (id) => state.tabs.find((t) => t.id === id)!,
  );
  // A Doc always has a tab: refuse the only tab, or a parent whose subtree is every tab.
  if (children.length + 1 === state.tabs.length) {
    throw new AxiError(
      children.length
        ? `'${target.title}' and its ${children.length} child tab${children.length === 1 ? "" : "s"} are every tab in document '${state.id}' — a Doc can't be left with none`
        : `'${target.title}' is the only tab in document '${state.id}' — it can't be deleted`,
      "LAST_TAB",
      [
        `Run \`gws-axi docs write ${state.id} --tab ${target.id} --content ""${accountFlag(account)}\` to empty it instead`,
        `Run \`gws-axi drive trash ${state.id}${accountFlag(account)}\` to trash the whole Doc`,
      ],
    );
  }
  if (children.length && !withChildren) {
    throw new AxiError(
      `'${target.title}' has ${children.length} child tab${children.length === 1 ? "" : "s"} that would be deleted with it — nothing was deleted`,
      "TAB_HAS_CHILDREN",
      [
        `Child tabs: ${describeTabs(children)}`,
        `Run \`gws-axi docs tabs delete ${state.id} ${target.id} --with-children${accountFlag(account)}\` to delete them too`,
        `Or move them out first: \`gws-axi docs tabs update ${state.id} <childId> --top-level${accountFlag(account)}\``,
      ],
    );
  }

  const reply = await batch(
    api,
    account,
    state.id,
    [{ deleteTab: { tabId: target.id } }],
    state.revisionId,
  );
  const after = await readState(api, account, state.id, { properties: true });
  const removed = [target, ...children];
  return joinBlocks(
    renderObject({ account, action: "deleted" }),
    renderList("deleted", removed as unknown as Array<Record<string, unknown>>, [
      field("id"),
      field("title"),
    ]),
    renderObject({ revision_id: reply.writeControl?.requiredRevisionId ?? after.revisionId }),
    renderTabListing(after.tabs),
    renderHelp([
      `The content is out of the live Doc but stays in version history: \`gws-axi docs revisions ${state.id}\``,
      `Run \`gws-axi docs tabs ${state.id}\` to list what remains`,
    ]),
  );
}
