import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import {
  appendedCells,
  keyText,
  matchKeyedRows,
  nearMiss,
  resolveKeyColumn,
  rowRects,
  strippedNumber,
} from "./keyed.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as AxiError;
    return [e.message, ...(e.suggestions ?? [])].join("\n");
  }
  return "";
}

// Row 1 with a gap in column C; the key column (A) as displayed, by row0.
const headers = ["Name", " Status ", "", "Owner"];
const names = ["Name", "Ship it", "Write docs", " Review ", "", "0001"];
const nameKey = { name: "Name", col0: 0 };
const opts = { appendMissing: false };

describe("resolveKeyColumn", () => {
  it("defaults to column A's header", () => {
    expect(resolveKeyColumn(headers, undefined)).toEqual({ name: "Name", col0: 0 });
  });
  it("matches --key to a header cell, trimmed and case-sensitive", () => {
    expect(resolveKeyColumn(headers, "Status")).toEqual({ name: "Status", col0: 1 });
    expect(resolveKeyColumn(headers, " Owner ")).toEqual({ name: "Owner", col0: 3 });
    expect(codeOf(() => resolveKeyColumn(headers, "status"))).toBe("COLUMN_NOT_FOUND");
    expect(messageOf(() => resolveKeyColumn(headers, "Nope"))).toMatch(
      /Headers in row 1: Name, Status, Owner/,
    );
  });
  it("refuses the default when column A has no header, and an empty row 1", () => {
    expect(codeOf(() => resolveKeyColumn(["", "Name"], undefined))).toBe("COLUMN_NOT_FOUND");
    expect(messageOf(() => resolveKeyColumn(["", "Name"], undefined))).toMatch(/--key/);
    expect(codeOf(() => resolveKeyColumn(["", " "], undefined))).toBe("HEADER_REQUIRED");
  });
});

describe("keyText", () => {
  it("renders a key value as the cell would display it", () => {
    expect(keyText(" Ship it ")).toBe("Ship it");
    expect(keyText(42)).toBe("42");
    expect(keyText(true)).toBe("TRUE");
    expect(keyText(1e21)).toBe("1000000000000000000000");
  });
});

describe("matchKeyedRows", () => {
  it("matches each object to its row and writes only the other named cells", () => {
    const plan = matchKeyedRows(
      [
        { Name: "Write docs", Owner: "bo", Status: null },
        { Name: "Ship it", Status: "done" },
      ],
      headers,
      nameKey,
      names,
      opts,
    );
    expect(plan.missing).toEqual([]);
    expect(plan.matches.map((m) => [m.key, m.row0, m.cells.map((c) => [c.a1, c.value])])).toEqual([
      ["Write docs", 2, [["D3", "bo"]]],
      ["Ship it", 1, [["B2", "done"]]],
    ]);
  });
  it("matches displayed text trimmed on both sides, numbers as text", () => {
    const plan = matchKeyedRows(
      [
        { Name: "Review", Owner: 1 },
        { Name: "0001", Owner: 2 },
      ],
      headers,
      nameKey,
      names,
      opts,
    );
    expect(plan.matches.map((m) => m.row0)).toEqual([3, 5]);
    // A number key is its plain decimal: 1 does not match a cell displaying 0001.
    expect(
      codeOf(() => matchKeyedRows([{ Name: 1, Owner: "x" }], headers, nameKey, names, opts)),
    ).toBe("ROW_NOT_FOUND");
  });
  it("matches on another key column, leaving the key cell out", () => {
    const status = { name: "Status", col0: 1 };
    const plan = matchKeyedRows(
      [{ Status: "open", Owner: "al" }],
      headers,
      status,
      [undefined, "done", "open"],
      opts,
    );
    expect(plan.matches[0].cells.map((c) => c.a1)).toEqual(["D3"]);
  });
  it("never matches the header row itself", () => {
    expect(
      codeOf(() => matchKeyedRows([{ Name: "Name", Owner: "x" }], headers, nameKey, names, opts)),
    ).toBe("ROW_NOT_FOUND");
  });
  it("refuses no match with every unmatched value, and hints a case-only near miss", () => {
    const fn = () =>
      matchKeyedRows(
        [
          { Name: "ship it", Owner: "x" },
          { Name: "Gone", Owner: "y" },
        ],
        headers,
        nameKey,
        names,
        opts,
      );
    expect(codeOf(fn)).toBe("ROW_NOT_FOUND");
    expect(messageOf(fn)).toMatch(/"ship it", "Gone"/);
    expect(messageOf(fn)).toMatch(/row 2 displays "Ship it"/);
    expect(messageOf(fn)).toMatch(/exactly as displayed/);
  });
  it("returns unmatched objects as header-aligned rows with --append-missing", () => {
    const plan = matchKeyedRows(
      [
        { Name: "Ship it", Owner: "x" },
        { Owner: "y", Name: "New" },
      ],
      headers,
      nameKey,
      names,
      { appendMissing: true },
    );
    expect(plan.matches.map((m) => m.key)).toEqual(["Ship it"]);
    expect(plan.missing).toEqual([{ key: "New", index: 1, row: ["New", null, null, "y"] }]);
    expect(appendedCells(plan.missing, 6).map((r) => r.map((c) => [c.a1, c.value]))).toEqual([
      [
        ["A7", "New"],
        ["D7", "y"],
      ],
    ]);
  });
  it("refuses a label displayed in two rows, naming the rows", () => {
    const fn = () =>
      matchKeyedRows([{ Name: "Ship it", Owner: "x" }], headers, nameKey, [...names, "Ship it"], {
        appendMissing: true,
      });
    expect(codeOf(fn)).toBe("ROW_AMBIGUOUS");
    expect(messageOf(fn)).toMatch(/rows 2, 7/);
  });
  it("refuses an object without its key, or with an empty one", () => {
    expect(codeOf(() => matchKeyedRows([{ Owner: "x" }], headers, nameKey, names, opts))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      messageOf(() =>
        matchKeyedRows([{ Name: "Ship it" }, { Name: " " }], headers, nameKey, names, opts),
      ),
    ).toMatch(/Object 2 has no "Name"/);
    expect(codeOf(() => matchKeyedRows([{ Name: null }], headers, nameKey, names, opts))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("refuses the same key twice in the block", () => {
    const fn = () =>
      matchKeyedRows(
        [
          { Name: "Ship it", Owner: "a" },
          { Name: " Ship it", Status: "b" },
        ],
        headers,
        nameKey,
        names,
        opts,
      );
    expect(codeOf(fn)).toBe("VALIDATION_ERROR");
    expect(messageOf(fn)).toMatch(/Objects 1 and 2/);
  });
  it("refuses a key that names no header (COLUMN_NOT_FOUND), before matching", () => {
    expect(
      codeOf(() => matchKeyedRows([{ Name: "Gone", Due: "x" }], headers, nameKey, names, opts)),
    ).toBe("COLUMN_NOT_FOUND");
  });
  it("leaves the gap column and unnamed headers out of the write", () => {
    const plan = matchKeyedRows([{ Name: "Ship it", Owner: "x" }], headers, nameKey, names, opts);
    expect(plan.matches[0].cells.map((c) => c.col0)).toEqual([3]);
  });
});

describe("near misses under --append-missing", () => {
  const append = { appendMissing: true };
  it("refuses a case-only near miss instead of appending a duplicate", () => {
    const fn = () =>
      matchKeyedRows([{ Name: "ship it", Owner: "x" }], headers, nameKey, names, append);
    expect(codeOf(fn)).toBe("ROW_NOT_FOUND");
    expect(messageOf(fn)).toMatch(/row 2 displays "Ship it"/);
    expect(messageOf(fn)).toMatch(/exactly as displayed, or fix the sheet/);
  });
  it("refuses a number that a row displays with formatting", () => {
    const shown = ["Name", "7.00", "$1,200", "0001"];
    for (const [k, row] of [
      [7, 2],
      [1200, 3],
      ["1,200", 3],
      [1, 4],
    ] as const) {
      const fn = () => matchKeyedRows([{ Name: k, Owner: "x" }], headers, nameKey, shown, append);
      expect(codeOf(fn)).toBe("ROW_NOT_FOUND");
      expect(messageOf(fn)).toMatch(new RegExp(`row ${row} displays`));
    }
  });
  it("still appends a key nothing resembles", () => {
    const plan = matchKeyedRows(
      [{ Name: "Brand new", Owner: "x" }],
      headers,
      nameKey,
      names,
      append,
    );
    expect(plan.missing.map((m) => m.key)).toEqual(["Brand new"]);
  });
  it("strips formatting from displayed numbers only", () => {
    expect(strippedNumber("$1,200.50")).toBe(1200.5);
    expect(strippedNumber("7.00")).toBe(7);
    expect(strippedNumber("Ship it")).toBeUndefined();
    expect(nearMiss("abc", new Map([["ABD", [1]]]))).toBeUndefined();
  });
});

describe("rowRects", () => {
  const cell = (row0: number, col0: number) => ({ a1: "", row0, col0, value: "v" });
  it("groups cells into one bounding rectangle per row, in order", () => {
    expect(rowRects([cell(4, 1), cell(1, 3), cell(4, 6), cell(1, 2)])).toEqual([
      { r0: 4, r1: 5, c0: 1, c1: 7 },
      { r0: 1, r1: 2, c0: 2, c1: 4 },
    ]);
  });
  it("widens a matched row to take in its key cell", () => {
    expect(rowRects([cell(2, 3), cell(2, 4)], 0)).toEqual([{ r0: 2, r1: 3, c0: 0, c1: 5 }]);
  });
});
