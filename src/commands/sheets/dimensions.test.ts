import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiError } from "axi-sdk-js";
import { parseDimensionRange, type TabInfo } from "./shared.js";

// The Google client is the one edge: stubbed so the command tests exercise the
// request built and the response rendered.
const get = vi.fn();
const batchUpdate = vi.fn();
vi.mock("../../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../google/client.js")>()),
  sheetsClient: async () => ({ spreadsheets: { get, batchUpdate } }),
}));

const {
  checkBounds,
  deletedCells,
  dimLabel,
  dimensionCommand,
  dimensionRequests,
  inheritLabel,
  shiftCell,
  shiftErrors,
  shiftedSentence,
  unshiftCell,
} = await import("./dimensions.js");

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const tab = (rows: number, cols: number): TabInfo => ({
  gid: 0,
  title: "Costs",
  index: 0,
  rows,
  cols,
  frozenRows: 0,
});
const ctx = { spreadsheetId: "1AbC", account: "alice@example.com" };

describe("parseDimensionRange", () => {
  it("accepts rows as 3:5, 3, reversed, absolute and tab-qualified", () => {
    expect(parseDimensionRange("3:5", "rows")).toEqual({ kind: "rows", start0: 2, end0: 5 });
    expect(parseDimensionRange("3", "rows")).toEqual({ kind: "rows", start0: 2, end0: 3 });
    expect(parseDimensionRange("5:3", "rows")).toMatchObject({ start0: 2, end0: 5 });
    expect(parseDimensionRange("$3:$5", "rows")).toMatchObject({ start0: 2, end0: 5 });
    expect(parseDimensionRange("Costs!3:5", "rows")).toEqual({
      kind: "rows",
      start0: 2,
      end0: 5,
      tabTitle: "Costs",
    });
    expect(parseDimensionRange("'Q4 Plan'!7", "rows")).toMatchObject({
      start0: 6,
      end0: 7,
      tabTitle: "Q4 Plan",
    });
  });

  it("accepts columns as B:D, B, lower case and past Z", () => {
    expect(parseDimensionRange("B:D", "cols")).toEqual({ kind: "cols", start0: 1, end0: 4 });
    expect(parseDimensionRange("b", "cols")).toEqual({ kind: "cols", start0: 1, end0: 2 });
    expect(parseDimensionRange("AA:AB", "cols")).toMatchObject({ start0: 26, end0: 28 });
    expect(parseDimensionRange("Costs!B", "cols")).toMatchObject({ tabTitle: "Costs" });
  });

  it("refuses the other kind, naming the right verbs", () => {
    expect(() => parseDimensionRange("B:D", "rows")).toThrow(/column range; insert-rows/);
    expect(() => parseDimensionRange("3:5", "cols")).toThrow(/row range; insert-cols/);
  });

  it("refuses cell ranges, mixed forms and junk", () => {
    for (const bad of ["B2:D9", "B2", "3:B", "0", "3:", "", "1:2:3", "ABCD"]) {
      expect(
        codeOf(() => parseDimensionRange(bad, "rows")),
        bad,
      ).toBe("VALIDATION_ERROR");
      expect(
        codeOf(() => parseDimensionRange(bad, "cols")),
        bad,
      ).toBe("VALIDATION_ERROR");
    }
  });
});

describe("dimLabel", () => {
  it("renders one or a span", () => {
    expect(dimLabel("rows", 2, 3)).toBe("3");
    expect(dimLabel("rows", 2, 5)).toBe("3:5");
    expect(dimLabel("cols", 1, 4)).toBe("B:D");
    expect(dimLabel("cols", 26, 27)).toBe("AA");
  });
});

describe("shiftedSentence", () => {
  it("states an insert in old-row terms", () => {
    expect(shiftedSentence("insert", "rows", 2, 5, 1000)).toBe(
      "rows 3 and below moved down by 3 (old row 3 is now row 6)",
    );
    expect(shiftedSentence("insert", "cols", 1, 3, 26)).toBe(
      "columns B and to the right moved right by 2 (old column B is now column D)",
    );
  });

  it("states a delete in old-row terms", () => {
    expect(shiftedSentence("delete", "rows", 2, 5, 1000)).toBe(
      "rows 6 and below moved up by 3 (old row 6 is now row 3)",
    );
    expect(shiftedSentence("delete", "cols", 1, 2, 26)).toBe(
      "columns C and to the right moved left by 1 (old column C is now column B)",
    );
  });

  it("says nothing moved at the end of the grid", () => {
    expect(shiftedSentence("insert", "rows", 1000, 1002, 1000)).toMatch(/^nothing moved/);
    expect(shiftedSentence("delete", "rows", 990, 1000, 1000)).toMatch(/^nothing moved/);
  });
});

describe("checkBounds", () => {
  const rows = (s: number, e: number) => ({ kind: "rows" as const, start0: s, end0: e });
  const cols = (s: number, e: number) => ({ kind: "cols" as const, start0: s, end0: e });

  it("refuses an insert that starts past the allocation, allows one at its end", () => {
    expect(codeOf(() => checkBounds("insert", rows(4999, 5000), tab(1000, 26), ctx))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => checkBounds("insert", rows(1000, 1001), tab(1000, 26), ctx))).toBe("none");
    expect(codeOf(() => checkBounds("insert", rows(0, 1), tab(1000, 26), ctx))).toBe("none");
  });

  it("refuses a delete that starts past or runs past the allocation", () => {
    expect(codeOf(() => checkBounds("delete", rows(1000, 1001), tab(1000, 26), ctx))).toBe(
      "VALIDATION_ERROR",
    );
    expect(() => checkBounds("delete", rows(994, 1010), tab(1000, 26), ctx)).toThrow(
      /runs past the end/,
    );
    expect(codeOf(() => checkBounds("delete", rows(994, 1000), tab(1000, 26), ctx))).toBe("none");
  });

  it("refuses deleting every row or every column", () => {
    expect(() => checkBounds("delete", rows(0, 1000), tab(1000, 26), ctx)).toThrow(/every row/);
    expect(() => checkBounds("delete", cols(0, 26), tab(1000, 26), ctx)).toThrow(/every column/);
    expect(codeOf(() => checkBounds("delete", rows(0, 999), tab(1000, 26), ctx))).toBe("none");
  });

  it("points a past-the-end delete at the range that exists", () => {
    try {
      checkBounds("delete", rows(994, 1010), tab(1000, 26), ctx);
    } catch (err) {
      expect((err as AxiError).suggestions?.[0]).toContain("delete-rows 1AbC 995:1000");
    }
  });
});

describe("cell shifting", () => {
  it("moves cells at or after an insert, leaves earlier ones", () => {
    expect(shiftCell("B2", "insert", "rows", 2, 5)).toBe("B2");
    expect(shiftCell("B3", "insert", "rows", 2, 5)).toBe("B6");
    expect(shiftCell("C9", "insert", "cols", 1, 3)).toBe("E9");
    expect(shiftCell("A9", "insert", "cols", 1, 3)).toBe("A9");
  });

  it("drops deleted cells and moves later ones back", () => {
    expect(shiftCell("B4", "delete", "rows", 2, 5)).toBeUndefined();
    expect(shiftCell("B6", "delete", "rows", 2, 5)).toBe("B3");
    expect(shiftCell("B2", "delete", "rows", 2, 5)).toBe("B2");
    expect(shiftCell("D7", "delete", "cols", 1, 2)).toBe("C7");
  });

  it("inverts: unshiftCell maps a post-call address back", () => {
    expect(unshiftCell("B3", "delete", "rows", 2, 5)).toBe("B6");
    expect(unshiftCell("B6", "insert", "rows", 2, 5)).toBe("B3");
    expect(unshiftCell("B4", "insert", "rows", 2, 5)).toBeUndefined();
    expect(unshiftCell("C7", "delete", "cols", 1, 2)).toBe("D7");
  });

  it("re-keys errors so a moved error is not new", () => {
    const before = new Map([
      ["D12", { cell: "D12", error: "N_A", message: "x" }],
      ["D4", { cell: "D4", error: "REF", message: "y" }],
    ]);
    const after = shiftErrors(before, "delete", "rows", 2, 5);
    expect([...after.keys()]).toEqual(["D9"]);
    expect(after.get("D9")?.cell).toBe("D9");
  });
});

describe("inherit", () => {
  it("inherits from before, or from after at row 1, or clears with --no-inherit", () => {
    expect(inheritLabel("rows", 2, 5, false)).toBe("from row 2");
    expect(inheritLabel("cols", 1, 3, false)).toBe("from column A");
    expect(inheritLabel("rows", 0, 2, false)).toBe("from row 3 (was row 1)");
    expect(inheritLabel("rows", 2, 5, true)).toBe("none");
  });

  it("never sends inheritFromBefore at index 0; --no-inherit adds a format clear", () => {
    const [first] = dimensionRequests("insert", "rows", 7, 0, 1, false);
    expect(first.insertDimension?.inheritFromBefore).toBe(false);
    const both = dimensionRequests("insert", "cols", 7, 1, 3, true);
    expect(both).toHaveLength(2);
    expect(both[0].insertDimension?.inheritFromBefore).toBe(true);
    expect(both[1].repeatCell).toEqual({
      range: { sheetId: 7, startColumnIndex: 1, endColumnIndex: 3 },
      cell: {},
      fields: "userEnteredFormat",
    });
    expect(dimensionRequests("delete", "rows", 7, 2, 5, false)).toEqual([
      { deleteDimension: { range: { sheetId: 7, dimension: "ROWS", startIndex: 2, endIndex: 5 } } },
    ]);
  });
});

describe("deletedCells", () => {
  it("renders populated rows with old row numbers, entered text, empty rows left out", () => {
    const out = deletedCells(
      [
        {
          startRow: 2,
          startColumn: 0,
          rowData: [
            {
              values: [
                { userEnteredValue: { stringValue: "bolts" }, formattedValue: "bolts" },
                { userEnteredValue: { numberValue: 40 }, formattedValue: "40" },
                {},
                { userEnteredValue: { formulaValue: "=B3*C3" }, formattedValue: "$160.00" },
              ],
            },
            { values: [{}, {}] },
            { values: [{ userEnteredValue: { stringValue: "nuts" }, formattedValue: "nuts" }] },
          ],
        },
      ],
      "rows",
      2,
    );
    expect(out.count).toBe(4);
    expect(out.totalRows).toBe(2);
    expect(out.schema.map((f) => f.name)).toEqual(["row", "A", "B", "C", "D"]);
    expect(out.rows).toEqual([
      { row: 3, A: "bolts", B: "40", C: "", D: "=B3*C3" },
      { row: 5, A: "nuts", B: "", C: "", D: "" },
    ]);
  });

  it("letters a column delete from its own column and caps at 50 rows", () => {
    const rowData = Array.from({ length: 60 }, (_, i) => ({
      values: [{ userEnteredValue: { numberValue: i }, formattedValue: String(i) }],
    }));
    const out = deletedCells([{ startRow: 0, startColumn: 3, rowData }], "cols", 3);
    expect(out.schema.map((f) => f.name)).toEqual(["row", "D"]);
    expect(out.rows).toHaveLength(50);
    expect(out.totalRows).toBe(60);
  });

  it("is empty for a range that held nothing", () => {
    expect(deletedCells([], "rows", 0)).toMatchObject({ count: 0, totalRows: 0 });
  });
});

describe("dimensionCommand", () => {
  const META = {
    spreadsheetId: "1AbC",
    properties: { title: "Q4 Tracker" },
    sheets: [
      {
        properties: {
          sheetId: 0,
          title: "Costs",
          index: 0,
          gridProperties: { rowCount: 20, columnCount: 4, frozenRowCount: 1 },
        },
      },
    ],
  };
  const props = (rows: number, frozen: number) => ({
    data: {
      sheets: [
        {
          properties: {
            sheetId: 0,
            gridProperties: { rowCount: rows, columnCount: 4, frozenRowCount: frozen },
          },
        },
      ],
    },
  });
  const grid = (rowData: unknown[]) => ({ data: { sheets: [{ data: [{ rowData }] }] } });

  beforeEach(() => {
    get.mockReset();
    batchUpdate.mockReset();
    batchUpdate.mockResolvedValue({ data: {} });
  });

  it("inserts rows, inheriting from the row above, and reports the shift", async () => {
    let propsCalls = 0;
    get.mockImplementation(async (req: { fields: string; includeGridData?: boolean }) => {
      if (!req.includeGridData && req.fields.startsWith("spreadsheetId")) return { data: META };
      if (!req.includeGridData) return props(propsCalls++ === 0 ? 20 : 23, 1);
      return grid([]);
    });
    const out = await dimensionCommand("alice@example.com", ["1AbC", "3:5"], "insert", "rows");
    expect(batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
      {
        insertDimension: {
          range: { sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 5 },
          inheritFromBefore: true,
        },
      },
    ]);
    expect(out).toContain("action: inserted");
    expect(out).toContain("count: 3");
    expect(out).toContain("shifted: rows 3 and below moved down by 3 (old row 3 is now row 6)");
    expect(out).toContain("inherit: from row 2");
    expect(out).toContain("grid: 23×4");
    expect(out).not.toContain("frozen_rows");
    expect(out).toContain("delete-rows 1AbC 3:5 --tab Costs --account alice@example.com");
    expect(out).toContain("none errored");
  });

  it("deletes rows, carries the removed cells, and names a #REF! by its old formula", async () => {
    let propsCalls = 0;
    let scans = 0;
    get.mockImplementation(async (req: { fields: string; includeGridData?: boolean }) => {
      if (!req.includeGridData && req.fields.startsWith("spreadsheetId")) return { data: META };
      if (!req.includeGridData) return props(propsCalls++ === 0 ? 20 : 19, 1);
      if (req.fields.includes("formattedValue")) {
        return {
          data: {
            sheets: [
              {
                data: [
                  {
                    startRow: 2,
                    rowData: [{ values: [{ userEnteredValue: { stringValue: "bolts" } }] }],
                  },
                ],
              },
            ],
          },
        };
      }
      // Errors + formulas scan: before, D6 reads A3; after, it is D5 and broken.
      const before = scans++ === 0;
      const rows: unknown[] = Array.from({ length: 6 }, () => ({ values: [] }));
      rows[before ? 5 : 4] = {
        values: [
          {},
          {},
          {},
          before
            ? { userEnteredValue: { formulaValue: "=A3" } }
            : {
                userEnteredValue: { formulaValue: "=#REF!" },
                effectiveValue: {
                  errorValue: { type: "REF", message: "Reference does not exist." },
                },
              },
        ],
      };
      return grid(rows);
    });
    const out = await dimensionCommand(
      "alice@example.com",
      ["1AbC", "Costs!3", "--tab", "Costs"],
      "delete",
      "rows",
    );
    expect(batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
      { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 3 } } },
    ]);
    expect(out).toContain("action: deleted");
    expect(out).toContain("errors: 1");
    expect(out).toContain("cells: 1");
    expect(out).toContain("cells[1]{row,A}:\n  3,bolts");
    expect(out).toContain("D5,REF,Reference does not exist.,no");
    expect(out).toContain("it was =A3 (in D6) before the delete, and row 3 is gone");
    expect(out).toContain("Row 3 is now what was row 4 — re-running would delete it");
    expect(out).toContain("insert-rows 1AbC 3 --tab Costs --account alice@example.com");
  });

  it("reports a changed freeze", async () => {
    let propsCalls = 0;
    get.mockImplementation(async (req: { fields: string; includeGridData?: boolean }) => {
      if (!req.includeGridData && req.fields.startsWith("spreadsheetId")) return { data: META };
      if (!req.includeGridData) return propsCalls++ === 0 ? props(20, 1) : props(19, 0);
      return grid([]);
    });
    const out = await dimensionCommand("alice@example.com", ["1AbC", "1"], "delete", "rows");
    expect(out).toContain("frozen_rows: 0");
    expect(out).toContain("cells: 0");
  });

  it("translates a protected range", async () => {
    get.mockImplementation(async (req: { fields: string; includeGridData?: boolean }) => {
      if (!req.includeGridData && req.fields.startsWith("spreadsheetId")) return { data: META };
      if (!req.includeGridData) return props(20, 1);
      return grid([]);
    });
    batchUpdate.mockRejectedValue({
      response: {
        status: 400,
        data: { error: { message: "You are trying to edit a protected cell or object." } },
      },
    });
    await expect(
      dimensionCommand("alice@example.com", ["1AbC", "B"], "delete", "cols"),
    ).rejects.toMatchObject({ code: "PROTECTED_RANGE" });
  });

  it("refuses before any call: missing range, extra argument", async () => {
    await expect(
      dimensionCommand("alice@example.com", ["1AbC"], "insert", "rows"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      dimensionCommand("alice@example.com", ["1AbC", "3", "5"], "insert", "rows"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(get).not.toHaveBeenCalled();
  });
});
