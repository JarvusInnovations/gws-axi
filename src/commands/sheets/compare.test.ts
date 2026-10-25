import { describe, expect, it } from "vitest";
import {
  type PlannedCell,
  diffBlock,
  displayNow,
  parsedLine,
  reportWrite,
  serialToIsoDate,
  storesSame,
} from "./compare.js";
import type { CellLike } from "./shared.js";

const str = (s: string): CellLike => ({ userEnteredValue: { stringValue: s }, formattedValue: s });
const num = (n: number, shown = String(n)): CellLike => ({
  userEnteredValue: { numberValue: n },
  formattedValue: shown,
});
const bool = (b: boolean): CellLike => ({ userEnteredValue: { boolValue: b } });
const formula = (f: string, shown: string): CellLike => ({
  userEnteredValue: { formulaValue: f },
  formattedValue: shown,
});

describe("storesSame", () => {
  it("compares strings against stringValue", () => {
    expect(storesSame("pending", str("pending"), false)).toBe(true);
    expect(storesSame("pending", str("done"), false)).toBe(false);
    expect(storesSame("pending", str("pending"), true)).toBe(true);
  });
  it("compares formulas against formulaValue (USER_ENTERED only)", () => {
    expect(storesSame("=B2*C2", formula("=B2*C2", "9600"), false)).toBe(true);
    expect(storesSame("=B2*C2", formula("=B2*C3", "9600"), false)).toBe(false);
    // RAW stores the text, so a stored formula is a change.
    expect(storesSame("=B2*C2", formula("=B2*C2", "9600"), true)).toBe(false);
    expect(storesSame("=B2*C2", str("=B2*C2"), true)).toBe(true);
  });
  it("compares numbers and booleans by value, typed or as canonical text", () => {
    expect(storesSame(4800, num(4800), false)).toBe(true);
    expect(storesSame("4800", num(4800, "$4,800"), false)).toBe(true);
    expect(storesSame(true, bool(true), false)).toBe(true);
    expect(storesSame("TRUE", bool(true), false)).toBe(true);
    expect(storesSame(4800, str("4800"), false)).toBe(false);
    // RAW "4800" stores the string, so a stored number is a change.
    expect(storesSame("4800", num(4800), true)).toBe(false);
  });
  it("counts what USER_ENTERED might parse as changed (unsure → changed)", () => {
    expect(storesSame("1/2", str("1/2"), false)).toBe(false);
    expect(storesSame("00123", str("00123"), false)).toBe(false);
    expect(storesSame("$4,800", num(4800, "$4,800"), false)).toBe(false);
    expect(storesSame("4800.0", num(4800), false)).toBe(false);
    expect(storesSame("#N/A", str("#N/A"), false)).toBe(false);
  });
  it("treats empty input against an empty cell as unchanged, anything else as a change", () => {
    expect(storesSame("", undefined, false)).toBe(true);
    expect(storesSame("", str("x"), false)).toBe(false);
    expect(storesSame("x", undefined, false)).toBe(false);
  });
});

describe("diffBlock", () => {
  it("reports each cell's previous entered text and whether it changes", () => {
    const planned: PlannedCell[] = [
      { a1: "B2", row0: 1, col0: 1, input: "4800" },
      { a1: "D2", row0: 1, col0: 3, input: "=B2*C2" },
    ];
    const current = new Map([
      ["B2", num(4200, "$4,200")],
      ["D2", formula("=B2*C2", "$8,400")],
    ]);
    expect(diffBlock(planned, current, false)).toEqual([
      { cell: "B2", before: "$4,200", changed: true },
      { cell: "D2", before: "=B2*C2", changed: false },
    ]);
  });
});

describe("reportWrite", () => {
  const p = (a1: string, input: PlannedCell["input"]): PlannedCell => ({
    a1,
    row0: 0,
    col0: 0,
    input,
  });

  it("lists every formula with its result, or its error and message", () => {
    const post = new Map<string, CellLike>([
      ["D2", { ...formula("=B2*C2", "$9,600"), effectiveValue: { numberValue: 9600 } }],
      [
        "D3",
        {
          ...formula("=B3/C3", "#DIV/0!"),
          effectiveValue: {
            errorValue: {
              type: "DIVIDE_BY_ZERO",
              message: "Function DIVIDE parameter 2 cannot be zero.",
            },
          },
        },
      ],
    ]);
    const r = reportWrite([p("D2", "=B2*C2"), p("D3", "=B3/C3")], new Map(), post, false);
    expect(r.formulas).toEqual([
      { cell: "D2", formula: "=B2*C2", result: "$9,600", message: "" },
      {
        cell: "D3",
        formula: "=B3/C3",
        result: "#DIV/0!",
        message: "Function DIVIDE parameter 2 cannot be zero.",
      },
    ]);
    expect(r.written).toEqual([]);
  });

  it("lists a replaced value (before ≠ input) and a display that differs (now ≠ input)", () => {
    const pre = new Map([
      ["B2", num(4200, "$4,200")],
      ["C3", str("pending")],
    ]);
    const post = new Map([
      ["B2", num(4800, "$4,800")],
      ["C3", str("done")],
      ["E2", num(123)],
    ]);
    const r = reportWrite([p("B2", "4800"), p("C3", "done"), p("E2", "00123")], pre, post, false);
    expect(r.written).toEqual([
      { cell: "B2", before: "$4,200", input: "4800", now: "$4,800" },
      { cell: "C3", before: "pending", input: "done", now: "done" },
      { cell: "E2", before: "", input: "00123", now: "123" },
    ]);
    expect(r.changed).toBe(3);
    // A parse is named over a mere number format.
    expect(r.parsed?.cell).toBe("E2");
  });

  it("omits a cell that was empty and now shows exactly what was typed", () => {
    const r = reportWrite([p("A1", "hello")], new Map(), new Map([["A1", str("hello")]]), false);
    expect(r.written).toEqual([]);
    expect(r.changed).toBe(1);
  });

  it("annotates a string Sheets parsed into a date, unless it was already that ISO date", () => {
    const date = (serial: number, shown: string): CellLike => ({
      ...num(serial, shown),
      effectiveFormat: { numberFormat: { type: "DATE" } },
    });
    const post = new Map([
      ["D4", date(46024, "1/2")],
      ["D5", date(46319, "2026-10-24")],
    ]);
    const r = reportWrite([p("D4", "1/2"), p("D5", "2026-10-24")], new Map(), post, false);
    expect(r.written).toEqual([
      { cell: "D4", before: "", input: "1/2", now: "1/2 (date 2026-01-02)" },
    ]);
    expect(parsedLine(r.parsed!)).toBe(
      "D4: 1/2 became the date 2026-01-02; --raw stores it as text",
    );
  });

  it("keeps an erroring non-formula cell out of formulas[] under --raw", () => {
    const r = reportWrite([p("A1", "=1+1")], new Map(), new Map([["A1", str("=1+1")]]), true);
    expect(r.formulas).toEqual([]);
    expect(r.written).toEqual([]);
  });

  it("does not count an unchanged cell", () => {
    const same = num(3);
    const r = reportWrite([p("C2", "3")], new Map([["C2", same]]), new Map([["C2", same]]), false);
    expect(r.changed).toBe(0);
    expect(r.written).toEqual([]);
  });
});

describe("dates", () => {
  it("converts Sheets serials", () => {
    expect(serialToIsoDate(46024)).toBe("2026-01-02");
    expect(serialToIsoDate(46319)).toBe("2026-10-24");
  });
  it("shows the display alone for non-date cells", () => {
    expect(displayNow(num(5, "$5.00"), "$5.00")).toBe("$5.00");
  });
  it("words a format-only difference without advising --raw", () => {
    expect(parsedLine({ cell: "B2", before: "", input: "4800", now: "$4,800" })).toBe(
      "B2: 4800 shows as $4,800 under the cell's number format",
    );
  });
});
