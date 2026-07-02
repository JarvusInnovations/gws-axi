import { describe, expect, it } from "vitest";
import {
  buildGrid,
  cellToMarkdown,
  columnIndex,
  columnLetter,
  extractGrid,
  parseRangeOrigin,
  resolveHeaderMode,
} from "./read.js";

describe("columnLetter / columnIndex", () => {
  it("maps 0-based indexes to A1 letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });

  it("round-trips letters back to indexes", () => {
    for (const i of [0, 5, 25, 26, 51, 701, 702]) {
      expect(columnIndex(columnLetter(i))).toBe(i);
    }
  });
});

describe("parseRangeOrigin", () => {
  it("defaults to A1 for empty/undefined", () => {
    expect(parseRangeOrigin(undefined)).toEqual({ col0: 0, row1: 1 });
    expect(parseRangeOrigin("")).toEqual({ col0: 0, row1: 1 });
  });

  it("parses a bare range", () => {
    expect(parseRangeOrigin("C5:E9")).toEqual({ col0: 2, row1: 5 });
    expect(parseRangeOrigin("A1:B2")).toEqual({ col0: 0, row1: 1 });
  });

  it("strips an unquoted tab qualifier", () => {
    expect(parseRangeOrigin("Costs!C5:E9")).toEqual({ col0: 2, row1: 5 });
  });

  it("strips a quoted tab qualifier that itself contains !", () => {
    expect(parseRangeOrigin("'My Sheet!x'!B10:D20")).toEqual({ col0: 1, row1: 10 });
  });

  it("handles open-ended and absolute refs", () => {
    expect(parseRangeOrigin("Costs!A:D")).toEqual({ col0: 0, row1: 1 });
    expect(parseRangeOrigin("Costs!5:9")).toEqual({ col0: 0, row1: 5 });
    expect(parseRangeOrigin("$C$5:$E$9")).toEqual({ col0: 2, row1: 5 });
  });
});

describe("buildGrid — default column-letter grid", () => {
  const values = [
    ["Item", "Qty", "Cost"],
    ["Widgets", "40", "120.00"],
    ["Gadgets", "10"], // ragged — missing 3rd cell
  ];

  it("tags rows with real sheet numbers and A1 letters from origin", () => {
    const g = buildGrid(values, { col0: 0, row1: 1 }, { headerRow: false, maxRows: 200, full: false });
    expect(g.listName).toBe("cells");
    expect(g.schema.map((f) => f.name)).toEqual(["row", "A", "B", "C"]);
    expect(g.rows[0]).toEqual({ row: 1, A: "Item", B: "Qty", C: "Cost" });
    // ragged row pads the missing cell to ""
    expect(g.rows[2]).toEqual({ row: 3, A: "Gadgets", B: "10", C: "" });
  });

  it("honors a non-A1 origin (C5) for letters and row numbers", () => {
    const g = buildGrid([["x", "y"]], { col0: 2, row1: 5 }, { headerRow: false, maxRows: 200, full: false });
    expect(g.schema.map((f) => f.name)).toEqual(["row", "C", "D"]);
    expect(g.rows[0]).toEqual({ row: 5, C: "x", D: "y" });
  });

  it("caps rows and flags truncation, total counts the full set", () => {
    const many = Array.from({ length: 250 }, (_, i) => [String(i)]);
    const g = buildGrid(many, { col0: 0, row1: 1 }, { headerRow: false, maxRows: 200, full: false });
    expect(g.rows).toHaveLength(200);
    expect(g.totalRows).toBe(250);
    expect(g.truncated).toBe(true);
  });

  it("--full renders everything and clears truncation", () => {
    const many = Array.from({ length: 250 }, (_, i) => [String(i)]);
    const g = buildGrid(many, { col0: 0, row1: 1 }, { headerRow: false, maxRows: 200, full: true });
    expect(g.rows).toHaveLength(250);
    expect(g.truncated).toBe(false);
  });
});

describe("cellToMarkdown", () => {
  it("returns plain text when there is no link", () => {
    expect(cellToMarkdown({ formattedValue: "hello" })).toEqual({ text: "hello", links: 0 });
  });

  it("wraps a whole-cell hyperlink as markdown", () => {
    expect(cellToMarkdown({ formattedValue: "GTFS spec", hyperlink: "https://x.dev/a" })).toEqual({
      text: "[GTFS spec](https://x.dev/a)",
      links: 1,
    });
  });

  it("falls back to the URL as label when a linked cell has no text", () => {
    expect(cellToMarkdown({ formattedValue: "", hyperlink: "https://x.dev/a" })).toEqual({
      text: "https://x.dev/a",
      links: 1,
    });
  });

  it("reconstructs multiple rich-text links from run boundaries", () => {
    // "see here and here" — "here" at 4-8 → u1, "here" at 13-17 → u2
    const cell = {
      formattedValue: "see here and here",
      textFormatRuns: [
        { startIndex: 0 },
        { startIndex: 4, format: { link: { uri: "https://u1" } } },
        { startIndex: 8 },
        { startIndex: 13, format: { link: { uri: "https://u2" } } },
      ],
    };
    expect(cellToMarkdown(cell)).toEqual({
      text: "see [here](https://u1) and [here](https://u2)",
      links: 2,
    });
  });
});

describe("extractGrid", () => {
  it("inlines links, collects notes with A1 addresses, and counts links", () => {
    const rows = [
      { values: [{ formattedValue: "Item" }, { formattedValue: "Doc", hyperlink: "https://d/1" }] },
      {
        values: [
          { formattedValue: "x", note: "check this" },
          { formattedValue: "y" },
        ],
      },
    ];
    const out = extractGrid(rows, { col0: 0, row1: 1 });
    expect(out.values).toEqual([
      ["Item", "[Doc](https://d/1)"],
      ["x", "y"],
    ]);
    expect(out.linkCount).toBe(1);
    expect(out.notes).toEqual([{ cell: "A2", note: "check this" }]);
  });

  it("addresses notes relative to a non-A1 origin", () => {
    const rows = [{ values: [{ formattedValue: "v", note: "n" }] }];
    const out = extractGrid(rows, { col0: 2, row1: 5 }); // C5
    expect(out.notes).toEqual([{ cell: "C5", note: "n" }]);
  });

  it("trims trailing fully-empty rows padded by a bounded window", () => {
    const rows = [
      { values: [{ formattedValue: "a" }] },
      { values: [{ formattedValue: "" }] },
      { values: [] },
    ];
    const out = extractGrid(rows, { col0: 0, row1: 1 });
    expect(out.values).toEqual([["a"]]);
  });
});

describe("resolveHeaderMode", () => {
  it("auto-promotes a single frozen top row when the window starts at row 1", () => {
    expect(resolveHeaderMode({ explicitHeader: false, explicitRaw: false, frozenRows: 1, originRow1: 1 })).toEqual({
      headerRow: true,
      auto: true,
    });
  });

  it("does not auto-promote when no row is frozen", () => {
    expect(resolveHeaderMode({ explicitHeader: false, explicitRaw: false, frozenRows: 0, originRow1: 1 })).toEqual({
      headerRow: false,
      auto: false,
    });
  });

  it("does not auto-promote multi-row frozen headers", () => {
    expect(resolveHeaderMode({ explicitHeader: false, explicitRaw: false, frozenRows: 2, originRow1: 1 })).toEqual({
      headerRow: false,
      auto: false,
    });
  });

  it("does not auto-promote when the fetched window starts below row 1", () => {
    expect(resolveHeaderMode({ explicitHeader: false, explicitRaw: false, frozenRows: 1, originRow1: 5 })).toEqual({
      headerRow: false,
      auto: false,
    });
  });

  it("--header-row forces promotion even without a frozen row", () => {
    expect(resolveHeaderMode({ explicitHeader: true, explicitRaw: false, frozenRows: 0, originRow1: 1 })).toEqual({
      headerRow: true,
      auto: false,
    });
  });

  it("--raw overrides a frozen-row auto-promotion", () => {
    expect(resolveHeaderMode({ explicitHeader: false, explicitRaw: true, frozenRows: 1, originRow1: 1 })).toEqual({
      headerRow: false,
      auto: false,
    });
  });
});

describe("buildGrid — --header-row promotion", () => {
  const values = [
    ["Item", "Qty", "Cost"],
    ["Widgets", "40", "120.00"],
    ["Gadgets", "10", "55.00"],
  ];

  it("promotes row 1 to column names and drops the row column", () => {
    const g = buildGrid(values, { col0: 0, row1: 1 }, { headerRow: true, maxRows: 200, full: false });
    expect(g.listName).toBe("rows");
    expect(g.schema.map((f) => f.name)).toEqual(["Item", "Qty", "Cost"]);
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]).toEqual({ Item: "Widgets", Qty: "40", Cost: "120.00" });
    expect(g.totalRows).toBe(2);
  });

  it("falls back to letters for empty headers and disambiguates duplicates", () => {
    const dup = [
      ["Name", "", "Name"],
      ["a", "b", "c"],
    ];
    const g = buildGrid(dup, { col0: 0, row1: 1 }, { headerRow: true, maxRows: 200, full: false });
    expect(g.schema.map((f) => f.name)).toEqual(["Name", "B", "Name (C)"]);
    expect(g.rows[0]).toEqual({ Name: "a", B: "b", "Name (C)": "c" });
  });
});
