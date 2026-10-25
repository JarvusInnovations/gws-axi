import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiError } from "axi-sdk-js";

/**
 * `sheets tabs update` / `sheets tabs delete` against a mocked Sheets client:
 * the requests sent, that `unchanged` sends nothing, how the delete's error
 * scan is wired, and what a failed read-back reports.
 */

const get = vi.fn();
const batchUpdate = vi.fn();
const valuesGet = vi.fn();

vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../google/client.js")>()),
  sheetsClient: async () => ({
    spreadsheets: { get, batchUpdate, values: { get: valuesGet } },
  }),
}));

const { sheetsTabsUpdateCommand, sheetsTabsDeleteCommand } = await import("./tabs.js");

const ID = "1AbC";
const ACCOUNT = "alice@example.com";

interface Sheet {
  sheetId: number;
  title: string;
  sheetType?: string;
  hidden?: boolean;
  gridProperties?: { rowCount: number; columnCount: number; frozenRowCount?: number };
}

const GRID = { rowCount: 10, columnCount: 4 };
const ref = (message: string) => ({ effectiveValue: { errorValue: { type: "REF", message } } });

/**
 * A spreadsheet whose property reads return `sheets` (then `afterSheets`, once
 * a batchUpdate has gone through), and whose errors-only scans return
 * `scans[n]` in order (or throw it, when it is an Error).
 */
function spreadsheet(opts: {
  sheets: Sheet[];
  afterSheets?: Sheet[];
  scans?: Array<unknown[] | Error>;
}) {
  let scan = 0;
  get.mockImplementation(async (req: { includeGridData?: boolean; ranges?: string[] }) => {
    if (req.includeGridData && !req.ranges) {
      const next = opts.scans?.[scan++] ?? [];
      if (next instanceof Error) throw next;
      return { data: { sheets: next } };
    }
    if (req.includeGridData) return { data: { sheets: [] } };
    const sent = batchUpdate.mock.calls.length > 0;
    const list = sent && opts.afterSheets ? opts.afterSheets : opts.sheets;
    return {
      data: {
        spreadsheetId: ID,
        properties: { title: "Q4 Tracker" },
        sheets: list.map((p, index) => ({ properties: { index, ...p } })),
      },
    };
  });
}

beforeEach(() => {
  get.mockReset();
  batchUpdate.mockReset();
  valuesGet.mockReset();
  batchUpdate.mockResolvedValue({ status: 200, data: { replies: [{}] } });
  valuesGet.mockResolvedValue({
    data: {
      values: [
        ["a", "b"],
        ["1", ""],
      ],
    },
  });
});

describe("sheetsTabsUpdateCommand", () => {
  it("sends nothing when the tab already matches", async () => {
    spreadsheet({
      sheets: [
        { sheetId: 0, title: "Costs", gridProperties: { ...GRID, frozenRowCount: 1 } },
        { sheetId: 5, title: "Notes", gridProperties: GRID },
      ],
    });
    const out = await sheetsTabsUpdateCommand(ACCOUNT, [
      ID,
      "Notes",
      "--after",
      "Costs",
      "--title",
      "Notes",
      "--show",
      "--freeze-rows",
      "0",
    ]);
    expect(out).toContain("action: unchanged");
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("names the tab by title in the undo line when a title spells its gid", async () => {
    const sheets = [
      { sheetId: 0, title: "Costs", gridProperties: GRID },
      { sheetId: 55, title: "0", gridProperties: GRID },
    ];
    spreadsheet({ sheets, afterSheets: [{ ...sheets[0], hidden: true }, sheets[1]] });
    const out = await sheetsTabsUpdateCommand(ACCOUNT, [ID, "Costs", "--hide"]);
    expect(out).toContain(`gws-axi sheets tabs update ${ID} Costs --show --account ${ACCOUNT}`);
    expect(batchUpdate.mock.calls[0][0].requestBody.requests[0].updateSheetProperties).toEqual({
      properties: { sheetId: 0, hidden: true },
      fields: "hidden",
    });
  });

  it("refuses a selector that is one sheet's title and another's gid, writing nothing", async () => {
    spreadsheet({
      sheets: [
        { sheetId: 0, title: "Costs", gridProperties: GRID },
        { sheetId: 55, title: "0", gridProperties: GRID },
      ],
    });
    let code = "none";
    try {
      await sheetsTabsUpdateCommand(ACCOUNT, [ID, "0", "--first"]);
    } catch (err) {
      code = (err as AxiError).code;
    }
    expect(code).toBe("VALIDATION_ERROR");
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe("sheetsTabsDeleteCommand", () => {
  const sheets: Sheet[] = [
    { sheetId: 0, title: "Costs", gridProperties: GRID },
    { sheetId: 882013, title: "Archive", gridProperties: GRID },
    { sheetId: 1190021, title: "Chart1", sheetType: "OBJECT" },
  ];
  const remaining = sheets.filter((s) => s.sheetId !== 882013);

  it("deletes the target's gid, leaving it out of the before-scan only", async () => {
    spreadsheet({
      sheets,
      afterSheets: remaining,
      scans: [
        [
          { properties: { sheetId: 0, title: "Costs" }, data: [{ rowData: [{ values: [{}] }] }] },
          {
            properties: { sheetId: 882013, title: "Archive" },
            data: [{ rowData: [{ values: [ref("own error")] }] }],
          },
        ],
        [
          {
            properties: { sheetId: 0, title: "Costs" },
            data: [
              { startRow: 1, rowData: [{ values: [ref("Unresolved sheet name 'Archive'.")] }] },
            ],
          },
        ],
      ],
    });
    const out = await sheetsTabsDeleteCommand(ACCOUNT, [ID, "Archive"]);
    expect(batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
      { deleteSheet: { sheetId: 882013 } },
    ]);
    expect(out).toContain("action: deleted");
    expect(out).toContain("cells: 3");
    // The deleted tab's own error is not "fixed"; the new #REF! is reported.
    expect(out).not.toContain("errors_fixed");
    expect(out).toContain("Costs!A2,REF,Unresolved sheet name 'Archive'.,no");
  });

  it("still reports the delete when the read-back fails, with error_scan: failed", async () => {
    spreadsheet({ sheets, afterSheets: remaining, scans: [[], new Error("socket hang up")] });
    const out = await sheetsTabsDeleteCommand(ACCOUNT, [ID, "Archive"]);
    expect(out).toContain("action: deleted");
    expect(out).toContain("error_scan: failed");
  });

  it("omits cells for a chart sheet and never reads its values", async () => {
    spreadsheet({ sheets, afterSheets: sheets.slice(0, 2) });
    const out = await sheetsTabsDeleteCommand(ACCOUNT, [ID, "Chart1"]);
    expect(batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
      { deleteSheet: { sheetId: 1190021 } },
    ]);
    expect(out).toContain("kind: chart");
    expect(out).not.toContain("cells:");
    expect(valuesGet).not.toHaveBeenCalled();
  });

  it("does not count the cells of a tab past the bound", async () => {
    const big = [
      { sheetId: 0, title: "Costs", gridProperties: GRID },
      { sheetId: 9, title: "Huge", gridProperties: { rowCount: 10000, columnCount: 26 } },
    ];
    spreadsheet({ sheets: big, afterSheets: big.slice(0, 1) });
    const out = await sheetsTabsDeleteCommand(ACCOUNT, [ID, "Huge"]);
    expect(out).toContain("cells: not counted (tab is 10000×26)");
    expect(out).toContain("error_scan: skipped (spreadsheet is 260040 cells)");
    expect(valuesGet).not.toHaveBeenCalled();
  });
});
