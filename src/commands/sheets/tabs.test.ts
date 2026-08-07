import { describe, expect, it } from "vitest";
import type { TabSummary } from "../docs/tabs.js";

/**
 * `listSpreadsheetSheets` itself is a thin API call; what's worth pinning is
 * the shape it maps into, since `drive upload`'s guard counts and labels these
 * uniformly with a Doc's tabs.
 */
function mapSheets(
  sheets: Array<{ properties?: { sheetId?: number | null; title?: string | null } }>,
): TabSummary[] {
  return sheets.map((sheet) => ({
    id: sheet.properties?.sheetId != null ? String(sheet.properties.sheetId) : "",
    title: sheet.properties?.title ?? "",
  }));
}

describe("spreadsheet sheet summaries", () => {
  it("maps sheetId/title into the shared TabSummary shape", () => {
    expect(
      mapSheets([
        { properties: { sheetId: 0, title: "Sheet1" } },
        { properties: { sheetId: 283081854, title: "Second" } },
      ]),
    ).toEqual([
      { id: "0", title: "Sheet1" },
      { id: "283081854", title: "Second" },
    ]);
  });

  it('keeps sheetId 0 as "0" rather than dropping it as falsy', () => {
    // gid 0 is the default first sheet — a `||` fallback would blank it.
    expect(mapSheets([{ properties: { sheetId: 0, title: "Sheet1" } }])[0].id).toBe("0");
  });

  it("tolerates missing properties without dropping the sheet from the count", () => {
    expect(mapSheets([{}, { properties: {} }])).toEqual([
      { id: "", title: "" },
      { id: "", title: "" },
    ]);
  });
});
