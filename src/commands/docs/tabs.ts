import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";

/**
 * Tab-shape helpers shared across services. `drive upload --update` needs to
 * know whether a Doc target is multi-tab *before* it replaces the content
 * (Drive's import collapses a doc to a single tab), and it needs that answer
 * without paying for the document body.
 *
 * `docs read` keeps its own `flattenTabs` — it builds display rows (index,
 * parent, active marker) from the fully-populated tabs it already fetched,
 * which is a different job than counting.
 */

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

export interface TabSummary {
  id: string;
  title: string;
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
