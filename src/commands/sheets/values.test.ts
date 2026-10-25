import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  blockShape,
  isEmptyBlock,
  mapKeyedRows,
  parseCellArgs,
  parseCsv,
  parseJsonGrid,
} from "./values.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("parseCsv", () => {
  it("reads quoted commas, doubled quotes and embedded newlines", () => {
    expect(parseCsv('a,"b,c","say ""hi""","line1\nline2"\n')).toEqual([
      ["a", "b,c", 'say "hi"', "line1\nline2"],
    ]);
  });
  it("accepts CRLF rows and drops the trailing newline", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("keeps ragged rows ragged and empty fields as empty strings", () => {
    expect(parseCsv("a,b,c\nd\n,e")).toEqual([["a", "b", "c"], ["d"], ["", "e"]]);
  });
  it("reads a blank line as an empty row, not a cell to clear", () => {
    expect(parseCsv("a\n\nb")).toEqual([["a"], [], ["b"]]);
  });
  it("splits on tabs for TSV", () => {
    expect(parseCsv("a\tb,c\n", "\t")).toEqual([["a", "b,c"]]);
  });
  it("refuses an unterminated quote, naming the line it opened on", () => {
    expect(() => parseCsv('a,b\nc,"d\ne')).toThrow(/line 2/);
    expect(codeOf(() => parseCsv('"x'))).toBe("VALIDATION_ERROR");
  });
  it("strips a byte-order mark", () => {
    expect(parseCsv("﻿a,b")).toEqual([["a", "b"]]);
  });
});

describe("parseJsonGrid", () => {
  it("keeps typed cells and null", () => {
    expect(parseJsonGrid('[["x", 4, true, null, ""]]', { allowObjects: false })).toEqual({
      kind: "grid",
      rows: [["x", 4, true, null, ""]],
    });
  });
  it("refuses a one-dimensional array, showing the row form", () => {
    expect(() => parseJsonGrid('["a","b"]', { allowObjects: false })).toThrow(/one-dimensional/);
  });
  it("refuses a nested array or object in a cell, naming the cell", () => {
    expect(() => parseJsonGrid('[["a",["b"]]]', { allowObjects: false })).toThrow(
      /row 1, column 2/,
    );
    expect(codeOf(() => parseJsonGrid('[["a",{"b":1}]]', { allowObjects: false }))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("refuses a non-finite number (1e400 parses to Infinity)", () => {
    expect(() => parseJsonGrid("[[1e400]]", { allowObjects: false })).toThrow(
      /not a finite number/,
    );
    expect(codeOf(() => parseJsonGrid('[{"A":-1e999}]', { allowObjects: true }))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("accepts objects for append only", () => {
    expect(parseJsonGrid('[{"Name":"x"}]', { allowObjects: true })).toEqual({
      kind: "keyed",
      objects: [{ Name: "x" }],
    });
    expect(codeOf(() => parseJsonGrid('[{"Name":"x"}]', { allowObjects: false }))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("refuses malformed JSON and a non-array", () => {
    expect(codeOf(() => parseJsonGrid("[[", { allowObjects: false }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseJsonGrid('{"a":1}', { allowObjects: true }))).toBe("VALIDATION_ERROR");
  });
});

describe("mapKeyedRows", () => {
  const headers = ["Name", " Status ", "", "Owner"];
  it("aligns keys to header columns and leaves unnamed ones null", () => {
    expect(mapKeyedRows([{ Name: "x", Owner: "me" }, { Status: "done" }], headers)).toEqual([
      ["x", null, null, "me"],
      [null, "done"],
    ]);
  });
  it("refuses a key that names no header, listing the headers", () => {
    expect(() => mapKeyedRows([{ owner: "me" }], headers)).toThrow(/"owner"/);
    expect(codeOf(() => mapKeyedRows([{ Missing: 1 }], headers))).toBe("COLUMN_NOT_FOUND");
  });
  it("needs a non-empty row 1", () => {
    expect(codeOf(() => mapKeyedRows([{ Name: "x" }], ["", ""]))).toBe("HEADER_REQUIRED");
  });
});

describe("parseCellArgs", () => {
  it("splits at the first '=' so a formula keeps its own", () => {
    expect(parseCellArgs(["B5=4800", "D2==B2*C2", "C9="])).toEqual([
      { tab: undefined, a1: "B5", row0: 4, col0: 1, value: "4800" },
      { tab: undefined, a1: "D2", row0: 1, col0: 3, value: "=B2*C2" },
      { tab: undefined, a1: "C9", row0: 8, col0: 2, value: "" },
    ]);
  });
  it("reads tab-qualified cells, including a quoted title with '='", () => {
    expect(parseCellArgs(["Costs!$B$5=1", "Costs!C1=2"]).map((c) => [c.tab, c.a1])).toEqual([
      ["Costs", "B5"],
      ["Costs", "C1"],
    ]);
    expect(parseCellArgs(["'a=b'!C1==A1"])[0]).toMatchObject({ tab: "a=b", value: "=A1" });
  });
  it("refuses a missing '=', a duplicate cell, a range and mixed tabs", () => {
    expect(codeOf(() => parseCellArgs(["B5"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseCellArgs(["B5=1", "$B$5=2"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseCellArgs(["B5:C6=1"]))).toBe("RANGE_INVALID");
    expect(codeOf(() => parseCellArgs(["ZZZZ1=1"]))).toBe("RANGE_INVALID");
    expect(codeOf(() => parseCellArgs(["A!B5=1", "B!B6=2"]))).toBe("VALIDATION_ERROR");
  });
});

describe("blockShape / isEmptyBlock", () => {
  it("measures the longest row and counts non-null cells", () => {
    expect(
      blockShape([
        ["a", null],
        ["b", "c", ""],
      ]),
    ).toEqual({ rows: 2, cols: 3, cells: 4 });
  });
  it("calls a block of empties and nulls empty", () => {
    expect(isEmptyBlock([])).toBe(true);
    expect(isEmptyBlock([[], ["", null]])).toBe(true);
    expect(isEmptyBlock([["", "x"]])).toBe(false);
  });
});
