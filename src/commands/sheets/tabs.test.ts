import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import type { TabSummary } from "../docs/tabs.js";
import { sheetsCommand } from "../sheets.js";
import {
  type SheetRow,
  TABS_DELETE_HELP,
  TABS_HELP,
  TABS_UPDATE_HELP,
  checkTabUpdate,
  collectSheetErrors,
  countPopulated,
  deleteFixLines,
  diffTabProps,
  parseTabUpdateFlags,
  renderSheetList,
  resolveTabPlacement,
  sheetKind,
  sortQualified,
  toSheetRow,
  undoFlags,
} from "./tabs.js";

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

// ---------------------------------------------------------------------------
// sheets tabs, tabs update, tabs delete (specs/commands/sheets-tabs.md)

function grid(gid: number, title: string, index: number, extra: Partial<SheetRow> = {}): SheetRow {
  return {
    gid,
    title,
    index,
    kind: "grid",
    hidden: false,
    frozenRows: 0,
    frozenCols: 0,
    rows: 1000,
    cols: 26,
    ...extra,
  };
}
const chart = (gid: number, title: string, index: number, hidden = false): SheetRow => ({
  gid,
  title,
  index,
  kind: "chart",
  hidden,
});

// Costs, Notes, Archive, Chart1
const SHEETS: SheetRow[] = [
  grid(0, "Costs", 0, { frozenRows: 1 }),
  grid(1374928, "Notes", 1),
  grid(882013, "Archive", 2, { hidden: true }),
  chart(1190021, "Chart1", 3),
];
const [COSTS, NOTES, ARCHIVE, CHART] = SHEETS;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("sheet rows", () => {
  it("maps upstream's OBJECT sheet type to kind: chart (observed), anything else to other", () => {
    expect(sheetKind(undefined)).toBe("grid");
    expect(sheetKind("GRID")).toBe("grid");
    expect(sheetKind("OBJECT")).toBe("chart");
    expect(sheetKind("DATA_SOURCE")).toBe("other");
  });

  it("carries hidden and both freeze counts for a grid, no grid fields for a chart", () => {
    expect(
      toSheetRow({
        sheetId: 5,
        title: "T",
        index: 2,
        hidden: true,
        gridProperties: { rowCount: 9, columnCount: 3, frozenRowCount: 1, frozenColumnCount: 2 },
      }),
    ).toEqual({
      gid: 5,
      title: "T",
      index: 2,
      kind: "grid",
      hidden: true,
      frozenRows: 1,
      frozenCols: 2,
      rows: 9,
      cols: 3,
    });
    const c = toSheetRow({ sheetId: 6, title: "C", index: 0, sheetType: "OBJECT" });
    expect(c.kind).toBe("chart");
    expect(c.frozenRows).toBeUndefined();
  });

  it("renders the tabs[] listing with yes/no visibility and empty freezes for a chart", () => {
    const out = renderSheetList(SHEETS);
    expect(out).toContain("tabs[4]{gid,title,index,kind,hidden,frozen_rows,frozen_cols}:");
    expect(out).toContain("0,Costs,0,grid,no,1,0");
    expect(out).toContain("882013,Archive,2,grid,yes,0,0");
    expect(out).toContain('1190021,Chart1,3,chart,no,"",""');
  });
});

describe("resolveTabPlacement (before-the-move indices, observed)", () => {
  it("--first is 0, and unchanged for the first sheet", () => {
    expect(resolveTabPlacement(SHEETS, ARCHIVE, { kind: "first" })).toBe(0);
    expect(resolveTabPlacement(SHEETS, COSTS, { kind: "first" })).toBe("unchanged");
  });

  it("--last is the sheet count (chart sheets included), and unchanged for the last sheet", () => {
    expect(resolveTabPlacement(SHEETS, COSTS, { kind: "last" })).toBe(4);
    expect(resolveTabPlacement(SHEETS, CHART, { kind: "last" })).toBe("unchanged");
  });

  it("--after X is X.index + 1 in either direction; unchanged when already right after X", () => {
    // Costs (0) after Notes (1): index 2 — [Notes, Costs, …] (observed for S1 on [S1,S2,S3]).
    expect(resolveTabPlacement(SHEETS, COSTS, { kind: "after", anchor: "Notes" })).toBe(2);
    expect(resolveTabPlacement(SHEETS, CHART, { kind: "after", anchor: "Costs" })).toBe(1);
    expect(resolveTabPlacement(SHEETS, NOTES, { kind: "after", anchor: "Costs" })).toBe(
      "unchanged",
    );
  });

  it("--before X is X.index; unchanged when already right before X", () => {
    expect(resolveTabPlacement(SHEETS, CHART, { kind: "before", anchor: "Notes" })).toBe(1);
    expect(resolveTabPlacement(SHEETS, COSTS, { kind: "before", anchor: "Archive" })).toBe(2);
    expect(resolveTabPlacement(SHEETS, ARCHIVE, { kind: "before", anchor: "Chart1" })).toBe(
      "unchanged",
    );
  });

  it("resolves the anchor by title, then gid", () => {
    expect(resolveTabPlacement(SHEETS, CHART, { kind: "before", anchor: "882013" })).toBe(2);
  });

  it("refuses an anchor that is the moving tab, and an unknown anchor", () => {
    expect(
      codeOf(() => resolveTabPlacement(SHEETS, NOTES, { kind: "after", anchor: "Notes" })),
    ).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => resolveTabPlacement(SHEETS, NOTES, { kind: "after", anchor: "Nope" })),
    ).toBe("TAB_NOT_FOUND");
  });
});

describe("diffTabProps", () => {
  it("sends nothing when every named property already holds", () => {
    const d = diffTabProps(COSTS, {
      title: "Costs",
      index: "unchanged",
      hidden: false,
      frozenRows: 1,
      frozenCols: 0,
    });
    expect(d.fields).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("puts only the differing properties in the mask, each under its upstream name", () => {
    expect(diffTabProps(COSTS, { index: 2 })).toMatchObject({
      properties: { sheetId: 0, index: 2 },
      fields: ["index"],
      changed: ["index"],
    });
    expect(diffTabProps(COSTS, { title: "Costs 2025" })).toMatchObject({
      properties: { title: "Costs 2025" },
      fields: ["title"],
      changed: ["title"],
    });
    expect(diffTabProps(COSTS, { hidden: true })).toMatchObject({
      properties: { hidden: true },
      fields: ["hidden"],
      changed: ["hidden"],
    });
    expect(diffTabProps(COSTS, { frozenRows: 0 })).toMatchObject({
      properties: { gridProperties: { frozenRowCount: 0 } },
      fields: ["gridProperties.frozenRowCount"],
      changed: ["frozen_rows"],
    });
    expect(diffTabProps(COSTS, { frozenCols: 2 })).toMatchObject({
      properties: { gridProperties: { frozenColumnCount: 2 } },
      fields: ["gridProperties.frozenColumnCount"],
      changed: ["frozen_cols"],
    });
  });

  it("treats a case change of the tab's own title as a rename", () => {
    expect(diffTabProps(COSTS, { title: "costs" }).changed).toEqual(["title"]);
  });

  it("orders changed[] index, title, hidden, frozen_rows, frozen_cols", () => {
    expect(
      diffTabProps(NOTES, { frozenCols: 1, hidden: true, title: "N", index: 0, frozenRows: 1 })
        .changed,
    ).toEqual(["index", "title", "hidden", "frozen_rows", "frozen_cols"]);
  });
});

describe("checkTabUpdate", () => {
  const base = { spreadsheetId: "1AbC" };

  it("refuses a title another sheet holds, ignoring case, chart sheets included", () => {
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, title: "costs" }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, title: "CHART1" }))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("accepts the tab's own title in another case", () => {
    expect(codeOf(() => checkTabUpdate(SHEETS, COSTS, { ...base, title: "COSTS" }))).toBe("none");
  });

  it("refuses a freeze at or past the allocation; one less, and 0, are fine", () => {
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, frozenRows: 1000 }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, frozenCols: 26 }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, frozenRows: 999 }))).toBe("none");
    expect(codeOf(() => checkTabUpdate(SHEETS, NOTES, { ...base, frozenCols: 25 }))).toBe("none");
    expect(
      codeOf(() =>
        checkTabUpdate(
          [grid(1, "Tiny", 0, { rows: 1, cols: 1 })],
          grid(1, "Tiny", 0, { rows: 1, cols: 1 }),
          {
            ...base,
            frozenRows: 0,
          },
        ),
      ),
    ).toBe("none");
  });

  it("refuses any freeze on a chart sheet", () => {
    expect(codeOf(() => checkTabUpdate(SHEETS, CHART, { ...base, frozenRows: 0 }))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses hiding the only visible sheet — chart sheets count as visible", () => {
    const allHidden = SHEETS.map((s) => ({ ...s, hidden: s.gid !== NOTES.gid }));
    expect(codeOf(() => checkTabUpdate(allHidden, allHidden[1], { ...base, hidden: true }))).toBe(
      "LAST_VISIBLE_TAB",
    );
    // Notes and Chart1 visible: hiding Notes leaves the chart.
    const chartVisible = SHEETS.map((s) => ({ ...s, hidden: s.gid === 0 || s.gid === 882013 }));
    expect(
      codeOf(() => checkTabUpdate(chartVisible, chartVisible[1], { ...base, hidden: true })),
    ).toBe("none");
  });

  it("names the hidden sheets to show instead", () => {
    expect.assertions(2);
    const allHidden = SHEETS.map((s) => ({ ...s, hidden: s.gid !== NOTES.gid }));
    try {
      checkTabUpdate(allHidden, allHidden[1], { ...base, hidden: true }, "alice@example.com");
    } catch (err) {
      const e = err as AxiError;
      expect(e.suggestions[0]).toContain("Archive (gid 882013)");
      expect(e.suggestions[1]).toContain(
        "gws-axi sheets tabs update 1AbC 0 --show --account alice@example.com",
      );
    }
  });
});

describe("undoFlags", () => {
  it("restores the previous position as --after its predecessor, or --first", () => {
    expect(undoFlags(ARCHIVE, SHEETS, ["index"])).toEqual(["--after Notes"]);
    expect(undoFlags(COSTS, SHEETS, ["index"])).toEqual(["--first"]);
  });

  it("restores exactly what changed: title, visibility, freezes", () => {
    expect(
      undoFlags(ARCHIVE, SHEETS, ["index", "title", "hidden", "frozen_rows", "frozen_cols"]),
    ).toEqual(["--after Notes", "--title Archive", "--hide", "--freeze-rows 0", "--freeze-cols 0"]);
    expect(undoFlags(COSTS, SHEETS, ["hidden", "frozen_rows"])).toEqual([
      "--show",
      "--freeze-rows 1",
    ]);
    expect(undoFlags(grid(1, "Q4 plan", 1), SHEETS, ["title"])).toEqual(["--title 'Q4 plan'"]);
  });
});

describe("parseTabUpdateFlags", () => {
  it("parses every property flag", () => {
    expect(
      parseTabUpdateFlags([
        "1AbC",
        "Archive",
        "--after",
        "Notes",
        "--title",
        "Archive 2025",
        "--hide",
        "--freeze-rows",
        "1",
        "--freeze-cols",
        "0",
      ]),
    ).toEqual({
      spreadsheetId: "1AbC",
      tab: "Archive",
      title: "Archive 2025",
      placement: { kind: "after", anchor: "Notes" },
      hidden: true,
      frozenRows: 1,
      frozenCols: 0,
    });
  });

  it("refuses what the spec lists, before any call", () => {
    const refused = [
      ["1AbC"],
      ["1AbC", "Archive"],
      ["1AbC", "Archive", "--first", "--last"],
      ["1AbC", "Archive", "--before", "A", "--after", "B"],
      ["1AbC", "Archive", "--hide", "--show"],
      ["1AbC", "Archive", "--title", "  "],
      ["1AbC", "Archive", "--freeze-rows", "-1"],
      ["1AbC", "Archive", "--freeze-rows", "1.5"],
      ["1AbC", "Archive", "--freeze-cols", "two"],
      ["1AbC", "Archive", "extra", "--first"],
      ["1AbC", "Archive", "--color", "red"],
    ];
    for (const args of refused) {
      expect(
        codeOf(() => parseTabUpdateFlags(args)),
        args.join(" "),
      ).toBe("VALIDATION_ERROR");
    }
  });
});

describe("tabs delete helpers", () => {
  it("counts populated display cells", () => {
    expect(countPopulated([["a", "", "b"], [], ["", "0"]])).toBe(3);
    expect(countPopulated(undefined)).toBe(0);
  });

  it("qualifies error cells by tab and skips the deleted sheet", () => {
    const err = (type: string) => ({ effectiveValue: { errorValue: { type, message: "m" } } });
    const errors = collectSheetErrors(
      [
        {
          properties: { sheetId: 0, title: "Costs" },
          data: [{ rowData: [{ values: [{}, err("REF")] }] }],
        },
        {
          properties: { sheetId: 7, title: "Q4 plan" },
          data: [{ rowData: [{ values: [err("NAME")] }] }],
        },
        {
          properties: { sheetId: 9, title: "Gone" },
          data: [{ rowData: [{ values: [err("REF")] }] }],
        },
        { properties: { sheetId: 10, title: "Chart1" } },
      ],
      9,
    );
    expect([...errors.keys()]).toEqual(["Costs!B1", "'Q4 plan'!A1"]);
    expect(errors.get("Costs!B1")).toEqual({ cell: "Costs!B1", error: "REF", message: "m" });
  });

  it("sorts errors by sheet order, then row-major", () => {
    const rows = [
      { cell: "Notes!A1" },
      { cell: "Costs!D10" },
      { cell: "Costs!D2" },
      { cell: "Costs!A3" },
    ];
    expect(sortQualified(rows, SHEETS).map((r) => r.cell)).toEqual([
      "Costs!D2",
      "Costs!A3",
      "Costs!D10",
      "Notes!A1",
    ]);
  });

  it("writes the write side's fix line with the cell tab-qualified", () => {
    const lines = deleteFixLines(
      [
        { cell: "Costs!D2", error: "REF", message: "Unresolved sheet name 'Archive'." },
        { cell: "'Q4 plan'!B3", error: "REF", message: "" },
      ],
      new Map([["Costs!D2", "=Archive!B2"]]),
      { spreadsheetId: "1AbC", account: "alice@example.com" },
    );
    expect(lines).toEqual([
      "Fix Costs!D2 (#REF!, Unresolved sheet name 'Archive'.): gws-axi sheets update 1AbC --tab Costs --cell D2='=Archive!B2' --account alice@example.com",
      "Fix 'Q4 plan'!B3 (#REF!): gws-axi sheets cell 1AbC B3 --tab 'Q4 plan'",
    ]);
  });
});

describe("sheets dispatcher: two-word tabs subcommands", () => {
  it("routes --help to each of tabs, tabs update, tabs delete", async () => {
    expect(await sheetsCommand(["tabs", "--help"])).toBe(TABS_HELP);
    expect(await sheetsCommand(["tabs", "update", "--help"])).toBe(TABS_UPDATE_HELP);
    expect(await sheetsCommand(["tabs", "delete", "--help"])).toBe(TABS_DELETE_HELP);
  });

  it("refuses an unknown flag on a tab write before resolving an account", async () => {
    let code = "none";
    try {
      await sheetsCommand(["tabs", "update", "1AbC", "Costs", "--colour", "red"]);
    } catch (err) {
      code = (err as AxiError).code;
    }
    expect(code).toBe("VALIDATION_ERROR");
  });
});
