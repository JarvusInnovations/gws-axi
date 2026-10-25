import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { sheetsClient, translateGoogleError } from "../../google/client.js";
import {
  type FieldDef,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
} from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import { buildGrid } from "./read.js";
import {
  type CellError,
  type DimensionRange,
  type ErrorDiff,
  type GridDataLike,
  type TabInfo,
  cellA1,
  cellArg,
  collectErrors,
  columnLetter,
  diffErrors,
  displayTitle,
  enteredText,
  errorText,
  fetchMeta,
  fixLines,
  gridCells,
  isEmptyCell,
  parseA1,
  parseDimensionRange,
  quoteTitle,
  shellArg,
  translateWriteError,
} from "./shared.js";
import {
  ERROR_SCAN_BOUND,
  TARGET_FIELDS,
  WRITTEN_CAP,
  errorHeader,
  fetchGrid,
  outcomeBlocks,
  revisionsLine,
  spreadsheetBlock,
  tabFromFlags,
} from "./write.js";

/**
 * `sheets insert-rows`, `insert-cols`, `delete-rows`, `delete-cols`
 * (specs/commands/sheets-dimensions.md): one `insertDimension` /
 * `deleteDimension` per call, with the tab-wide formula-error diff the value
 * writes report, the move stated in old-row terms, and — for a delete — the
 * populated cells it removed as the undo record.
 */

export type DimOp = "insert" | "delete";
export type Dim = "rows" | "cols";

// ---------------------------------------------------------------------------
// Help + flags

const RANGE_ARG = {
  rows: `  <rows>               A row range: 3:5 (rows 3 to 5) or 3 (one row). A
                       tab-qualified range ('Costs!3:5') makes --tab optional`,
  cols: `  <cols>               A column range: B:D (columns B to D) or B (one column). A
                       tab-qualified range ('Costs!B:D') makes --tab optional`,
};

const TAB_FLAG = `  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet unless the range names it`;

function insertHelp(dim: Dim): string {
  const [arg, noun, ex, next] =
    dim === "rows"
      ? ["<rows>", "rows", "3:5", "row above (at row 1, the row below)"]
      : ["<cols>", "columns", "B:C", "column to the left (at A, the column right)"];
  return `usage: gws-axi sheets insert-${dim} <spreadsheetId> ${arg} [--tab <name|gid>] [--no-inherit] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
${RANGE_ARG[dim]}
flags[3]:
${TAB_FLAG}
  --no-inherit         Clear the new cells' formatting. Default: they take the
                       formatting of the ${next},
                       as the editor does. Size is inherited either way
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets insert-${dim} 1AbC... ${ex} --tab Costs --account you@example.com
  gws-axi sheets insert-${dim} 1AbC... ${dim === "rows" ? "1" : "A"} --tab Costs --account you@example.com
output:
  The range inserted, count, shifted: (where everything after it moved, in old
  ${dim === "rows" ? "row" : "column"} terms), inherit:, grid: (the tab's size after), and any formula
  errors the insert caused in the tab.
notes:
  After the call, ${ex} ARE the new empty ${noun}: what was at ${dim === "rows" ? "row 3" : "column B"} moves to ${dim === "rows" ? "row 6" : "column D"}.
  Formulas elsewhere are shifted by Sheets. NOT idempotent: re-running inserts
  again. \`gws-axi sheets delete-${dim} <id> ${ex}\` undoes it; fill the new ${noun}
  with \`gws-axi sheets update --range\`.
`;
}

function deleteHelp(dim: Dim): string {
  const [arg, noun, ex] = dim === "rows" ? ["<rows>", "rows", "3:5"] : ["<cols>", "columns", "B:C"];
  return `usage: gws-axi sheets delete-${dim} <spreadsheetId> ${arg} [--tab <name|gid>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
${RANGE_ARG[dim]}
flags[2]:
${TAB_FLAG}
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets delete-${dim} 1AbC... ${ex} --tab Costs --account you@example.com
output:
  The range deleted, count, shifted: (where everything after it moved, in old
  ${dim === "rows" ? "row" : "column"} terms), the populated cells removed as cells[N]{row,…} with their
  old row numbers (the undo record), and any formula errors the delete caused —
  a formula that read a deleted cell turns #REF!.
notes:
  Everything after the range moves ${dim === "rows" ? "up" : "left"}. NOT idempotent: re-running deletes
  the ${noun} that moved into the range. Undo with \`gws-axi sheets insert-${dim}\` at
  the same range, then \`gws-axi sheets update --range\` with cells[]. Deleting
  every ${dim === "rows" ? "row" : "column"} is refused: use \`gws-axi sheets clear --all\`.
`;
}

export const INSERT_ROWS_HELP = insertHelp("rows");
export const INSERT_COLS_HELP = insertHelp("cols");
export const DELETE_ROWS_HELP = deleteHelp("rows");
export const DELETE_COLS_HELP = deleteHelp("cols");

export const INSERT_DIM_FLAGS: FlagSpec = { value: ["--tab"], boolean: ["--no-inherit"] };
export const DELETE_DIM_FLAGS: FlagSpec = {
  value: ["--tab"],
  hints: {
    "--no-inherit":
      "--no-inherit is for insert-rows / insert-cols: a delete creates nothing to format",
  },
};

// ---------------------------------------------------------------------------
// Pure helpers

const noun = (dim: Dim, n = 2) =>
  dim === "rows" ? (n === 1 ? "row" : "rows") : n === 1 ? "column" : "columns";

/** One row/column by its 0-based index: `3` / `B`. */
export function dimName(dim: Dim, index0: number): string {
  return dim === "rows" ? String(index0 + 1) : columnLetter(index0);
}

/** `3:5` / `3` / `B:D` / `B` for a 0-based end-exclusive span. */
export function dimLabel(dim: Dim, start0: number, end0: number): string {
  const a = dimName(dim, start0);
  return end0 - start0 === 1 ? a : `${a}:${dimName(dim, end0 - 1)}`;
}

/**
 * Where everything after the edit went, in old terms — so an agent holding a
 * stale read can re-address without re-reading. `alloc` is the tab's size
 * along the dimension before the call.
 */
export function shiftedSentence(
  op: DimOp,
  dim: Dim,
  start0: number,
  end0: number,
  alloc: number,
): string {
  const n = end0 - start0;
  const ix = (i: number) => `${noun(dim, 1)} ${dimName(dim, i)}`;
  if (op === "insert") {
    if (start0 >= alloc) return `nothing moved (the ${noun(dim)} were added after the last one)`;
    const where = dim === "rows" ? "and below moved down" : "and to the right moved right";
    return `${noun(dim)} ${dimName(dim, start0)} ${where} by ${n} (old ${ix(start0)} is now ${ix(end0)})`;
  }
  if (end0 >= alloc) return `nothing moved (the ${noun(dim)} deleted were the last ones)`;
  const where = dim === "rows" ? "and below moved up" : "and to the right moved left";
  return `${noun(dim)} ${dimName(dim, end0)} ${where} by ${n} (old ${ix(end0)} is now ${ix(start0)})`;
}

/**
 * Refuse a range the call cannot honor, before anything is read or written:
 * an insert that starts past the grid (one past the last row is the end, and
 * allowed), a delete that starts past it or runs past it (upstream silently
 * clips — observed — and `count` would lie), a delete of every row/column.
 */
export function checkBounds(
  op: DimOp,
  range: DimensionRange,
  tab: TabInfo,
  ctx: { spreadsheetId: string; account: string },
  /** Frozen rows (for rows) or columns (for cols): upstream also refuses deleting all the rest. */
  frozen = 0,
): void {
  const dim = range.kind;
  const alloc = dim === "rows" ? tab.rows : tab.cols;
  const tabArg = shellArg(tab.title);
  const last = dimName(dim, alloc - 1);
  const label = dimLabel(dim, range.start0, range.end0);
  const size = `${alloc} ${noun(dim, alloc)}`;
  if (op === "insert" && range.start0 > alloc) {
    const anchor = dim === "rows" ? `A${range.start0 + 1}` : `${columnLetter(range.start0)}1`;
    throw new AxiError(
      `${label} starts past the end of tab '${tab.title}' (${size}, last ${noun(dim, 1)} ${last})`,
      "VALIDATION_ERROR",
      [
        `insert-${dim} makes room inside the grid. To add ${noun(dim)} at the end: \`gws-axi sheets insert-${dim} ${ctx.spreadsheetId} ${dimLabel(dim, alloc, alloc + (range.end0 - range.start0))} --tab ${tabArg} --account ${ctx.account}\``,
        `To write past the end, \`gws-axi sheets update ${ctx.spreadsheetId} --tab ${tabArg} --range ${anchor} <source> --account ${ctx.account}\` grows the grid`,
        "Nothing was changed",
      ],
    );
  }
  if (op === "delete" && range.end0 > alloc) {
    throw new AxiError(
      `${label} ${range.start0 >= alloc ? "starts" : "runs"} past the end of tab '${tab.title}' (${size}, last ${noun(dim, 1)} ${last})`,
      "VALIDATION_ERROR",
      [
        range.start0 < alloc
          ? `Delete up to the last ${noun(dim, 1)}: \`gws-axi sheets delete-${dim} ${ctx.spreadsheetId} ${dimLabel(dim, range.start0, alloc)} --tab ${tabArg} --account ${ctx.account}\``
          : `Run \`gws-axi sheets read ${ctx.spreadsheetId} --tab ${tabArg}\` to see where the tab's data is`,
        range.start0 < alloc
          ? "Upstream would delete only the part that exists; the range is refused so the count stays true"
          : `The tab has no ${noun(dim, 1)} ${dimName(dim, range.start0)} to delete`,
        "Nothing was changed",
      ],
    );
  }
  if (op === "delete" && range.end0 >= alloc && range.start0 <= frozen) {
    const what =
      range.start0 === 0
        ? `every ${noun(dim, 1)} of tab '${tab.title}' — a tab keeps at least one`
        : `every ${noun(dim, 1)} of tab '${tab.title}' outside the freeze (${noun(dim, frozen)} ${dimLabel(dim, 0, frozen)} frozen) — Sheets keeps at least one unfrozen`;
    throw new AxiError(`${label} is ${what}`, "VALIDATION_ERROR", [
      `To empty the tab: \`gws-axi sheets clear ${ctx.spreadsheetId} --tab ${tabArg} --all --account ${ctx.account}\``,
      "To remove the tab itself: `gws-axi sheets tabs delete`",
      "Nothing was changed",
    ]);
  }
}

/**
 * A pre-call A1 cell's address after the call; `undefined` when a delete
 * removed it.
 */
export function shiftCell(
  a1: string,
  op: DimOp,
  dim: Dim,
  start0: number,
  end0: number,
): string | undefined {
  const ref = parseA1(a1);
  if (!ref || ref.kind !== "cell") return a1;
  let r = ref.r0 ?? 0;
  let c = ref.c0 ?? 0;
  const n = end0 - start0;
  const at = dim === "rows" ? r : c;
  let moved = at;
  if (op === "insert") {
    if (at >= start0) moved = at + n;
  } else {
    if (at >= start0 && at < end0) return undefined;
    if (at >= end0) moved = at - n;
  }
  if (dim === "rows") r = moved;
  else c = moved;
  return cellA1(r, c);
}

/** The inverse of `shiftCell` for a cell that exists after the call. */
export function unshiftCell(
  a1: string,
  op: DimOp,
  dim: Dim,
  start0: number,
  end0: number,
): string | undefined {
  const ref = parseA1(a1);
  if (!ref || ref.kind !== "cell") return a1;
  let r = ref.r0 ?? 0;
  let c = ref.c0 ?? 0;
  const n = end0 - start0;
  const at = dim === "rows" ? r : c;
  let was = at;
  if (op === "insert") {
    if (at >= start0 && at < end0) return undefined;
    if (at >= end0) was = at - n;
  } else if (at >= start0) {
    was = at + n;
  }
  if (dim === "rows") r = was;
  else c = was;
  return cellA1(r, c);
}

/** Re-key pre-call errors to their post-call addresses, dropping deleted cells. */
export function shiftErrors(
  before: Map<string, CellError>,
  op: DimOp,
  dim: Dim,
  start0: number,
  end0: number,
): Map<string, CellError> {
  const out = new Map<string, CellError>();
  for (const [a1, err] of before) {
    const now = shiftCell(a1, op, dim, start0, end0);
    if (now) out.set(now, { ...err, cell: now });
  }
  return out;
}

export interface DeletedBlock {
  rows: Array<Record<string, unknown>>;
  schema: FieldDef[];
  /** Populated cells in the window. */
  populated: number;
}

/**
 * The cells of a deleted range in the read's `cells[N]{row,A,…}` shape, with
 * OLD row numbers and letters, **anchored**: from the range's first row (rows)
 * or row 1 (columns), and column A (rows) or the range's first column
 * (columns), through the last populated row and column — empty rows and cells
 * kept, so the block pastes back at the anchor as-is. Values are entered text
 * (a formula as typed). `data` is the render window; at most 50 rows render.
 */
export function deletedBlock(data: GridDataLike[], dim: Dim, start0: number): DeletedBlock {
  const held: Array<{ row0: number; col0: number; text: string }> = [];
  for (const { row0, col0, cell } of gridCells(data).values()) {
    if (!isEmptyCell(cell)) held.push({ row0, col0, text: enteredText(cell) });
  }
  if (held.length === 0) return { rows: [], schema: [], populated: 0 };
  const rowAnchor = dim === "rows" ? start0 : 0;
  const colOrigin = dim === "cols" ? start0 : 0;
  const rowMax = Math.min(Math.max(...held.map((h) => h.row0)), rowAnchor + WRITTEN_CAP - 1);
  const colMax = Math.max(...held.map((h) => h.col0));
  const values: string[][] = Array.from({ length: rowMax - rowAnchor + 1 }, () =>
    Array.from({ length: colMax - colOrigin + 1 }, () => ""),
  );
  let populated = 0;
  for (const h of held) {
    if (h.row0 < rowAnchor || h.row0 > rowMax || h.col0 < colOrigin) continue;
    values[h.row0 - rowAnchor][h.col0 - colOrigin] = h.text;
    populated++;
  }
  const grid = buildGrid(
    values,
    { col0: colOrigin, row1: rowAnchor + 1 },
    { headerRow: false, maxRows: WRITTEN_CAP, full: false },
  );
  return { rows: grid.rows, schema: grid.schema, populated };
}

/**
 * Count a range's populated cells from a display-only `values.get` (which keeps
 * leading empty rows and trims trailing ones — observed): `cells`, and the rows
 * from the anchor through the last populated one.
 */
export function countHeld(values: unknown[][] | undefined | null): { cells: number; rows: number } {
  const rows = values ?? [];
  let cells = 0;
  let last = 0;
  rows.forEach((row, i) => {
    const n = (row ?? []).filter((v) => v != null && v !== "").length;
    cells += n;
    if (n > 0) last = i + 1;
  });
  return { cells, rows: last };
}

/**
 * The batch for one call. An insert always inherits from a side — upstream has
 * no un-inherited insert (`inheritFromBefore: false` copies from the row
 * after, observed) — so the editor's side is chosen: before, or after at row 1.
 * `--no-inherit` clears the new cells' formats in the same batch.
 */
export function dimensionRequests(
  op: DimOp,
  dim: Dim,
  sheetId: number,
  start0: number,
  end0: number,
  noInherit: boolean,
): sheets_v4.Schema$Request[] {
  const range = {
    sheetId,
    dimension: dim === "rows" ? "ROWS" : "COLUMNS",
    startIndex: start0,
    endIndex: end0,
  };
  if (op === "delete") return [{ deleteDimension: { range } }];
  const requests: sheets_v4.Schema$Request[] = [
    { insertDimension: { range, inheritFromBefore: start0 > 0 } },
  ];
  if (noInherit) {
    const cells =
      dim === "rows"
        ? { sheetId, startRowIndex: start0, endRowIndex: end0 }
        : { sheetId, startColumnIndex: start0, endColumnIndex: end0 };
    requests.push({ repeatCell: { range: cells, cell: {}, fields: "userEnteredFormat" } });
  }
  return requests;
}

/** `inherit:` — where the new cells' formatting came from, in after-call terms. */
export function inheritLabel(dim: Dim, start0: number, end0: number, noInherit: boolean): string {
  if (noInherit) return "none";
  if (start0 > 0) return `from ${noun(dim, 1)} ${dimName(dim, start0 - 1)}`;
  return `from ${noun(dim, 1)} ${dimName(dim, end0)} (was ${noun(dim, 1)} ${dimName(dim, 0)})`;
}

// ---------------------------------------------------------------------------
// The call

/** The whole-tab scan mask: each cell's error, and its formula for the fix lines. */
const SCAN_FIELDS =
  "sheets(data(startRow,startColumn,rowData(values(userEnteredValue/formulaValue,effectiveValue/errorValue))))";
const PROPS_FIELDS =
  "sheets(properties(sheetId,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))";

interface GridProps {
  rows: number;
  cols: number;
  frozenRows: number;
  frozenCols: number;
}

/** Every tab's grid and freeze, by gid. */
async function fetchProps(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
): Promise<Map<number, GridProps>> {
  try {
    const res = await api.spreadsheets.get({ spreadsheetId, fields: PROPS_FIELDS });
    const out = new Map<number, GridProps>();
    for (const sheet of res.data.sheets ?? []) {
      const p = sheet.properties?.gridProperties;
      if (!p) continue;
      out.set(sheet.properties?.sheetId ?? 0, {
        rows: p.rowCount ?? 0,
        cols: p.columnCount ?? 0,
        frozenRows: p.frozenRowCount ?? 0,
        frozenCols: p.frozenColumnCount ?? 0,
      });
    }
    return out;
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get" });
  }
}

/** The display values of a range, for the deleted-cell count. */
async function fetchValues(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
  range: string,
): Promise<unknown[][]> {
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "FORMATTED_VALUE",
    });
    return (res.data.values ?? []) as unknown[][];
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.values.get" });
  }
}

function formulasOf(data: GridDataLike[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [a1, { cell }] of gridCells(data)) {
    const f = cell.userEnteredValue?.formulaValue;
    if (f) out.set(a1, f);
  }
  return out;
}

interface DimFlags {
  spreadsheetId: string;
  range: string;
  tab?: string;
  noInherit: boolean;
}

function parseDimFlags(args: string[], op: DimOp, dim: Dim): DimFlags {
  const command = `sheets ${op}-${dim}`;
  const parsed = parseArgs(args, op === "insert" ? INSERT_DIM_FLAGS : DELETE_DIM_FLAGS, command);
  const usage = `gws-axi ${command} <spreadsheetId> ${dim === "rows" ? "<rows>" : "<cols>"} [--tab <name|gid>]${op === "insert" ? " [--no-inherit]" : ""}`;
  const [spreadsheetId, range, extra] = parsed.positionals;
  if (extra !== undefined) {
    throw new AxiError(`Unexpected argument: ${extra}`, "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      `One range per call: ${dim === "rows" ? "3:5" : "B:D"} is a span`,
    ]);
  }
  if (!spreadsheetId) {
    throw new AxiError("Missing spreadsheetId argument", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "The spreadsheetId is the portion of the URL after /d/",
    ]);
  }
  if (!range) {
    throw new AxiError(`Missing the ${noun(dim)} to ${op}`, "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      dim === "rows" ? "Rows are 3:5 or 3" : "Columns are B:D or B",
    ]);
  }
  return {
    spreadsheetId,
    range,
    tab: parsed.values["--tab"],
    noInherit: parsed.booleans.has("--no-inherit"),
  };
}

/** Fix lines for the reported errors; a `#REF!` the delete wrote names its formula as it was. */
function dimFixLines(
  errors: ErrorDiff,
  formulas: Map<string, string>,
  formulasBefore: Map<string, string>,
  ctx: {
    spreadsheetId: string;
    tabTitle: string;
    account: string;
    op: DimOp;
    dim: Dim;
    start0: number;
    end0: number;
  },
): string[] {
  const list = errors.errors;
  if (list.length === 0) return [];
  const noun1 = list.length === 1 ? "formula error" : "formula errors";
  const lines = [`${list.length} ${noun1} after this ${ctx.op} — see errors[]`];
  const tab = shellArg(ctx.tabTitle);
  const gone = `${noun(ctx.dim, ctx.end0 - ctx.start0)} ${dimLabel(ctx.dim, ctx.start0, ctx.end0)}`;
  for (const err of list.slice(0, 5)) {
    const now = formulas.get(err.cell);
    const oldAt = unshiftCell(err.cell, ctx.op, ctx.dim, ctx.start0, ctx.end0) ?? "";
    const old = formulasBefore.get(oldAt);
    if (ctx.op === "delete" && now?.includes("#REF!") && old && old !== now) {
      const why = `${errorText(err.error)}${err.message ? `, ${err.message}` : ""}`;
      lines.push(
        `Fix ${err.cell} (${why}): it was ${old}${oldAt !== err.cell ? ` (in ${oldAt})` : ""} before the delete; it is now ${now} — re-point the #REF! in the current formula (${gone} ${ctx.end0 - ctx.start0 === 1 ? "is" : "are"} gone; its other references are already shifted): gws-axi sheets update ${ctx.spreadsheetId} --tab ${tab} --cell ${cellArg(err.cell, now)} --account ${ctx.account}`,
      );
    } else {
      lines.push(
        fixLines([err], formulas, {
          spreadsheetId: ctx.spreadsheetId,
          tabTitle: ctx.tabTitle,
          account: ctx.account,
        })[0],
      );
    }
  }
  lines.push(
    `Run \`gws-axi sheets cell ${ctx.spreadsheetId} ${list[0].cell} --tab ${tab}\` to see the formula with the current values it reads`,
  );
  return lines;
}

export async function dimensionCommand(
  account: string,
  args: string[],
  op: DimOp,
  dim: Dim,
): Promise<string> {
  const flags = parseDimFlags(args, op, dim);
  const range = parseDimensionRange(flags.range, dim);
  const api = await sheetsClient(account);
  const [meta, allPropsBefore] = await Promise.all([
    fetchMeta(api, account, flags.spreadsheetId),
    // Best-effort: the meta read carries the error a missing spreadsheet gets.
    fetchProps(api, account, flags.spreadsheetId).catch(() => undefined),
  ]);
  const id = meta.id;
  const tab = tabFromFlags(
    meta,
    flags.tab,
    range.tabTitle,
    (t) =>
      `gws-axi sheets ${op}-${dim} ${id} ${dimLabel(dim, range.start0, range.end0)} --tab ${shellArg(t)} --account ${account}`,
  );
  const propsBefore = allPropsBefore?.get(tab.gid);
  checkBounds(
    op,
    range,
    tab,
    { spreadsheetId: id, account },
    (dim === "rows" ? propsBefore?.frozenRows : propsBefore?.frozenCols) ?? 0,
  );

  const { start0, end0 } = range;
  const n = end0 - start0;
  const alloc = dim === "rows" ? tab.rows : tab.cols;
  const span = dimLabel(dim, start0, end0);
  const label = `${displayTitle(tab.title)}!${span}`;
  const q = quoteTitle(tab.title);
  const tabArg = shellArg(tab.title);
  const wholeScan = tab.rows * tab.cols <= ERROR_SCAN_BOUND ? q : undefined;
  const goingRange =
    dim === "rows"
      ? `${q}!${start0 + 1}:${end0}`
      : `${q}!${columnLetter(start0)}:${columnLetter(end0 - 1)}`;

  // The delete's undo, bounded: the 50-row render window under the write mask,
  // and a display-only count over the range unless it is past the scan bound.
  const windowRange =
    dim === "rows"
      ? `${q}!${start0 + 1}:${Math.min(end0, start0 + WRITTEN_CAP)}`
      : `${q}!${columnLetter(start0)}1:${columnLetter(end0 - 1)}${Math.max(1, Math.min(tab.rows, WRITTEN_CAP))}`;
  const rangeCells = n * (dim === "rows" ? tab.cols : tab.rows);
  const countable = rangeCells <= ERROR_SCAN_BOUND;

  // 1. Pre-read: the tab's errors (+ formulas), and — for a delete — the cells
  //    about to go.
  const [preScan, preCells, preValues] = await Promise.all([
    wholeScan ? fetchGrid(api, account, id, [wholeScan], SCAN_FIELDS) : Promise.resolve(undefined),
    op === "delete"
      ? fetchGrid(api, account, id, [windowRange], TARGET_FIELDS)
      : Promise.resolve([] as GridDataLike[]),
    op === "delete" && countable
      ? fetchValues(api, account, id, goingRange)
      : Promise.resolve(undefined),
  ]);

  // 2. The request — with --no-inherit, the format clear rides in the same batch.
  const requests = dimensionRequests(op, dim, tab.gid, start0, end0, flags.noInherit);
  try {
    await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
  } catch (err) {
    throw translateWriteError(err, {
      account,
      operation: `sheets.spreadsheets.batchUpdate(${op}Dimension)`,
      spreadsheetId: id,
      range: label,
    });
  }

  // 3. Read back: the grid and freeze, and the tab's errors now.
  const [allPropsAfter, postScan] = await Promise.all([
    fetchProps(api, account, id).catch(() => undefined),
    wholeScan ? fetchGrid(api, account, id, [wholeScan], SCAN_FIELDS) : Promise.resolve(undefined),
  ]);
  const propsAfter = allPropsAfter?.get(tab.gid);
  const formulasBefore = formulasOf(preScan);
  const formulas = formulasOf(postScan);
  const errors =
    preScan && postScan
      ? diffErrors(
          shiftErrors(collectErrors(preScan), op, dim, start0, end0),
          collectErrors(postScan),
          new Set(),
        )
      : undefined;

  // 4. Render.
  const head: Record<string, unknown> = {
    account,
    action: op === "insert" ? "inserted" : "deleted",
  };
  Object.assign(
    head,
    errorHeader(
      errors,
      wholeScan
        ? undefined
        : `not run (tab is ${tab.rows}×${tab.cols}, over ${ERROR_SCAN_BOUND} cells)`,
    ),
  );
  const summary: Record<string, unknown> = {
    range: label,
    count: n,
    shifted: shiftedSentence(op, dim, start0, end0, alloc),
  };
  const block = op === "delete" ? deletedBlock(preCells, dim, start0) : undefined;
  const held = preValues ? countHeld(preValues) : undefined;
  // A formula showing "" counts in the window (entered text), not in the display.
  const heldCells = held ? Math.max(held.cells, block?.populated ?? 0) : undefined;
  const heldRows = held?.rows ?? 0;
  const anyHeld = (heldCells ?? 0) > 0 || (block?.populated ?? 0) > 0;
  if (op === "insert") {
    summary.inherit = inheritLabel(dim, start0, end0, flags.noInherit);
    if (propsAfter) summary.grid = `${propsAfter.rows}×${propsAfter.cols}`;
  } else {
    summary.cells = heldCells ?? `not counted (range is ${rangeCells} cells)`;
    if (heldRows > WRITTEN_CAP) summary.cells_total_rows = heldRows;
  }
  if (propsBefore && propsAfter) {
    if (propsAfter.frozenRows !== propsBefore.frozenRows)
      summary.frozen_rows = propsAfter.frozenRows;
    if (propsAfter.frozenCols !== propsBefore.frozenCols)
      summary.frozen_cols = propsAfter.frozenCols;
  }

  const blocks: string[] = [];
  if (block && block.populated > 0) blocks.push(renderList("cells", block.rows, block.schema));
  if (errors)
    blocks.push(...outcomeBlocks({ formulas: [], written: [], changed: 0 }, errors).blocks);

  const help: string[] = errors
    ? dimFixLines(errors, formulas, formulasBefore, {
        spreadsheetId: id,
        tabTitle: tab.title,
        account,
        op,
        dim,
        start0,
        end0,
      })
    : [];
  const acct = `--account ${account}`;
  const anchor = dim === "rows" ? `A${start0 + 1}` : `${columnLetter(start0)}1`;
  const what = noun(dim, n);
  if (op === "insert") {
    help.push(
      `Run \`gws-axi sheets update ${id} --tab ${tabArg} --range ${anchor} <source> ${acct}\` to fill the new ${what}`,
      `Re-running inserts ${n} more ${what} at ${span} (not idempotent); \`gws-axi sheets delete-${dim} ${id} ${span} --tab ${tabArg} ${acct}\` undoes this`,
    );
    if (flags.noInherit) {
      const from = start0 > 0 ? dimName(dim, start0 - 1) : dimName(dim, end0);
      help.push(
        `--no-inherit cleared the new cells' formatting; their ${dim === "rows" ? "height" : "width"} still came from ${noun(dim, 1)} ${from} (upstream has no un-inherited insert), and data validation or conditional formatting whose range spans ${span} now covers them too`,
      );
    }
    if (start0 < alloc) {
      const after =
        dim === "rows"
          ? `at or below row ${start0 + 1}`
          : `at or right of column ${columnLetter(start0)}`;
      if (!errors) {
        help.push(
          `References ${after} were shifted by Sheets; the error scan did not run (tab over ${ERROR_SCAN_BOUND} cells) — \`gws-axi sheets read ${id} --tab ${tabArg}\` shows errors`,
        );
      } else if (errors.errors.length === 0) {
        help.push(`References ${after} were shifted by Sheets; none errored`);
      }
    }
  } else {
    const restore = `\`gws-axi sheets insert-${dim} ${id} ${span} --tab ${tabArg} ${acct}\``;
    help.push(
      anyHeld
        ? `The deleted cells are in cells[] above and in version history (\`gws-axi drive revisions ${id}\`); ${restore} then \`sheets update --range ${anchor}\` with cells[] as-is (empty rows included) restores them`
        : `The deleted ${what} held no values; ${restore} puts the ${what} back, empty (${n === 1 ? "its" : "their"} formatting is in \`gws-axi drive revisions ${id}\`)`,
    );
    if (heldRows > WRITTEN_CAP) {
      help.push(
        `cells[] shows the first ${WRITTEN_CAP} of ${heldRows} rows; the rest are in the version history`,
      );
    } else if (!held && anyHeld) {
      help.push(
        `cells[] shows the range's first ${WRITTEN_CAP} rows only (the range is too large to count); the rest are in the version history`,
      );
    }
    if (!errors) {
      help.push(
        `The error scan did not run (tab over ${ERROR_SCAN_BOUND} cells): a reference to a removed cell is now #REF! — \`gws-axi sheets read ${id} --tab ${tabArg}\` lists the tab's errors`,
      );
    }
    const allocAfter = alloc - n;
    const nowEnd = Math.min(end0, allocAfter);
    const Cap = dim === "rows" ? "Rows" : "Columns";
    const Cap1 = dim === "rows" ? "Row" : "Column";
    if (start0 >= allocAfter) {
      help.push(
        `${n === 1 ? Cap1 : Cap} ${span} ${n === 1 ? "is" : "are"} now past the end of the tab — re-running would be refused`,
      );
    } else {
      const nowSpan = dimLabel(dim, start0, nowEnd);
      const wasSpan = dimLabel(dim, end0, end0 + (nowEnd - start0));
      const one = nowEnd - start0 === 1;
      help.push(
        `${one ? Cap1 : Cap} ${nowSpan} ${one ? "is" : "are"} now what was ${noun(dim, nowEnd - start0)} ${wasSpan} — re-running would delete ${one ? "it" : "those"}`,
      );
    }
  }
  const frozenNow = dim === "rows" ? summary.frozen_rows : summary.frozen_cols;
  if (frozenNow !== undefined) {
    help.push(
      `The ${op} was inside the frozen ${noun(dim)}; the freeze now covers ${frozenNow} ${noun(dim, Number(frozenNow))}`,
    );
  }
  // A delete's restore line already names the version history.
  if (op === "insert") help.push(revisionsLine(id));

  return joinBlocks(
    renderObject(head),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    renderObject(summary),
    ...blocks,
    renderHelp(help),
  );
}

export const sheetsInsertRowsCommand = (account: string, args: string[]) =>
  dimensionCommand(account, args, "insert", "rows");
export const sheetsInsertColsCommand = (account: string, args: string[]) =>
  dimensionCommand(account, args, "insert", "cols");
export const sheetsDeleteRowsCommand = (account: string, args: string[]) =>
  dimensionCommand(account, args, "delete", "rows");
export const sheetsDeleteColsCommand = (account: string, args: string[]) =>
  dimensionCommand(account, args, "delete", "cols");
