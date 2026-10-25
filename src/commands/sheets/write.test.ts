import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import {
  type WriteTarget,
  clipRect,
  grownGrid,
  grownTo,
  growthRequests,
  headerHint,
  headerState,
  parseAppendFlags,
  parseClearFlags,
  parseUpdateFlags,
  placeBlock,
  plannedCells,
  planRects,
  scanRange,
  writePlan,
} from "./write.js";
import { SHEETS_HELP, SUBCOMMANDS } from "../sheets.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("parseUpdateFlags", () => {
  it("takes --range with one source", () => {
    const f = parseUpdateFlags(["1AbC", "--range", "B2", "x.csv", "--tab", "Costs", "--raw"]);
    expect(f).toMatchObject({
      spreadsheetId: "1AbC",
      range: "B2",
      localPath: "x.csv",
      tab: "Costs",
      raw: true,
    });
  });
  it("takes repeated --cell as the whole block", () => {
    const f = parseUpdateFlags(["1AbC", "--cell", "B5=4800", "--cell", "D2==B2*C2"]);
    expect(f.cells?.map((c) => [c.a1, c.value])).toEqual([
      ["B5", "4800"],
      ["D2", "=B2*C2"],
    ]);
  });
  it("refuses --cell beside --range, a source, --json or --header", () => {
    for (const extra of [
      ["--range", "A1"],
      ["x.csv"],
      ["--content", "x"],
      ["--json"],
      ["--header"],
      ["-"],
    ]) {
      expect(codeOf(() => parseUpdateFlags(["1AbC", "--cell", "B5=1", ...extra]))).toBe(
        "VALIDATION_ERROR",
      );
    }
  });
  it("needs --range (or --cell) and exactly one source", () => {
    expect(codeOf(() => parseUpdateFlags(["1AbC", "x.csv"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseUpdateFlags(["1AbC", "--range", "A1"]))).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => parseUpdateFlags(["1AbC", "--range", "A1", "x.csv", "--content", "y"])),
    ).toBe("VALIDATION_ERROR");
  });
  it("refuses --json with --tsv and unknown flags", () => {
    expect(
      codeOf(() =>
        parseUpdateFlags(["1AbC", "--range", "A1", "--content", "x", "--json", "--tsv"]),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseUpdateFlags(["1AbC", "--values", "x"]))).toBe("VALIDATION_ERROR");
  });
  it("accepts an empty --content (an empty field still clears)", () => {
    expect(parseUpdateFlags(["1AbC", "--range", "A1", "--content", ""]).content).toBe("");
  });
});

describe("parseUpdateFlags (keyed)", () => {
  const objs = ["--json", "--content", '[{"Name":"x","Status":"done"}]'];
  it("takes --key and --append-missing with --json objects", () => {
    expect(parseUpdateFlags(["1AbC", ...objs, "--key", "Name", "--append-missing"])).toMatchObject({
      keyed: true,
      key: "Name",
      appendMissing: true,
    });
  });
  it("treats a --json source with no --range or --cell as keyed on column A", () => {
    const f = parseUpdateFlags(["1AbC", ...objs]);
    expect(f).toMatchObject({ keyed: true, appendMissing: false });
    expect(f.key).toBeUndefined();
  });
  it("still needs --range for a CSV block", () => {
    expect(codeOf(() => parseUpdateFlags(["1AbC", "--content", "a,b"]))).toBe("VALIDATION_ERROR");
  });
  it("refuses --key / --append-missing beside --range, --cell or --header", () => {
    for (const extra of [["--range", "A2"], ["--cell", "B2=1"], ["--header"]]) {
      expect(codeOf(() => parseUpdateFlags(["1AbC", ...objs, "--key", "Name", ...extra]))).toBe(
        "VALIDATION_ERROR",
      );
      expect(codeOf(() => parseUpdateFlags(["1AbC", ...objs, "--append-missing", ...extra]))).toBe(
        "VALIDATION_ERROR",
      );
    }
  });
  it("refuses --key without --json, with an empty name, or without one source", () => {
    expect(codeOf(() => parseUpdateFlags(["1AbC", "--key", "Name", "--content", "x"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseUpdateFlags(["1AbC", ...objs, "--key", " "]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseUpdateFlags(["1AbC", "--json", "--key", "Name"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("parseAppendFlags / parseClearFlags", () => {
  it("append needs a source", () => {
    expect(codeOf(() => parseAppendFlags(["1AbC"]))).toBe("VALIDATION_ERROR");
    expect(parseAppendFlags(["1AbC", "-"]).stdin).toBe(true);
  });
  it("clear needs exactly one of --range / --all", () => {
    expect(codeOf(() => parseClearFlags(["1AbC"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseClearFlags(["1AbC", "--all", "--range", "A1"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(parseClearFlags(["1AbC", "--all"]).all).toBe(true);
  });
});

describe("placeBlock (range fit)", () => {
  const grid = { rows: 1000, cols: 26 };
  const shape = { rows: 3, cols: 2, cells: 6 };
  it("anchors at a single cell whatever the shape", () => {
    expect(placeBlock("C5", shape, grid)).toEqual({ row0: 4, col0: 2, leftOver: 0 });
  });
  it("refuses a block larger than a bounding range, naming both shapes", () => {
    expect(() => placeBlock("B2:C3", shape, grid)).toThrow(/3x2 but --range B2:C3 is 2x2/);
  });
  it("writes a smaller block from the range's top-left and counts what it leaves", () => {
    expect(placeBlock("B2:D9", shape, grid)).toEqual({ row0: 1, col0: 1, leftOver: 24 - 6 });
  });
  it("accepts whole columns and rows against the allocation", () => {
    expect(placeBlock("B:C", shape, grid)).toMatchObject({ row0: 0, col0: 1 });
    expect(() => placeBlock("B:B", shape, grid)).toThrow(/is 1000x1/);
    expect(() => placeBlock("3:3", shape, grid)).toThrow(/is 1x26/);
    expect(placeBlock("3:5", shape, grid)).toMatchObject({ row0: 2, col0: 0 });
  });
  it("refuses what is not A1", () => {
    expect(codeOf(() => placeBlock("Rate", shape, grid))).toBe("RANGE_INVALID");
  });
});

describe("grid growth", () => {
  it("grows to cover the block, and only then", () => {
    const tab = { rows: 1000, cols: 26 };
    expect(grownGrid(tab, [{ r0: 0, c0: 0, r1: 3, c1: 30 }])).toEqual({
      rows: 1000,
      cols: 30,
      grown: true,
    });
    expect(grownGrid(tab, [{ r0: 999, c0: 0, r1: 1002, c1: 1 }])).toEqual({
      rows: 1002,
      cols: 26,
      grown: true,
    });
    expect(grownGrid(tab, [{ r0: 0, c0: 0, r1: 3, c1: 3 }]).grown).toBe(false);
  });
  it("clips a pre-read to the allocation, or skips it entirely outside", () => {
    expect(clipRect({ r0: 0, c0: 20, r1: 2, c1: 30 }, { rows: 10, cols: 26 })).toEqual({
      r0: 0,
      c0: 20,
      r1: 2,
      c1: 26,
    });
    expect(clipRect({ r0: 0, c0: 29, r1: 1, c1: 30 }, { rows: 10, cols: 26 })).toBeUndefined();
  });
});

describe("growth requests", () => {
  it("appends only what the block needs beyond the read allocation, per dimension", () => {
    const tab = { gid: 7, rows: 1000, cols: 26 };
    expect(growthRequests(tab, { rows: 1002, cols: 30 })).toEqual([
      { appendDimension: { sheetId: 7, dimension: "ROWS", length: 2 } },
      { appendDimension: { sheetId: 7, dimension: "COLUMNS", length: 4 } },
    ]);
    expect(growthRequests(tab, { rows: 1000, cols: 31 })).toEqual([
      { appendDimension: { sheetId: 7, dimension: "COLUMNS", length: 5 } },
    ]);
    // Never an absolute count, so never a shrink.
    expect(growthRequests(tab, { rows: 10, cols: 2 })).toEqual([]);
    expect(JSON.stringify(growthRequests(tab, { rows: 2000, cols: 40 }))).not.toContain("rowCount");
  });
  it("reads the grown size back from the reply", () => {
    expect(
      grownTo(
        {
          updatedSpreadsheet: {
            sheets: [
              { properties: { sheetId: 0, gridProperties: { rowCount: 5, columnCount: 5 } } },
              { properties: { sheetId: 7, gridProperties: { rowCount: 1500, columnCount: 30 } } },
            ],
          },
        },
        7,
      ),
    ).toEqual({ rows: 1500, cols: 30 });
    expect(grownTo({}, 7)).toBeUndefined();
  });
});

describe("error-scan scope", () => {
  it("is decided from the allocation read before the write", () => {
    const tab = { gid: 0, title: "Q4", index: 0, rows: 7692, cols: 26, frozenRows: 0 };
    // 199,992 cells: whole tab, quoted (Q4 alone would be a cell).
    expect(scanRange(tab, tab)).toBe("'Q4'");
    expect(scanRange(tab, { rows: 7700, cols: 26 })).toBeUndefined();
  });
});

describe("plans", () => {
  it("skips null cells and offsets by the anchor", () => {
    const plan = {
      kind: "block" as const,
      row0: 1,
      col0: 1,
      rows: [
        ["a", null],
        [null, 4],
      ],
    };
    expect(plannedCells(plan).map((p) => [p.a1, p.input])).toEqual([
      ["B2", "a"],
      ["C3", 4],
    ]);
    expect(planRects(plan)).toEqual([{ r0: 1, c0: 1, r1: 3, c1: 3 }]);
  });
  it("--header: freeze when unfrozen, report and send nothing otherwise", () => {
    expect(headerState(0)).toEqual({ send: true, text: "frozen" });
    expect(headerState(1)).toEqual({ send: false, text: "frozen" });
    expect(headerState(2)).toEqual({ send: false, text: "frozen (2 rows, unchanged)" });
  });
  it("hints --header for a 2+ column block at row 1 only", () => {
    const at = (row0: number, rows: string[][]) => ({
      kind: "block" as const,
      row0,
      col0: 0,
      rows,
    });
    expect(headerHint(at(0, [["a", "b"]]), false, "cmd")).toContain("--header");
    expect(headerHint(at(0, [["a", "b"]]), true, "cmd")).toBeUndefined();
    expect(headerHint(at(1, [["a", "b"]]), false, "cmd")).toBeUndefined();
    expect(headerHint(at(0, [["a"]]), false, "cmd")).toBeUndefined();
  });
});

/** A fake Sheets client recording every call, answering reads from `cells`. */
function fakeApi(cells: Record<string, sheets_v4.Schema$CellData>) {
  const calls: string[] = [];
  const api = {
    spreadsheets: {
      get: async (p: { ranges?: string[]; fields?: string }) => {
        calls.push(
          `get ${p.fields?.includes("errorValue))))") && !p.fields.includes("userEntered") ? "errors" : "cells"} ${p.ranges?.join(";")}`,
        );
        const rowData = Object.entries(cells).map(([, v]) => ({ values: [v] }));
        return { data: { sheets: [{ data: [{ startRow: 1, startColumn: 1, rowData }] }] } };
      },
      batchUpdate: async (p: { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
        calls.push(`batchUpdate ${Object.keys(p.requestBody.requests?.[0] ?? {})[0]}`);
        return { data: {} };
      },
      values: {
        update: async (p: { range: string }) => {
          calls.push(`values.update ${p.range}`);
          return { data: {} };
        },
        batchUpdate: async (p: { requestBody: { data: unknown[] } }) => {
          calls.push(`values.batchUpdate ${p.requestBody.data.length}`);
          return { data: {} };
        },
      },
    },
  };
  return { api: api as unknown as sheets_v4.Sheets, calls };
}

function target(api: sheets_v4.Sheets, frozenRows = 0, cols = 26): WriteTarget {
  return {
    api,
    account: "alice@example.com",
    meta: { id: "1AbC", title: "T", tabs: [], otherTitles: [], namedRanges: [] },
    tab: { gid: 0, title: "Costs", index: 0, rows: 1000, cols, frozenRows },
  };
}

describe("writePlan request sequence", () => {
  it("sends no write when every cell already holds the input", async () => {
    const { api, calls } = fakeApi({
      B2: { userEnteredValue: { stringValue: "x" }, formattedValue: "x" },
    });
    const out = await writePlan(
      target(api),
      { kind: "block", row0: 1, col0: 1, rows: [["x"]] },
      { raw: false, header: false },
    );
    expect(out.action).toBe("unchanged");
    expect(calls.filter((c) => !c.startsWith("get"))).toEqual([]);
  });
  it("writes --cell in one values.batchUpdate between one pre-read and one read-back", async () => {
    const { api, calls } = fakeApi({});
    await writePlan(
      target(api),
      {
        kind: "cells",
        cells: [
          { a1: "B5", row0: 4, col0: 1, value: "4800" },
          { a1: "C9", row0: 8, col0: 2, value: "3" },
        ],
      },
      { raw: false, header: false },
    );
    expect(calls).toEqual([
      "get cells 'Costs'!B5;'Costs'!C9",
      "get errors 'Costs'",
      "values.batchUpdate 2",
      "get cells 'Costs'!B5;'Costs'!C9",
      "get errors 'Costs'",
    ]);
  });
  it("grows the grid before the values call and freezes after it", async () => {
    const { api, calls } = fakeApi({});
    const out = await writePlan(
      target(api, 0, 2),
      { kind: "block", row0: 0, col0: 0, rows: [["a", "b", "c"]] },
      { raw: false, header: true },
    );
    expect(calls.filter((c) => !c.startsWith("get"))).toEqual([
      "batchUpdate appendDimension",
      "values.update 'Costs'!A1:C1",
      "batchUpdate updateSheetProperties",
    ]);
    // The fake reply carries no spreadsheet, so the note falls back to the computed size.
    expect(out.grid).toBe("grown to 1000×3");
    expect(out.header).toBe("frozen");
  });
  it("skips the pre-read for a fresh tab", async () => {
    const { api, calls } = fakeApi({});
    await writePlan(
      target(api),
      { kind: "block", row0: 0, col0: 0, rows: [["a"]] },
      { raw: false, header: false, fresh: true },
    );
    expect(calls[0]).toBe("values.update 'Costs'!A1");
  });
});

describe("sheets dispatcher", () => {
  it("has no scaffolded stubs and no alternatives block", () => {
    expect(SUBCOMMANDS.every((s) => s.handler)).toBe(true);
    expect(SHEETS_HELP).not.toContain("alternatives[");
    expect(SHEETS_HELP).not.toContain("NOT_IMPLEMENTED");
  });
});
