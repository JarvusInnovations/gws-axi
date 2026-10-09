import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";
import { field, renderList } from "../../output/index.js";
import type { FlagSpec, ParsedArgs } from "../../util/flags.js";

/**
 * Tab-shape helpers shared across services. `drive upload --update` needs to
 * know whether a Doc target is multi-tab *before* it replaces the content
 * (Drive's import collapses a doc to a single tab), and it needs that answer
 * without paying for the document body. `docs tabs` and `docs write --new-tab`
 * need the full property set (specs/commands/docs-tabs.md) and the placement
 * arithmetic the Docs API leaves to the caller.
 *
 * `docs read` keeps its own `flattenTabs` — it builds display rows (index,
 * parent, active marker) from the fully-populated tabs it already fetched,
 * which is a different job than counting.
 */

/** Every mutable tab property plus the id — what `docs tabs` lists. */
export const TAB_PROPERTIES_MASK = "tabProperties(tabId,title,index,parentTabId,iconEmoji)";

/**
 * Field mask for a tab-count fetch: tab identity only, no `documentTab` body.
 * Masked three levels deep — Docs nests tabs, and an unqualified `childTabs`
 * would pull each subtree's full content back into the response.
 *
 * A tree deeper than three levels would under-report the *count*, but cannot
 * change the multi-tab verdict: any tab at depth 4 implies ancestors at every
 * shallower level, so the total is already >1.
 */
const TAB_COUNT_FIELDS =
  "tabs(tabProperties(tabId,title),childTabs(tabProperties(tabId,title),childTabs(tabProperties(tabId,title))))";

/** The same three-level mask with every property (`docs tabs`, `--new-tab` placement). */
export const TAB_TREE_FIELDS = `tabs(${TAB_PROPERTIES_MASK},childTabs(${TAB_PROPERTIES_MASK},childTabs(${TAB_PROPERTIES_MASK})))`;

export interface TabSummary {
  id: string;
  title: string;
}

/** A tab's properties as the API holds them; `index` is within `parent`. */
export interface TabInfo extends TabSummary {
  index: number;
  /** Parent tab id; "" at the top level. */
  parent: string;
  /** The icon emoji; "" when none. */
  emoji: string;
}

/** Flatten a tab tree (root tabs + nested `childTabs`) into id/title pairs. */
export function flattenTabSummaries(tabs: docs_v1.Schema$Tab[] | undefined): TabSummary[] {
  const out: TabSummary[] = [];
  for (const tab of tabs ?? []) {
    const props = tab.tabProperties ?? {};
    out.push({ id: props.tabId ?? "", title: props.title ?? "" });
    if (tab.childTabs?.length) out.push(...flattenTabSummaries(tab.childTabs));
  }
  return out;
}

/** Flatten a tab tree depth-first, in document order, with every property. */
export function flattenTabInfos(
  tabs: docs_v1.Schema$Tab[] | undefined,
  parent = "",
  out: TabInfo[] = [],
): TabInfo[] {
  (tabs ?? []).forEach((tab, position) => {
    const props = tab.tabProperties ?? {};
    out.push({
      id: props.tabId ?? "",
      title: props.title ?? "",
      index: props.index ?? position,
      parent: props.parentTabId ?? parent,
      emoji: props.iconEmoji ?? "",
    });
    if (tab.childTabs?.length) flattenTabInfos(tab.childTabs, props.tabId ?? "", out);
  });
  return out;
}

/** `tabs[N]{id,title,index,parent,emoji}` — the listing every tab response carries. */
export function renderTabListing(tabs: TabInfo[]): string {
  return renderList("tabs", tabs as unknown as Array<Record<string, unknown>>, [
    field("id"),
    field("title"),
    field("index"),
    field("parent"),
    field("emoji"),
  ]);
}

/** Ids of every tab below `id`, at any depth. */
export function descendantIds(tabs: TabInfo[], id: string): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const tab of tabs) {
      if (tab.parent === parent) {
        out.push(tab.id);
        walk(tab.id);
      }
    }
  };
  walk(id);
  return out;
}

/**
 * List a Doc's tabs (identity only). Returns `[]` when the API reports no tabs
 * at all — callers treat "unknown" as "not multi-tab" rather than blocking a
 * write on a missing field.
 */
export async function listDocumentTabs(account: string, documentId: string): Promise<TabSummary[]> {
  const docs = await docsClient(account);
  try {
    const res = await docs.documents.get({
      documentId,
      includeTabsContent: true,
      fields: TAB_COUNT_FIELDS,
    });
    return flattenTabSummaries(res.data.tabs ?? undefined);
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "docs.documents.get" });
  }
}

// ---------------------------------------------------------------------------
// Placement — one vocabulary for `docs write --new-tab` and `docs tabs update`

export const PLACEMENT_VALUE_FLAGS = ["--before", "--after", "--under"] as const;
export const PLACEMENT_BOOLEAN_FLAGS = ["--first", "--last", "--top-level"] as const;

/** The placement flags as given; `undefined` when none were. */
export interface Placement {
  first?: boolean;
  last?: boolean;
  before?: string;
  after?: string;
  under?: string;
  topLevel?: boolean;
}

/** Where a tab should go, in the API's terms. */
export interface ResolvedPlacement {
  parent: string;
  index: number;
}

/**
 * Pull the placement flags out of a parsed command line, enforcing the
 * exclusions: one of first/last/before/after, and `--under` / `--top-level`
 * only with first/last (an anchor decides its own parent).
 */
export function parsePlacement(parsed: ParsedArgs): Placement | undefined {
  const p: Placement = {
    first: parsed.booleans.has("--first") || undefined,
    last: parsed.booleans.has("--last") || undefined,
    before: parsed.values["--before"],
    after: parsed.values["--after"],
    under: parsed.values["--under"],
    topLevel: parsed.booleans.has("--top-level") || undefined,
  };
  const positions = [
    p.first && "--first",
    p.last && "--last",
    p.before && "--before",
    p.after && "--after",
  ].filter(Boolean);
  if (positions.length > 1) {
    throw new AxiError(`${positions.join(" and ")} are mutually exclusive`, "VALIDATION_ERROR", [
      "Pick one position: --first, --last, --before <tabId>, or --after <tabId>",
    ]);
  }
  if (p.under && p.topLevel) {
    throw new AxiError("--under and --top-level are mutually exclusive", "VALIDATION_ERROR", [
      "--under <tabId> nests the tab; --top-level un-nests it. Pick one",
    ]);
  }
  if ((p.under || p.topLevel) && (p.before || p.after)) {
    throw new AxiError(
      `--${p.under ? "under" : "top-level"} cannot be combined with --${p.before ? "before" : "after"}`,
      "VALIDATION_ERROR",
      [
        "--before/--after place the tab next to the anchor, in the anchor's parent — the anchor decides the level",
        "Combine --under/--top-level with --first or --last instead",
      ],
    );
  }
  if (!p.first && !p.last && !p.before && !p.after && !p.under && !p.topLevel) return undefined;
  return p;
}

function tabNotFound(which: string, id: string, tabs: TabInfo[]): AxiError {
  return new AxiError(`${which} '${id}' names no tab in this document`, "TAB_NOT_FOUND", [
    renderTabListing(tabs),
    "Pass one of the ids above",
  ]);
}

/**
 * Turn placement flags into the `index`/`parentTabId` to send.
 *
 * The Docs API's `index` means "insert before the tab currently at this
 * position in the parent" (observed; specs/commands/docs-tabs.md § Upstream),
 * so `--before X` is `X.index`, `--after X` is `X.index + 1`, and `--last` is
 * the parent's sibling count — counting the moving tab itself when it is
 * already there — with no adjustment for which direction it moves.
 *
 * Returns `"unchanged"` when `moving` already sits where the flags describe.
 */
export function resolvePlacement(
  placement: Placement,
  tabs: TabInfo[],
  moving?: TabInfo,
): ResolvedPlacement | "unchanged" {
  const forbidden = moving
    ? new Set([moving.id, ...descendantIds(tabs, moving.id)])
    : new Set<string>();
  const anchorId = placement.before ?? placement.after;
  if (anchorId !== undefined) {
    const anchor = tabs.find((t) => t.id === anchorId);
    if (!anchor) throw tabNotFound(placement.before ? "--before" : "--after", anchorId, tabs);
    if (forbidden.has(anchorId))
      throw cycle(placement.before ? "--before" : "--after", anchorId, moving!);
    const already = placement.after ? anchor.index + 1 : anchor.index - 1;
    if (moving && moving.parent === anchor.parent && moving.index === already) return "unchanged";
    return { parent: anchor.parent, index: anchor.index + (placement.after ? 1 : 0) };
  }

  let parent: string;
  if (placement.under !== undefined) {
    if (!tabs.some((t) => t.id === placement.under))
      throw tabNotFound("--under", placement.under, tabs);
    if (forbidden.has(placement.under)) throw cycle("--under", placement.under, moving!);
    parent = placement.under;
  } else if (placement.topLevel) {
    parent = "";
  } else {
    parent = moving?.parent ?? "";
  }
  const siblings = tabs.filter((t) => t.parent === parent);
  if (placement.first) {
    if (moving && moving.parent === parent && moving.index === 0) return "unchanged";
    return { parent, index: 0 };
  }
  if (moving && moving.parent === parent && moving.index === siblings.length - 1)
    return "unchanged";
  return { parent, index: siblings.length };
}

function cycle(flag: string, id: string, moving: TabInfo): AxiError {
  const self = id === moving.id;
  return new AxiError(
    self
      ? `${flag} ${id} names the tab being moved`
      : `${flag} ${id} is nested under ${moving.id} — a tab can't be placed inside its own subtree`,
    "TAB_CYCLE",
    [
      self
        ? "Anchor on a different tab"
        : "Move the child out first, or pick an anchor outside the subtree",
    ],
  );
}

/** The flag declaration both placement-taking commands build on. */
export const PLACEMENT_FLAGS: FlagSpec = {
  value: [...PLACEMENT_VALUE_FLAGS],
  boolean: [...PLACEMENT_BOOLEAN_FLAGS],
};
