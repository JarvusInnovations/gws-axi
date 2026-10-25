import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  cellKind,
  parseCellFlags,
  parseFormulaRefs,
  resolveRef,
  validationSummary,
} from "./cell.js";
import type { SpreadsheetMeta } from "./shared.js";

const refs = (f: string) =>
  parseFormulaRefs(f).map((r) =>
    r.dynamic ? `dyn:${r.text}` : r.a1 ? `${r.tab ? `${r.tab}!` : ""}${r.a1}` : `name:${r.name}`,
  );

describe("parseFormulaRefs", () => {
  it("finds cells and ranges in order, deduplicated", () => {
    expect(refs("=B2*C2+B2")).toEqual(["B2", "C2"]);
    expect(refs("=SUM($B$2:B9)")).toEqual(["B2:B9"]);
  });
  it("reads tab-qualified refs, quoted titles included", () => {
    expect(refs("=Sheet1!A1:B2+'My Tab'!C3+'it''s'!D4")).toEqual([
      "Sheet1!A1:B2",
      "My Tab!C3",
      "it's!D4",
    ]);
  });
  it("reads whole columns and rows", () => {
    expect(refs("=SUM(B:B)+SUM(3:3)")).toEqual(["B:B", "3:3"]);
  });
  it("skips string literals and function names, keeps names", () => {
    expect(refs('=IF(A1="B5",LOG10(Rate),TRUE)')).toEqual(["A1", "name:Rate"]);
  });
  it("reads open-ended ranges without inventing a name", () => {
    expect(refs("=SUM(B2:B)")).toEqual(["B2:B"]);
    expect(refs("=ARRAYFORMULA(A2:A*B2:B)")).toEqual(["A2:A", "B2:B"]);
    expect(refs("=SUM(A3:3)+Costs!C2:C")).toEqual(["A3:3", "Costs!C2:C"]);
  });
  it("marks INDIRECT and OFFSET as dynamic", () => {
    expect(refs('=INDIRECT("B"&A1)+OFFSET(C1,1,0)')).toEqual([
      'dyn:INDIRECT("B"&A1)',
      "A1",
      "dyn:OFFSET(C1,1,0)",
      "C1",
    ]);
  });
});

describe("resolveRef", () => {
  const meta: SpreadsheetMeta = {
    id: "1AbC",
    title: "T",
    tabs: [
      { gid: 0, title: "Costs", index: 0, rows: 100, cols: 5, frozenRows: 0 },
      { gid: 3, title: "Rates", index: 1, rows: 10, cols: 2, frozenRows: 0 },
    ],
    otherTitles: [],
    namedRanges: [
      {
        name: "Rate",
        range: {
          sheetId: 3,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
      },
    ],
  };
  const home = meta.tabs[0];
  it("resolves a named range through the metadata", () => {
    const r = resolveRef({ text: "Rate", name: "Rate" }, home, meta);
    expect(r.tab?.title).toBe("Rates");
    expect(r.rect).toEqual({ r0: 1, r1: 2, c0: 1, c1: 2 });
  });
  it("leaves a missing tab without a target (#REF! upstream)", () => {
    const r = resolveRef({ text: "Cost!B2", tab: "Cost", a1: "B2" }, home, meta);
    expect(r.tab).toBeUndefined();
    expect(r.label).toBe("Cost!B2");
  });
});

describe("sheets cell flags and rendering", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as AxiError).code;
    }
    return "none";
  };
  it("takes one cell, optionally qualified", () => {
    expect(parseCellFlags(["1AbC", "Costs!$D$2"])).toMatchObject({
      cell: "D2",
      cellTab: "Costs",
      depth: 1,
    });
  });
  it("refuses a range, bad A1 and --depth outside 1–3", () => {
    expect(code(() => parseCellFlags(["1AbC", "A1:B2"]))).toBe("VALIDATION_ERROR");
    expect(code(() => parseCellFlags(["1AbC", "Rate"]))).toBe("VALIDATION_ERROR");
    expect(code(() => parseCellFlags(["1AbC", "A1", "--depth", "4"]))).toBe("VALIDATION_ERROR");
  });
  it("names a cell's effective kind and summarizes validation", () => {
    expect(cellKind({ effectiveValue: { errorValue: { type: "REF" } } })).toBe("error");
    expect(cellKind({ effectiveValue: { stringValue: "n/a" } })).toBe("text");
    expect(cellKind(undefined)).toBe("empty");
    expect(
      validationSummary({
        condition: {
          type: "ONE_OF_LIST",
          values: [{ userEnteredValue: "open" }, { userEnteredValue: "done" }],
        },
      }),
    ).toBe("ONE_OF_LIST open, done");
  });
});
