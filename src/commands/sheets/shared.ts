import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { translateGoogleError } from "../../google/client.js";
import { field, renderList, type FieldDef } from "../../output/index.js";

/**
 * What `sheets read`, the `sheets` writers and `sheets cell` share: A1
 * addressing, the tab listing and how a tab is chosen, and the formula-error
 * vocabulary (specs/commands/sheets-write.md § Formula errors). One
 * implementation, so a read and a write resolve a tab — and word an error —
 * the same way.
 */

// ---------------------------------------------------------------------------
// A1 addressing

/** 0-based column index → A1 column letter (0→A, 25→Z, 26→AA). */
export function columnLetter(index0: number): string {
  let n = index0;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** A1 column letters → 0-based column index (A→0, Z→25, AA→26). */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** `B2` for 0-based (row, col). */
export function cellA1(row0: number, col0: number): string {
  return `${columnLetter(col0)}${row0 + 1}`;
}

/** A rectangle of cells, 0-based, end-exclusive. */
export interface GridRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** `B2` for a single cell, `B2:D9` otherwise. */
export function rectA1(rect: GridRect): string {
  const start = cellA1(rect.r0, rect.c0);
  if (rect.r1 - rect.r0 === 1 && rect.c1 - rect.c0 === 1) return start;
  return `${start}:${cellA1(rect.r1 - 1, rect.c1 - 1)}`;
}

/**
 * A parsed A1 reference within one tab. Column-only (`B:D`) and row-only
 * (`3:9`) forms leave the other axis open; `toRect` fills it from the tab's
 * allocation.
 */
export interface A1Ref {
  kind: "cell" | "range" | "cols" | "rows";
  r0?: number;
  r1?: number;
  c0?: number;
  c1?: number;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/;
const COL = /^\$?([A-Za-z]{1,3})$/;
const ROW = /^\$?([1-9][0-9]*)$/;

/** Parse an unqualified A1 reference; `undefined` when it isn't one. */
export function parseA1(a1: string): A1Ref | undefined {
  const parts = a1.trim().split(":");
  if (parts.length === 1) {
    const m = CELL.exec(parts[0]);
    if (!m) return undefined;
    const r = Number(m[2]) - 1;
    const c = columnIndex(m[1]);
    return { kind: "cell", r0: r, r1: r + 1, c0: c, c1: c + 1 };
  }
  if (parts.length !== 2) return undefined;
  const [a, b] = parts;
  const ca = CELL.exec(a);
  const cb = CELL.exec(b);
  if (ca && cb) {
    const [ra, rb] = [Number(ca[2]) - 1, Number(cb[2]) - 1];
    const [ka, kb] = [columnIndex(ca[1]), columnIndex(cb[1])];
    return {
      kind: "range",
      r0: Math.min(ra, rb),
      r1: Math.max(ra, rb) + 1,
      c0: Math.min(ka, kb),
      c1: Math.max(ka, kb) + 1,
    };
  }
  // Open-ended: `B2:B` (from row 2 down) and `A3:3` (from column A across).
  if (ca && COL.exec(b)) {
    const [ka, kb] = [columnIndex(ca[1]), columnIndex(COL.exec(b)![1])];
    return { kind: "cols", r0: Number(ca[2]) - 1, c0: Math.min(ka, kb), c1: Math.max(ka, kb) + 1 };
  }
  if (ca && ROW.exec(b)) {
    const [ra, rb] = [Number(ca[2]) - 1, Number(ROW.exec(b)![1]) - 1];
    return { kind: "rows", c0: columnIndex(ca[1]), r0: Math.min(ra, rb), r1: Math.max(ra, rb) + 1 };
  }
  const cola = COL.exec(a);
  const colb = COL.exec(b);
  if (cola && colb) {
    const [ka, kb] = [columnIndex(cola[1]), columnIndex(colb[1])];
    return { kind: "cols", c0: Math.min(ka, kb), c1: Math.max(ka, kb) + 1 };
  }
  const rowa = ROW.exec(a);
  const rowb = ROW.exec(b);
  if (rowa && rowb) {
    const [ra, rb] = [Number(rowa[1]) - 1, Number(rowb[1]) - 1];
    return { kind: "rows", r0: Math.min(ra, rb), r1: Math.max(ra, rb) + 1 };
  }
  return undefined;
}

/** Close a reference's open axis with the tab's allocation. */
export function toRect(ref: A1Ref, grid: { rows: number; cols: number }): GridRect {
  const r0 = ref.r0 ?? 0;
  const c0 = ref.c0 ?? 0;
  return {
    r0,
    r1: ref.r1 ?? Math.max(grid.rows, r0 + 1),
    c0,
    c1: ref.c1 ?? Math.max(grid.cols, c0 + 1),
  };
}

/** A whole-row or whole-column range for the dimension verbs, 0-based, end-exclusive. */
export interface DimensionRange {
  kind: "rows" | "cols";
  start0: number;
  end0: number;
  /** The tab the range names (`Costs!3:5`), when it names one. */
  tabTitle?: string;
}

/**
 * Parse a dimension range (specs/commands/sheets-dimensions.md): rows as `3:5`
 * or `3`, columns as `B:D` or `B`, either tab-qualified. A range of the other
 * kind, or any cell range, is refused naming the two forms — never
 * reinterpreted.
 */
export function parseDimensionRange(text: string, kind: "rows" | "cols"): DimensionRange {
  const { tabTitle, a1 } = splitQualifiedRange(text.trim());
  const parts = a1.split(":");
  const re = kind === "rows" ? ROW : COL;
  const index = (m: RegExpExecArray) => (kind === "rows" ? Number(m[1]) - 1 : columnIndex(m[1]));
  const matches = parts.map((p) => re.exec(p));
  if ((parts.length === 1 || parts.length === 2) && matches.every((m) => m)) {
    const [a, b = a] = matches.map((m) => index(m as RegExpExecArray));
    return { kind, start0: Math.min(a, b), end0: Math.max(a, b) + 1, tabTitle };
  }
  const other = kind === "rows" ? "cols" : "rows";
  const ofOther =
    (parts.length === 1 || parts.length === 2) &&
    parts.every((p) => (other === "rows" ? ROW : COL).exec(p));
  const verbs = kind === "rows" ? "insert-rows / delete-rows" : "insert-cols / delete-cols";
  const otherVerbs = kind === "rows" ? "insert-cols / delete-cols" : "insert-rows / delete-rows";
  throw new AxiError(
    ofOther
      ? `'${text}' is a ${other === "rows" ? "row" : "column"} range; ${verbs} take${kind === "rows" ? " rows" : " columns"}`
      : `'${text}' is not a ${kind === "rows" ? "row" : "column"} range`,
    "VALIDATION_ERROR",
    [
      kind === "rows"
        ? "Give rows as 3:5 (rows 3 to 5) or 3 (one row), optionally tab-qualified: 'Costs!3:5'"
        : "Give columns as B:D (columns B to D) or B (one column), optionally tab-qualified: 'Costs!B:D'",
      ofOther
        ? `For ${other === "rows" ? "rows" : "columns"}, use ${otherVerbs}`
        : "A cell range (B2:D9) is not accepted: these verbs move whole rows or columns",
      "Nothing was changed",
    ],
  );
}

export interface RangeOrigin {
  col0: number;
  row1: number;
}

/**
 * Parse the top-left origin of a range echo. Handles a bare range (`C5:E9`), a
 * tab-qualified range (`Costs!C5:E9`), quoted titles that may contain `!`
 * (`'My Sheet!x'!A1:B2`), absolute refs (`$C$5`), and open-ended ranges
 * (`Costs!A:D` → row 1; `Costs!5:9` → col A). Falls back to A1 when the origin
 * can't be determined, so a parse miss degrades to a safe default rather than
 * mis-addressing.
 */
export function parseRangeOrigin(range: string | undefined | null): RangeOrigin {
  const fallback: RangeOrigin = { col0: 0, row1: 1 };
  if (!range) return fallback;
  const { a1 } = splitQualifiedRange(range);
  const start = a1.split(":")[0] ?? "";
  const m = start.match(/^\$?([A-Za-z]+)?\$?([0-9]+)?$/);
  if (!m) return fallback;
  const [, letters, digits] = m;
  return {
    col0: letters ? columnIndex(letters) : 0,
    row1: digits ? Number(digits) : 1,
  };
}

/** Split a possibly tab-qualified A1 range into { tabTitle?, a1 }. */
export function splitQualifiedRange(range: string): { tabTitle?: string; a1: string } {
  if (range.startsWith("'")) {
    const close = range.indexOf("'!", 1);
    if (close !== -1) {
      return {
        tabTitle: range.slice(1, close).replace(/''/g, "'"),
        a1: range.slice(close + 2),
      };
    }
  }
  const bang = range.lastIndexOf("!");
  if (bang !== -1) {
    return { tabTitle: range.slice(0, bang), a1: range.slice(bang + 1) };
  }
  return { a1: range };
}

/**
 * Quote a tab title for an A1 range sent upstream. Always quoted: a bare title
 * that is also A1 notation (`Q4`, `FY24`, `AB12`) names a CELL on the first
 * sheet when it stands alone as a range (observed: `values.get` of `Q4`
 * returned `Sheet1!Q4`).
 */
export function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** A tab title as a reader would write it in front of `!`: quoted only when needed. */
export function displayTitle(title: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(title) && !/^[A-Za-z]{1,3}[0-9]+$/.test(title)
    ? title
    : `'${title.replace(/'/g, "''")}'`;
}

/** Quote one argument for a POSIX shell, only when it needs it. */
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `D2='=B2*C2'` — a `--cell` argument with its value always single-quoted. */
export function cellArg(cell: string, value: string): string {
  return `${cell}='${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Tabs

export interface TabInfo {
  gid: number;
  title: string;
  index: number;
  rows: number;
  cols: number;
  frozenRows: number;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}

export function toTabInfo(props: sheets_v4.Schema$SheetProperties): TabInfo {
  return {
    gid: props.sheetId ?? 0,
    title: props.title ?? "",
    index: props.index ?? 0,
    rows: props.gridProperties?.rowCount ?? 0,
    cols: props.gridProperties?.columnCount ?? 0,
    frozenRows: props.gridProperties?.frozenRowCount ?? 0,
  };
}

export const TABS_SCHEMA: FieldDef[] = [
  field("gid"),
  field("title"),
  field("index"),
  field("rows"),
  field("cols"),
];

export function renderTabs(tabs: TabInfo[], row1?: Map<number, string>): string {
  if (!row1) return renderList("sheets", tabs, TABS_SCHEMA);
  return renderList(
    "sheets",
    tabs.map((t) => ({ ...t, row1: row1.get(t.gid) ?? "" })),
    [...TABS_SCHEMA, field("row1")],
  );
}

// ---------------------------------------------------------------------------
// row1 (specs/commands/sheets-read.md § sheets[N]): each tab's first-row text,
// for the listings an agent chooses a tab from.

/** Tabs that get `row1` (one `ranges` entry each, on one request). */
export const ROW1_TAB_CAP = 100;
const ROW1_CHARS = 120;

/** Non-empty cells joined with `, `, capped at 120 characters. */
export function row1Text(cells: Array<string | null | undefined>): string {
  const text = cells
    .map((c) => (c ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return text.length > ROW1_CHARS ? `${text.slice(0, ROW1_CHARS - 1)}…` : text;
}

/** Row 1 of up to ROW1_TAB_CAP tabs in one call, by gid. Best-effort. */
export async function fetchRow1(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  tabs: TabInfo[],
): Promise<{ row1: Map<number, string> } | { unavailable: string }> {
  const chosen = tabs.slice(0, ROW1_TAB_CAP);
  if (chosen.length === 0) return { row1: new Map() };
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      ranges: chosen.map((t) => `${quoteTitle(t.title)}!1:1`),
      includeGridData: true,
      fields: "sheets(properties(sheetId),data(rowData(values(formattedValue))))",
    });
    const row1 = new Map<number, string>();
    for (const sheet of res.data.sheets ?? []) {
      const gid = sheet.properties?.sheetId ?? 0;
      const values = sheet.data?.[0]?.rowData?.[0]?.values ?? [];
      row1.set(gid, row1Text(values.map((v) => v.formattedValue)));
    }
    return { row1 };
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The spreadsheet a TAB_REQUIRED error came from, so the `sheets` dispatcher
 * can re-render its listing with `row1` (requireTab itself stays synchronous).
 */
export const TAB_REQUIRED_CONTEXT = Symbol("tabRequiredContext");
export interface TabRequiredContext {
  meta: SpreadsheetMeta;
  /** The suggestions after the listing (the retry line, the "nothing written" note). */
  rest: string[];
}

export interface SpreadsheetMeta {
  id: string;
  title: string;
  /** Grid tabs only — the addressable ones. */
  tabs: TabInfo[];
  /** Titles of tabs that are not grids (chart sheets, data-source sheets). */
  otherTitles: string[];
  namedRanges: sheets_v4.Schema$NamedRange[];
  /** The spreadsheet's locale (`en_US`, `de_DE`), which decides how typed text parses. */
  locale?: string;
}

export const META_FIELDS =
  "spreadsheetId,properties(title,locale),sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))";

/** The SPREADSHEET_NOT_FOUND translation every sheets command shares. */
export function spreadsheetNotFound(spreadsheetId: string, account: string): AxiError {
  return new AxiError(
    `Spreadsheet '${spreadsheetId}' not found (or ${account} doesn't have access)`,
    "SPREADSHEET_NOT_FOUND",
    [
      `Verify the spreadsheet ID is correct (the portion of the URL after /d/)`,
      `Confirm ${account} has at least view access`,
      `If this is an uploaded .xlsx/.csv (not a native Google Sheet), use \`gws-axi drive download ${spreadsheetId}\` or convert it with \`gws-axi drive upload --convert\``,
    ],
  );
}

/** Read a spreadsheet's tabs (no cell data). */
export async function fetchMeta(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
  opts: { namedRanges?: boolean } = {},
): Promise<SpreadsheetMeta> {
  let data: sheets_v4.Schema$Spreadsheet;
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      fields: opts.namedRanges ? `${META_FIELDS},namedRanges(name,range)` : META_FIELDS,
    });
    data = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "sheets.spreadsheets.get" });
    if (translated.code === "NOT_FOUND") throw spreadsheetNotFound(spreadsheetId, account);
    throw translated;
  }
  const props = (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is sheets_v4.Schema$SheetProperties => !!p);
  return {
    id: data.spreadsheetId ?? spreadsheetId,
    title: data.properties?.title ?? "",
    tabs: props.filter((p) => (p.sheetType ?? "GRID") === "GRID").map(toTabInfo),
    otherTitles: props.filter((p) => (p.sheetType ?? "GRID") !== "GRID").map((p) => p.title ?? ""),
    namedRanges: data.namedRanges ?? [],
    locale: data.properties?.locale ?? undefined,
  };
}

/** Title first, then numeric gid — `sheets read`'s resolution order. */
export function findTab(tabs: TabInfo[], selector: string): TabInfo | undefined {
  return tabs.find((t) => t.title === selector) ?? tabs.find((t) => String(t.gid) === selector);
}

function availableTabs(tabs: TabInfo[]): string {
  return tabs.map((t) => `${t.title} (gid ${t.gid})`).join(", ") || "none";
}

export function tabNotFound(meta: SpreadsheetMeta, selector: string, what = "Tab"): AxiError {
  const chart = meta.otherTitles.includes(selector);
  return new AxiError(
    chart
      ? `${what} '${selector}' is not a grid tab (a chart or data-source sheet has no cells to address)`
      : `${what} '${selector}' not found in spreadsheet '${meta.id}'`,
    "TAB_NOT_FOUND",
    [
      `Available tabs: ${availableTabs(meta.tabs)}`,
      `Run \`gws-axi sheets read ${meta.id}\` to list tabs`,
    ],
  );
}

/**
 * The tab a write targets: the selector (from `--tab` or a qualified range),
 * else the only tab. A multi-tab spreadsheet with no selector is TAB_REQUIRED —
 * there is no all-tabs write.
 */
export function requireTab(
  meta: SpreadsheetMeta,
  selector: string | undefined,
  retry: (tab: string) => string,
  opts: { read?: boolean } = {},
): TabInfo {
  if (selector !== undefined) {
    const tab = findTab(meta.tabs, selector);
    if (!tab) throw tabNotFound(meta, selector);
    return tab;
  }
  if (meta.tabs.length === 1) return meta.tabs[0];
  const rest = [
    `Run \`${retry(meta.tabs[0]?.title ?? "<name>")}\` (or another title / gid above)`,
    ...(opts.read
      ? []
      : [
          "Nothing was written. There is no all-tabs write; `gws-axi drive upload --update --replace-all-tabs` replaces the whole file",
        ]),
  ];
  const err = new AxiError(
    `Spreadsheet '${meta.id}' has ${meta.tabs.length} tabs — pass --tab <name|gid> to choose one`,
    "TAB_REQUIRED",
    [renderTabs(meta.tabs), ...rest],
  );
  (err as unknown as Record<symbol, TabRequiredContext>)[TAB_REQUIRED_CONTEXT] = { meta, rest };
  throw err;
}

/** `https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>` — opens on the tab. */
export function tabLink(spreadsheetId: string, gid: number): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;
}

// ---------------------------------------------------------------------------
// Cells as the API returns them

export interface CellValueLike {
  stringValue?: string | null;
  numberValue?: number | null;
  boolValue?: boolean | null;
  formulaValue?: string | null;
  errorValue?: { type?: string | null; message?: string | null } | null;
}

export interface CellLike {
  userEnteredValue?: CellValueLike | null;
  effectiveValue?: CellValueLike | null;
  formattedValue?: string | null;
  effectiveFormat?: { numberFormat?: { type?: string | null } | null } | null;
}

export interface GridDataLike {
  startRow?: number | null;
  startColumn?: number | null;
  rowData?: Array<{ values?: CellLike[] | null }> | null;
}

/** Every cell a GridData carries, keyed by A1 (no tab), with 0-based coordinates. */
export function gridCells(
  data: GridDataLike[] | undefined | null,
): Map<string, { row0: number; col0: number; cell: CellLike }> {
  const out = new Map<string, { row0: number; col0: number; cell: CellLike }>();
  for (const grid of data ?? []) {
    const r0 = grid.startRow ?? 0;
    const c0 = grid.startColumn ?? 0;
    (grid.rowData ?? []).forEach((row, i) => {
      (row.values ?? []).forEach((cell, j) => {
        out.set(cellA1(r0 + i, c0 + j), { row0: r0 + i, col0: c0 + j, cell });
      });
    });
  }
  return out;
}

/** True when the cell holds nothing (no entered value). */
export function isEmptyCell(cell: CellLike | undefined): boolean {
  const v = cell?.userEnteredValue;
  if (!v) return true;
  return (
    v.stringValue == null &&
    v.numberValue == null &&
    v.boolValue == null &&
    v.formulaValue == null &&
    v.errorValue == null
  );
}

/** A cell's entered text: the formula for a formula, else what it displays. */
export function enteredText(cell: CellLike | undefined): string {
  if (!cell) return "";
  const v = cell.userEnteredValue;
  if (v?.formulaValue != null) return v.formulaValue;
  if (cell.formattedValue != null) return cell.formattedValue;
  if (v?.stringValue != null) return v.stringValue;
  if (v?.numberValue != null) return String(v.numberValue);
  if (v?.boolValue != null) return v.boolValue ? "TRUE" : "FALSE";
  return "";
}

// ---------------------------------------------------------------------------
// Formula errors (specs/commands/sheets-write.md § Formula errors)

/** What the editor shows for each `errorValue.type`. */
const ERROR_TEXT: Record<string, string> = {
  REF: "#REF!",
  NAME: "#NAME?",
  VALUE: "#VALUE!",
  DIVIDE_BY_ZERO: "#DIV/0!",
  N_A: "#N/A",
  NUM: "#NUM!",
  NULL_VALUE: "#NULL!",
  ERROR: "#ERROR!",
  LOADING: "Loading…",
};

export function errorText(type: string | undefined | null): string {
  return (type && ERROR_TEXT[type]) || "#ERROR!";
}

export interface CellError {
  cell: string;
  error: string;
  message: string;
}

/** The error cells in fetched grid data (an errors-only mask suffices). */
export function collectErrors(data: GridDataLike[] | undefined | null): Map<string, CellError> {
  const out = new Map<string, CellError>();
  for (const [a1, { cell }] of gridCells(data)) {
    const err = cell.effectiveValue?.errorValue;
    if (err) out.set(a1, { cell: a1, error: err.type ?? "ERROR", message: err.message ?? "" });
  }
  return out;
}

export interface ReportedError extends CellError {
  /** The block named this cell; otherwise it is collateral. */
  written: boolean;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}

export interface ErrorDiff {
  errors: ReportedError[];
  fixed: number;
  elsewhere: number;
}

/**
 * Report the diff, not the state: an error is reported when it is new (or
 * changed) or the write named its cell; a cell that errored before and does
 * not now is fixed; the rest were there already and are only counted.
 */
export function diffErrors(
  before: Map<string, CellError>,
  after: Map<string, CellError>,
  written: Set<string>,
): ErrorDiff {
  const errors: ReportedError[] = [];
  let elsewhere = 0;
  for (const [cell, err] of after) {
    const prev = before.get(cell);
    const same = prev && prev.error === err.error && prev.message === err.message;
    if (written.has(cell) || !same) errors.push({ ...err, written: written.has(cell) });
    else elsewhere++;
  }
  let fixed = 0;
  for (const cell of before.keys()) if (!after.has(cell)) fixed++;
  errors.sort((a, b) => compareA1(a.cell, b.cell));
  return { errors, fixed, elsewhere };
}

/** Row-major order for A1 cells. */
export function compareA1(a: string, b: string): number {
  const pa = parseA1(a);
  const pb = parseA1(b);
  if (!pa || !pb) return a.localeCompare(b);
  return (pa.r0 ?? 0) - (pb.r0 ?? 0) || (pa.c0 ?? 0) - (pb.c0 ?? 0);
}

/**
 * Does a formula on `homeTab` read `cell` (of the same tab)? Uses the formula
 * tokenizer, so ranges, whole and open-ended columns/rows count, string
 * literals don't, and a ref qualified with another tab is not this cell.
 */
export function formulaMentions(formula: string, cell: string, homeTab?: string): boolean {
  const target = parseA1(cell);
  if (!target) return false;
  const tr = target.r0 ?? 0;
  const tc = target.c0 ?? 0;
  const huge = { rows: Number.MAX_SAFE_INTEGER, cols: Number.MAX_SAFE_INTEGER };
  for (const ref of parseFormulaRefs(formula)) {
    if (!ref.a1) continue;
    if (ref.tab !== undefined && ref.tab.toLowerCase() !== (homeTab ?? "").toLowerCase()) continue;
    const parsed = parseA1(ref.a1);
    if (!parsed) continue;
    const r = toRect(parsed, huge);
    if (tr >= r.r0 && tr < r.r1 && tc >= r.c0 && tc < r.c1) return true;
  }
  return false;
}

/**
 * One runnable fix per error (up to 5), carrying the cell's current formula so
 * the agent edits rather than re-derives it, then the `sheets cell` line for
 * the first. A collateral error names the written cell its formula reads.
 */
export function fixLines(
  errors: Array<CellError & { written?: boolean }>,
  formulas: Map<string, string>,
  ctx: {
    spreadsheetId: string;
    tabTitle: string;
    account?: string;
    /** Cells this write named — for the "depends on" note. */
    writtenCells?: string[];
  },
): string[] {
  const lines: string[] = [];
  const tab = shellArg(ctx.tabTitle);
  const acct = ctx.account ? ` --account ${ctx.account}` : "";
  for (const err of errors.slice(0, 5)) {
    const formula = formulas.get(err.cell);
    const why = `${errorText(err.error)}${err.message ? `, ${err.message}` : ""}`;
    let dep = "";
    if (err.written === false && formula && ctx.writtenCells) {
      const cause = ctx.writtenCells.find((c) => formulaMentions(formula, c, ctx.tabTitle));
      if (cause) dep = ` — reads ${cause}, which this write changed`;
    }
    const fix = formula
      ? `gws-axi sheets update ${ctx.spreadsheetId} --tab ${tab} --cell ${cellArg(err.cell, formula)}${acct}`
      : `gws-axi sheets cell ${ctx.spreadsheetId} ${err.cell} --tab ${tab}`;
    lines.push(`Fix ${err.cell} (${why})${dep}: ${fix}`);
  }
  if (errors.length > 0) {
    lines.push(
      `Run \`gws-axi sheets cell ${ctx.spreadsheetId} ${errors[0].cell} --tab ${tab}\` to see the formula with the current values it reads`,
    );
  }
  return lines;
}

/** The error-count line that leads help[] whenever errors[] is non-empty. */
export function errorCountLine(n: number, after: "write" | "read"): string {
  const noun = n === 1 ? "formula error" : "formula errors";
  return after === "write"
    ? `${n} ${noun} after this write — see errors[]`
    : `${n} cell(s) show formula errors — see errors[]`;
}

// ---------------------------------------------------------------------------
// Formula references

export interface FormulaRef {
  /** The reference as written (`Cost!B2:B500`, `Rate`, `INDIRECT(...)`). */
  text: string;
  tab?: string;
  /** Unqualified A1 for a cell/range/column/row reference. */
  a1?: string;
  /** A name that is not an A1 reference — a named range, if one resolves. */
  name?: string;
  /** Computed at evaluation time; no static target. */
  dynamic?: boolean;
}

const DYNAMIC = new Set(["INDIRECT", "OFFSET"]);
const QUALIFIER = /([A-Za-z0-9_.]+)!/y;
const FUNCTION = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/y;
const CELL_OR_RANGE =
  /(\$?[A-Za-z]{1,3}\$?[0-9]+:\$?[A-Za-z]{1,3}\$?[0-9]+|\$?[A-Za-z]{1,3}\$?[0-9]+:\$?[A-Za-z]{1,3}|\$?[A-Za-z]{1,3}\$?[0-9]+:\$?[0-9]+|\$?[A-Za-z]{1,3}\$?[0-9]+|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[0-9]+:\$?[0-9]+)(?![A-Za-z0-9_(!:])/y;
const WORD = /[A-Za-z_][A-Za-z0-9_.]*/y;
const NUMBER = /[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?/y;

function stick(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(s);
}

/** The text of a balanced `(...)` starting at `open`. */
function balanced(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '"') {
      i++;
      while (i < s.length && !(s[i] === '"' && s[i + 1] !== '"')) i += s[i] === '"' ? 2 : 1;
      continue;
    }
    if (s[i] === "(") depth++;
    if (s[i] === ")" && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
}

/**
 * The references in a formula, in order, deduplicated: A1 cells and ranges
 * (absolute, tab-qualified, whole columns/rows), names, and INDIRECT/OFFSET as
 * dynamic. String literals are skipped; a function name is never a reference.
 */
export function parseFormulaRefs(formula: string): FormulaRef[] {
  const s = formula.startsWith("=") ? formula.slice(1) : formula;
  const out: FormulaRef[] = [];
  const seen = new Set<string>();
  const push = (ref: FormulaRef) => {
    const key = `${ref.tab ?? ""}!${ref.a1 ?? ref.name ?? ref.text}`.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  const readRef = (at: number, tab?: string): number => {
    const m = stick(CELL_OR_RANGE, s, at);
    if (m) {
      const a1 = m[1].replace(/\$/g, "").toUpperCase();
      push({ text: m[0], tab, a1 });
      return at + m[0].length;
    }
    const w = stick(WORD, s, at);
    if (w) {
      push({ text: w[0], tab, name: w[0] });
      return at + w[0].length;
    }
    return at;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') break;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let name = "";
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          name += "'";
          j += 2;
        } else if (s[j] === "'") break;
        else name += s[j++];
      }
      if (s[j + 1] === "!") {
        i = readRef(j + 2, name);
        continue;
      }
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const q = stick(QUALIFIER, s, i);
      if (q && !/^[0-9]/.test(q[1])) {
        i = readRef(i + q[0].length, q[1]);
        continue;
      }
      const fn = stick(FUNCTION, s, i);
      if (fn) {
        if (DYNAMIC.has(fn[1].toUpperCase())) {
          const open = i + fn[0].length - 1;
          push({ text: `${fn[1]}${balanced(s, open)}`, dynamic: true });
        }
        i += fn[0].length;
        continue;
      }
      const ref = stick(CELL_OR_RANGE, s, i);
      if (ref) {
        push({ text: ref[0], a1: ref[1].replace(/\$/g, "").toUpperCase() });
        i += ref[0].length;
        continue;
      }
      const w = stick(WORD, s, i);
      if (w) {
        if (!/^(TRUE|FALSE)$/i.test(w[0])) push({ text: w[0], name: w[0] });
        i += w[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const ref = stick(CELL_OR_RANGE, s, i);
      if (ref) {
        push({ text: ref[0], a1: ref[1].replace(/\$/g, "") });
        i += ref[0].length;
        continue;
      }
      const n = stick(NUMBER, s, i);
      i += n ? n[0].length : 1;
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream write errors

/** The duplicate-name 400 (the tabs changed since the read), as a VALIDATION_ERROR. */
export function duplicateTitle(err: unknown, title: string): AxiError | undefined {
  const e = err as { message?: string; response?: { data?: { error?: { message?: string } } } };
  const message = e?.response?.data?.error?.message ?? e?.message ?? "";
  if (!/already exists/i.test(message)) return undefined;
  return new AxiError(
    `A sheet titled '${title}' already exists (titles are unique, ignoring case)`,
    "VALIDATION_ERROR",
    [`Run \`gws-axi sheets read <spreadsheetId>\` to list the tabs`, "Nothing was added"],
  );
}

/**
 * Translate a values-call failure: a protected range (a 400 that names no
 * range — observed), an A1 reference upstream could not parse, else the shared
 * translation.
 */
export function translateWriteError(
  err: unknown,
  ctx: { account: string; operation: string; spreadsheetId: string; range: string },
): AxiError {
  const message = errorMessage(err);
  if (/protected cell or object/i.test(message)) {
    return new AxiError(
      `${ctx.range} is protected — ${ctx.account} may not edit it`,
      "PROTECTED_RANGE",
      [
        "An editor of the protected range must remove the protection or make this change",
        `Run \`gws-axi drive permissions ${ctx.spreadsheetId}\` to see who has access`,
        "Nothing was written",
      ],
    );
  }
  if (/Unable to parse range/i.test(message)) {
    return new AxiError(`Upstream could not parse the range: ${message}`, "RANGE_INVALID", [
      "Use an A1 reference within the tab: B2, B2:D9, B:B or 3:3",
      `Run \`gws-axi sheets read ${ctx.spreadsheetId}\` to list the tabs`,
    ]);
  }
  const translated = translateGoogleError(err, {
    account: ctx.account,
    operation: ctx.operation,
  });
  if (translated.code === "NOT_FOUND") {
    return spreadsheetNotFound(ctx.spreadsheetId, ctx.account);
  }
  return translated;
}

function errorMessage(err: unknown): string {
  const e = err as {
    message?: string;
    response?: { data?: { error?: { message?: string } } };
  };
  return e?.response?.data?.error?.message ?? e?.message ?? "";
}

// ---------------------------------------------------------------------------
// Header legend (specs/commands/sheets-query.md § Header legend, sheets-read.md)

/** One column of a tab's header row: its A1 letter and the name it is read by. */
export interface LegendEntry {
  letter: string;
  header: string;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}

export const LEGEND_SCHEMA: FieldDef[] = [field("letter"), field("header")];

/** Rows of `headers[N]` before `headers_total`. */
export const LEGEND_CAP = 100;

export function renderLegend(entries: LegendEntry[]): string {
  return renderList("headers", entries.slice(0, LEGEND_CAP), LEGEND_SCHEMA);
}

/** The compact form a QUERY_ERROR carries: `Columns in row 1: A=Item, B=Qty, … 4 more`. */
export function legendLine(entries: LegendEntry[], max = 30): string {
  const shown = entries
    .slice(0, max)
    .map((e) => `${e.letter}=${e.header}`)
    .join(", ");
  const rest = entries.length - max;
  return `Columns in row 1: ${shown}${rest > 0 ? `, … ${rest} more` : ""}`;
}
