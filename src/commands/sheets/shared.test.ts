import { describe, expect, it } from "vitest";
import {
  cellArg,
  collectErrors,
  legendLine,
  diffErrors,
  fixLines,
  formulaMentions,
  parseA1,
  rectA1,
  requireTab,
  displayTitle,
  duplicateTitle,
  quoteTitle,
  shellArg,
  toRect,
  translateWriteError,
  type SpreadsheetMeta,
} from "./shared.js";
import { AxiError } from "axi-sdk-js";

describe("parseA1", () => {
  it("parses cells, ranges, columns and rows", () => {
    expect(parseA1("$B$2")).toMatchObject({ kind: "cell", r0: 1, c0: 1 });
    expect(parseA1("D9:B2")).toEqual({ kind: "range", r0: 1, r1: 9, c0: 1, c1: 4 });
    expect(parseA1("B:B")).toEqual({ kind: "cols", c0: 1, c1: 2 });
    expect(parseA1("3:3")).toEqual({ kind: "rows", r0: 2, r1: 3 });
  });
  it("refuses what is not A1", () => {
    for (const bad of ["", "B", "B0", "ZZZZ1", "A1:", "Rate", "A1:B2:C3", "B:2"]) {
      expect(parseA1(bad)).toBeUndefined();
    }
  });
  it("parses open-ended ranges from their start cell", () => {
    expect(parseA1("B2:B")).toEqual({ kind: "cols", r0: 1, c0: 1, c1: 2 });
    expect(parseA1("A3:3")).toEqual({ kind: "rows", r0: 2, r1: 3, c0: 0 });
    const grid = { rows: 1000, cols: 26 };
    expect(rectA1(toRect(parseA1("B2:C")!, grid))).toBe("B2:C1000");
    expect(rectA1(toRect(parseA1("C3:3")!, grid))).toBe("C3:Z3");
  });
  it("closes open axes with the allocation and prints ranges back", () => {
    const grid = { rows: 1000, cols: 26 };
    expect(rectA1(toRect(parseA1("B:B")!, grid))).toBe("B1:B1000");
    expect(rectA1(toRect(parseA1("3:3")!, grid))).toBe("A3:Z3");
    expect(rectA1(toRect(parseA1("C4")!, grid))).toBe("C4");
  });
});

describe("quoting", () => {
  it("always quotes a title sent upstream — Q4 alone is a cell on the first sheet", () => {
    expect(quoteTitle("Q4")).toBe("'Q4'");
    expect(quoteTitle("Costs")).toBe("'Costs'");
    expect(quoteTitle("it's")).toBe("'it''s'");
  });
  it("displays a title bare only when it cannot read as a cell", () => {
    expect(displayTitle("Costs")).toBe("Costs");
    expect(displayTitle("Q4")).toBe("'Q4'");
    expect(displayTitle("FY24")).toBe("'FY24'");
    expect(displayTitle("My Tab")).toBe("'My Tab'");
  });
  it("quotes shell args only when needed", () => {
    expect(shellArg("Costs")).toBe("Costs");
    expect(shellArg("Q4 Costs")).toBe("'Q4 Costs'");
    expect(shellArg("it's")).toBe("'it'\\''s'");
  });
  it("always single-quotes a --cell value", () => {
    expect(cellArg("D2", "=B2*C2")).toBe("D2='=B2*C2'");
    expect(cellArg("D2", "='My Tab'!A1")).toBe("D2='='\\''My Tab'\\''!A1'");
  });
});

const err = (cell: string, type: string, message = "m") => ({ cell, error: type, message });

describe("diffErrors", () => {
  it("reports new and written errors, counts fixed and pre-existing ones", () => {
    const before = new Map([
      ["A1", err("A1", "REF")],
      ["B1", err("B1", "NAME")],
      ["C1", err("C1", "VALUE")],
    ]);
    const after = new Map([
      ["B1", err("B1", "NAME")], // untouched, still erroring → elsewhere
      ["C1", err("C1", "VALUE")], // written by this call → reported
      ["D9", err("D9", "VALUE")], // new collateral → reported
    ]);
    const d = diffErrors(before, after, new Set(["C1"]));
    expect(d.errors).toEqual([
      { ...err("C1", "VALUE"), written: true },
      { ...err("D9", "VALUE"), written: false },
    ]);
    expect(d.fixed).toBe(1);
    expect(d.elsewhere).toBe(1);
  });
  it("reports a pre-existing error whose type changed", () => {
    const d = diffErrors(
      new Map([["A1", err("A1", "REF")]]),
      new Map([["A1", err("A1", "VALUE")]]),
      new Set(),
    );
    expect(d.errors).toHaveLength(1);
  });
  it("collects errors from an errors-only mask", () => {
    const found = collectErrors([
      {
        startRow: 4,
        startColumn: 1,
        rowData: [
          {
            values: [
              { effectiveValue: {} },
              { effectiveValue: { errorValue: { type: "REF", message: "x" } } },
            ],
          },
        ],
      },
    ]);
    expect([...found.values()]).toEqual([{ cell: "C5", error: "REF", message: "x" }]);
  });
});

describe("fixLines", () => {
  it("carries the current formula and names the written cell a collateral error reads", () => {
    const lines = fixLines(
      [
        { ...err("D3", "VALUE", "MULTIPLY expects numbers"), written: false },
        { ...err("F2", "REF", "Unresolved sheet name 'Cost'."), written: true },
      ],
      new Map([
        ["D3", "=B3*C3"],
        ["F2", "=Cost!B2"],
      ]),
      {
        spreadsheetId: "1AbC",
        tabTitle: "Costs",
        account: "alice@example.com",
        writtenCells: ["B3"],
      },
    );
    expect(lines).toEqual([
      "Fix D3 (#VALUE!, MULTIPLY expects numbers) — reads B3, which this write changed: gws-axi sheets update 1AbC --tab Costs --cell D3='=B3*C3' --account alice@example.com",
      "Fix F2 (#REF!, Unresolved sheet name 'Cost'.): gws-axi sheets update 1AbC --tab Costs --cell F2='=Cost!B2' --account alice@example.com",
      "Run `gws-axi sheets cell 1AbC D3 --tab Costs` to see the formula with the current values it reads",
    ]);
  });
  it("caps at five fix lines", () => {
    const many = Array.from({ length: 8 }, (_, i) => err(`A${i + 1}`, "REF"));
    expect(fixLines(many, new Map(), { spreadsheetId: "1", tabTitle: "T" })).toHaveLength(6);
  });
  it("matches a mention inside a range, not inside a string literal", () => {
    expect(formulaMentions("=SUM(B2:B9)", "B5")).toBe(true);
    expect(formulaMentions('=IF(A1="B5",1,0)', "B5")).toBe(false);
  });
  it("matches whole and open-ended columns and rows", () => {
    expect(formulaMentions("=SUM(B:B)", "B5")).toBe(true);
    expect(formulaMentions("=SUM(B2:B)", "B5")).toBe(true);
    expect(formulaMentions("=SUM(B6:B)", "B5")).toBe(false);
    expect(formulaMentions("=ARRAYFORMULA(A2:A*B2:B)", "B5")).toBe(true);
    expect(formulaMentions("=SUM(5:5)", "B5")).toBe(true);
    expect(formulaMentions("=SUM(A5:5)", "B5")).toBe(true);
  });
  it("ignores a reference qualified with another tab, honors this tab's", () => {
    expect(formulaMentions("=Other!B5", "B5", "Costs")).toBe(false);
    expect(formulaMentions("='Costs'!B5", "B5", "Costs")).toBe(true);
    expect(formulaMentions("=costs!B5", "B5", "Costs")).toBe(true);
  });
});

describe("requireTab", () => {
  const meta: SpreadsheetMeta = {
    id: "1AbC",
    title: "T",
    tabs: [
      { gid: 0, title: "Costs", index: 0, rows: 10, cols: 5, frozenRows: 0 },
      { gid: 7, title: "Notes", index: 2, rows: 10, cols: 5, frozenRows: 0 },
    ],
    otherTitles: ["Chart1"],
    namedRanges: [],
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as AxiError).code;
    }
    return "none";
  };
  it("resolves by title then gid", () => {
    expect(requireTab(meta, "Notes", () => "").gid).toBe(7);
    expect(requireTab(meta, "7", () => "").title).toBe("Notes");
  });
  it("is TAB_REQUIRED on a multi-tab file with no selector, carrying the listing", () => {
    try {
      requireTab(meta, undefined, (t) => `retry ${t}`);
    } catch (e) {
      expect((e as AxiError).code).toBe("TAB_REQUIRED");
      expect((e as AxiError).suggestions[0]).toContain("sheets[2]{gid,title,index,rows,cols}");
    }
  });
  it("is TAB_NOT_FOUND for a missing or chart tab", () => {
    expect(code(() => requireTab(meta, "Nope", () => ""))).toBe("TAB_NOT_FOUND");
    expect(() => requireTab(meta, "Chart1", () => "")).toThrow(/not a grid tab/);
  });
});

describe("duplicateTitle", () => {
  it("translates the duplicate-name 400, and nothing else", () => {
    const dup = {
      message:
        'Invalid requests[0].addSheet: A sheet with the name "q4" already exists. Please enter another name.',
    };
    expect(duplicateTitle(dup, "q4")?.code).toBe("VALIDATION_ERROR");
    expect(duplicateTitle({ message: "Unable to parse range" }, "q4")).toBeUndefined();
  });
});

describe("translateWriteError", () => {
  const ctx = {
    account: "a@example.com",
    operation: "op",
    spreadsheetId: "1AbC",
    range: "Costs!A1",
  };
  const upstream = (message: string, code = 400) => ({
    code,
    message,
    response: { status: code, data: { error: { code, message } } },
  });
  it("classifies the protected-range 400 (observed shape)", () => {
    const e = translateWriteError(
      upstream(
        "You are trying to edit a protected cell or object. Please contact the spreadsheet owner to remove protection if you need to edit.",
      ),
      ctx,
    );
    expect(e.code).toBe("PROTECTED_RANGE");
    expect(e.message).toContain("Costs!A1");
  });
  it("classifies an unparseable range", () => {
    expect(
      translateWriteError(upstream("Invalid data[1]: Unable to parse range: Nope!A1"), ctx).code,
    ).toBe("RANGE_INVALID");
  });
});

describe("legendLine", () => {
  it("lists letter=header and counts the rest past the max", () => {
    const entries = ["A", "B", "C"].map((letter, i) => ({ letter, header: `h${i}` }));
    expect(legendLine(entries)).toBe("Columns in row 1: A=h0, B=h1, C=h2");
    expect(legendLine(entries, 2)).toBe("Columns in row 1: A=h0, B=h1, … 1 more");
  });
});
