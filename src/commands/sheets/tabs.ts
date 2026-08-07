import { sheetsClient, translateGoogleError } from "../../google/client.js";
import type { TabSummary } from "../docs/tabs.js";

/**
 * Sheet-listing helper for `drive upload --update`. A spreadsheet's sheets are
 * its tabs (the same framing `sheets read` uses), and replacing a Spreadsheet's
 * content collapses it to a single sheet exactly as a Doc collapses to a single
 * tab — so the guard needs a count before it writes.
 *
 * Shares `TabSummary` with the Docs helper: one shape for "named sub-surface of
 * a container file", so `drive upload` handles both with one code path.
 */

/** Field mask for a sheet-count fetch: identity only, no cell data. */
const SHEET_COUNT_FIELDS = "sheets.properties(sheetId,title)";

/**
 * List a Spreadsheet's sheets (identity only). Returns `[]` when the API
 * reports none — callers treat "unknown" as "not multi-sheet" rather than
 * blocking a write on a missing field.
 */
export async function listSpreadsheetSheets(
  account: string,
  spreadsheetId: string,
): Promise<TabSummary[]> {
  const sheets = await sheetsClient(account);
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: SHEET_COUNT_FIELDS,
    });
    return (res.data.sheets ?? []).map((sheet) => ({
      id: sheet.properties?.sheetId != null ? String(sheet.properties.sheetId) : "",
      title: sheet.properties?.title ?? "",
    }));
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get" });
  }
}
