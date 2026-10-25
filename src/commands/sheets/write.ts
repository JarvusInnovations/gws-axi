import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { sheetsClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type FlagSpec, type ParsedArgs, parseArgs } from "../../util/flags.js";
import { checkOneSource, readSource, type SourceFlags, takeStdin } from "../../util/source.js";
import {
  type FormulaRow,
  type PlannedCell,
  type WriteReport,
  type WrittenRow,
  diffBlock,
  parsedLine,
  reportWrite,
} from "./compare.js";
import {
  type CellLike,
  type ErrorDiff,
  type GridDataLike,
  type GridRect,
  type ReportedError,
  type SpreadsheetMeta,
  type TabInfo,
  cellA1,
  collectErrors,
  columnLetter,
  diffErrors,
  enteredText,
  errorCountLine,
  fetchMeta,
  findTab,
  fixLines,
  gridCells,
  isEmptyCell,
  parseA1,
  quoteTitle,
  rectA1,
  requireTab,
  shellArg,
  splitQualifiedRange,
  tabLink,
  tabNotFound,
  toRect,
  translateWriteError,
} from "./shared.js";
import {
  type Block,
  type CellArg,
  type InputValue,
  type JsonBlock,
  type Shape,
  blockShape,
  isEmptyBlock,
  mapKeyedRows,
  parseCellArgs,
  parseCsv,
  parseJsonGrid,
} from "./values.js";

/**
 * The range writers — `sheets update`, `sheets append`, `sheets clear` — and
 * the write path `create` / `add-tab` seed through
 * (specs/commands/sheets-write.md). Values only: the requests sent are the
 * values call, a grid growth when the block would not fit, and the freeze
 * `--header` asks for. Every write reads back what Sheets made of it and
 * reports the formula errors it introduced anywhere in the tab.
 */

// ---------------------------------------------------------------------------
// Help + flags

const BLOCK_HELP = `  <file> | -           The value block: a local CSV file (.tsv → tab-separated),
                       or - for stdin. Or pass it inline with --content`;
const ENCODING_HELP = `  --json               The block is a JSON 2-D array of rows: strings, numbers and
                       booleans are typed; null leaves a cell as it is; "" clears it
  --tsv                Tab-separated instead of comma-separated (implied by .tsv)
  --raw                Store strings verbatim (RAW). Default parses them as typed
                       (USER_ENTERED): =formulas, dates, numbers, currencies`;
const HEADER_HELP = `  --header             The block's first row is a header: freeze row 1, which
                       \`sheets read\` promotes to column names. Sets no formatting`;
const CSV_NOTES = `  CSV is RFC 4180: "…" quotes a field, "" is a literal quote, newlines may sit
  inside quotes. An empty field writes an empty cell (it clears what was there);
  a short row leaves the cells past its end untouched; a blank line writes nothing.`;
const OUTPUT_NOTES = `output:
  The written range, the block's shape, then formulas[N]{cell,formula,result,
  message} — every formula written, with its result or its error — and
  written[N]{cell,before,input,now}: cells that had a different value (before is
  the undo) or whose display differs from what was typed (now is the proof).
  errors[N]{cell,error,message,written} lists formula errors this write left
  anywhere in the tab, with a runnable fix line per error in help[].`;

export const UPDATE_HELP = `usage: gws-axi sheets update <spreadsheetId> (--range <A1> (<file> | - | --content <values>) | --cell <A1>=<value>...) [--tab <name|gid>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
${BLOCK_HELP}
flags[9]:
  --range <A1>         Where the block goes: a cell anchors it (B2), a range bounds
                       it (B2:D9, B:B, 3:3) and a larger block is refused. A
                       tab-qualified range (Costs!B2) makes --tab optional
  --content <values>   The block inline (CSV, or JSON with --json)
  --cell <A1>=<value>  One cell, repeatable: --cell B5=4800 --cell D2='=B2*C2'.
                       Everything after the first = is the value. Replaces
                       --range and the block
  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet unless the range names it
${ENCODING_HELP}
${HEADER_HELP} (--range must start at row 1)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets update 1AbC... --tab Costs --range B2 costs.csv --account you@example.com
  gws-axi sheets update 1AbC... --range 'Costs!A1' --content 'Item,Qty' --header --account you@example.com
  gws-axi sheets update 1AbC... --tab Costs --cell B5=4800 --cell D2='=B2*C2' --account you@example.com
  gws-axi sheets update 1AbC... --tab Costs --range A2 --json --content '[["bolts",40,null]]' --account you@example.com
${OUTPUT_NOTES}
notes:
  A block smaller than --range writes its own extent and leaves the rest of the
  range as it was; \`sheets clear\` empties a range. A block wider or longer than
  the tab grows the tab (grid: in the output). Nothing but values is touched:
  formats, widths, validation and notes stay. Re-running is action: unchanged
  when every cell already holds what the block would store.
${CSV_NOTES}
`;

export const APPEND_HELP = `usage: gws-axi sheets append <spreadsheetId> (<file> | - | --content <values>) [--tab <name|gid>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
${BLOCK_HELP}
flags[6]:
  --content <values>   The rows inline (CSV, or JSON with --json)
  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet
${ENCODING_HELP}
                       With --json, rows may also be objects keyed by the tab's
                       header row: [{"Name":"bolts","Status":"done"}]
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets append 1AbC... --tab Costs new-rows.csv --account you@example.com
  gws-axi sheets append 1AbC... --tab Tasks --json --content '[{"Name":"Ship it","Status":"open"}]' --account you@example.com
${OUTPUT_NOTES}
notes:
  Rows land after the last row that has data, as new rows; range: in the output
  says where. NOT idempotent: re-running appends the same rows again.
  Header-keyed objects match row 1's cells exactly (trimmed, case-sensitive); a
  key that names no header is refused before anything is written, and a
  header no object names is left empty in the new row.
${CSV_NOTES}
`;

export const CLEAR_HELP = `usage: gws-axi sheets clear <spreadsheetId> (--range <A1> | --all) [--tab <name|gid>] [flags]
args[1]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
flags[4]:
  --range <A1>         The range to empty (B2:D9, B:B, 3:3). A tab-qualified
                       range (Costs!B2:D9) makes --tab optional
  --all                Empty every value in the tab
  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet unless the range names it
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets clear 1AbC... --tab Costs --range B2:D9 --account you@example.com
  gws-axi sheets clear 1AbC... --tab Scratch --all --account you@example.com
output:
  The range cleared, the number of cells that held a value, written[N]{cell,
  before,input,now} with each cleared cell's previous value (the undo), and any
  formula errors the clear caused elsewhere in the tab.
notes:
  Values only: formatting, validation, notes and merges stay. One of --range or
  --all is required — a bare clear never empties a tab. An already-empty range
  is action: unchanged.
`;

export const UPDATE_FLAGS: FlagSpec = {
  value: ["--range", "--content", "--cell", "--tab"],
  boolean: ["--json", "--tsv", "--raw", "--header"],
};
export const APPEND_FLAGS: FlagSpec = {
  value: ["--content", "--tab"],
  boolean: ["--json", "--tsv", "--raw"],
};
export const CLEAR_FLAGS: FlagSpec = {
  value: ["--range", "--tab"],
  boolean: ["--all"],
};

// ---------------------------------------------------------------------------
// Parsing

export interface BlockFlags extends SourceFlags {
  json: boolean;
  tsv: boolean;
  raw: boolean;
}

/** The source and encoding flags every block writer shares. */
export function blockFlags(parsed: ParsedArgs, rest: string[], stdin: boolean): BlockFlags {
  const flags: BlockFlags = {
    localPath: rest[0],
    stdin,
    content: parsed.values["--content"],
    json: parsed.booleans.has("--json"),
    tsv: parsed.booleans.has("--tsv"),
    raw: parsed.booleans.has("--raw"),
  };
  if (flags.json && flags.tsv) {
    throw new AxiError("--json and --tsv are mutually exclusive", "VALIDATION_ERROR", [
      "--json reads a JSON 2-D array; --tsv reads tab-separated text. Pick one",
    ]);
  }
  return flags;
}

export interface UpdateFlags extends BlockFlags {
  spreadsheetId: string;
  range?: string;
  cells?: CellArg[];
  tab?: string;
  header: boolean;
}

const UPDATE_USAGE =
  "gws-axi sheets update <spreadsheetId> (--range <A1> (<file> | - | --content <values>) | --cell <A1>=<value>...) [--tab <name|gid>]";

function positionalsOf(
  parsed: ParsedArgs,
  usage: string,
  max: number,
): { stdin: boolean; rest: string[] } {
  const { stdin, rest } = takeStdin(parsed.positionals);
  if (rest.length > max) {
    throw new AxiError(`Unexpected argument: ${rest[max]}`, "VALIDATION_ERROR", [
      `Usage: ${usage}`,
    ]);
  }
  return { stdin, rest };
}

function needId(id: string | undefined, usage: string): string {
  if (!id) {
    throw new AxiError("Missing spreadsheetId argument", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "The spreadsheetId is the portion of the URL after /d/",
    ]);
  }
  return id;
}

export function parseUpdateFlags(args: string[]): UpdateFlags {
  const parsed = parseArgs(args, UPDATE_FLAGS, "sheets update");
  const { stdin, rest } = positionalsOf(parsed, UPDATE_USAGE, 2);
  const spreadsheetId = needId(rest.shift(), UPDATE_USAGE);
  const flags: UpdateFlags = {
    ...blockFlags(parsed, rest, stdin),
    spreadsheetId,
    range: parsed.values["--range"],
    tab: parsed.values["--tab"],
    header: parsed.booleans.has("--header"),
  };
  const cellArgs = parsed.lists["--cell"];
  if (cellArgs?.length) {
    const others = [
      flags.range !== undefined && "--range",
      flags.localPath && "a file",
      flags.stdin && "- (stdin)",
      flags.content !== undefined && "--content",
      flags.json && "--json",
      flags.tsv && "--tsv",
      flags.header && "--header",
    ].filter(Boolean);
    if (others.length) {
      throw new AxiError(
        `--cell is the whole block; it cannot be combined with ${others.join(", ")}`,
        "VALIDATION_ERROR",
        [
          "Write scattered cells with --cell alone, or a block with --range and one source",
          "--header freezes the first row of a block written with --range A1",
        ],
      );
    }
    flags.cells = parseCellArgs(cellArgs);
    return flags;
  }
  if (flags.range === undefined) {
    throw new AxiError("Missing --range (or --cell)", "VALIDATION_ERROR", [
      "--range <A1> says where the block goes: a cell anchors it, a range bounds it",
      "Or write single cells: --cell B5=4800 --cell C9=3",
      `Usage: ${UPDATE_USAGE}`,
    ]);
  }
  checkOneSource(flags, { optional: false, what: "values", usage: UPDATE_USAGE });
  return flags;
}

export interface AppendFlags extends BlockFlags {
  spreadsheetId: string;
  tab?: string;
}

const APPEND_USAGE =
  "gws-axi sheets append <spreadsheetId> (<file> | - | --content <values>) [--tab <name|gid>]";

export function parseAppendFlags(args: string[]): AppendFlags {
  const parsed = parseArgs(args, APPEND_FLAGS, "sheets append");
  const { stdin, rest } = positionalsOf(parsed, APPEND_USAGE, 2);
  const spreadsheetId = needId(rest.shift(), APPEND_USAGE);
  const flags: AppendFlags = {
    ...blockFlags(parsed, rest, stdin),
    spreadsheetId,
    tab: parsed.values["--tab"],
  };
  checkOneSource(flags, { optional: false, what: "values", usage: APPEND_USAGE });
  return flags;
}

export interface ClearFlags {
  spreadsheetId: string;
  range?: string;
  all: boolean;
  tab?: string;
}

const CLEAR_USAGE =
  "gws-axi sheets clear <spreadsheetId> (--range <A1> | --all) [--tab <name|gid>]";

export function parseClearFlags(args: string[]): ClearFlags {
  const parsed = parseArgs(args, CLEAR_FLAGS, "sheets clear");
  const { rest } = positionalsOf(parsed, CLEAR_USAGE, 1);
  const flags: ClearFlags = {
    spreadsheetId: needId(rest[0], CLEAR_USAGE),
    range: parsed.values["--range"],
    all: parsed.booleans.has("--all"),
    tab: parsed.values["--tab"],
  };
  if (flags.range !== undefined && flags.all) {
    throw new AxiError("--range and --all are mutually exclusive", "VALIDATION_ERROR", [
      "--range empties one range; --all empties the whole tab. Pick one",
    ]);
  }
  if (flags.range === undefined && !flags.all) {
    throw new AxiError("Name what to clear: --range <A1> or --all", "VALIDATION_ERROR", [
      "A bare clear never empties a tab",
      `Usage: ${CLEAR_USAGE}`,
    ]);
  }
  return flags;
}

/** Read the source and decode it; `undefined` when there is none (create / add-tab). */
export async function loadBlock(
  flags: BlockFlags,
  opts: { allowObjects: boolean },
): Promise<JsonBlock | undefined> {
  const text = await readSource(flags, "CSV, TSV or JSON file");
  if (text === undefined) return undefined;
  if (flags.json) return parseJsonGrid(text, opts);
  const tsv = flags.tsv || /\.tsv$/i.test(flags.localPath ?? "");
  return { kind: "grid", rows: parseCsv(text, tsv ? "\t" : ",") };
}

export function refuseEmptyBlock(rows: Block): void {
  if (isEmptyBlock(rows)) {
    throw new AxiError("The block is empty — no cell would be written", "VALIDATION_ERROR", [
      "To empty cells, use `gws-axi sheets clear <id> --range <A1>`",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Fetching cells

/** The pre-read / read-back mask: entered value, display, error, number-format type. */
const TARGET_FIELDS =
  "sheets(data(startRow,startColumn,rowData(values(userEnteredValue,formattedValue,effectiveValue,effectiveFormat/numberFormat/type))))";
/** The errors-only mask: an empty object per healthy cell, the error where there is one. */
const ERROR_FIELDS =
  "sheets(data(startRow,startColumn,rowData(values(effectiveValue/errorValue))))";
const FORMULA_FIELDS =
  "sheets(data(startRow,startColumn,rowData(values(userEnteredValue/formulaValue))))";

/** Above this many allocated cells the error scan covers the written range only. */
export const ERROR_SCAN_BOUND = 200_000;

export async function fetchGrid(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
  ranges: string[],
  fields: string,
): Promise<GridDataLike[]> {
  if (ranges.length === 0) return [];
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      ranges,
      includeGridData: true,
      fields,
    });
    return (res.data.sheets ?? []).flatMap((s) => (s.data ?? []) as GridDataLike[]);
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get(gridData)" });
  }
}

/** A rectangle cut down to the tab's allocation; `undefined` when wholly outside. */
export function clipRect(
  rect: GridRect,
  grid: { rows: number; cols: number },
): GridRect | undefined {
  if (rect.r0 >= grid.rows || rect.c0 >= grid.cols) return undefined;
  return { ...rect, r1: Math.min(rect.r1, grid.rows), c1: Math.min(rect.c1, grid.cols) };
}

function cellMap(data: GridDataLike[]): Map<string, CellLike> {
  const out = new Map<string, CellLike>();
  for (const [a1, { cell }] of gridCells(data)) out.set(a1, cell);
  return out;
}

// ---------------------------------------------------------------------------
// The write path

export interface WriteTarget {
  api: sheets_v4.Sheets;
  account: string;
  meta: SpreadsheetMeta;
  tab: TabInfo;
}

export type WritePlan =
  | { kind: "block"; row0: number; col0: number; rows: Block }
  | { kind: "cells"; cells: CellArg[] };

export interface WriteOutcome {
  action: "updated" | "unchanged";
  /** Tab-qualified range written (cells comma-listed for --cell). */
  range: string;
  /** The unqualified range, for read-back suggestions. */
  a1: string;
  shape?: Shape;
  cells: number;
  changed: number;
  grid?: string;
  header?: string;
  report: WriteReport;
  errors?: ErrorDiff;
  errorScan?: string;
  writtenCells: string[];
  /** Current formulas of reported error cells, for the fix lines. */
  formulas: Map<string, string>;
}

/** The cells a plan writes, `null`s excluded. */
export function plannedCells(plan: WritePlan): PlannedCell[] {
  if (plan.kind === "cells") {
    return plan.cells.map((c) => ({ a1: c.a1, row0: c.row0, col0: c.col0, input: c.value }));
  }
  const out: PlannedCell[] = [];
  plan.rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === null) return;
      const row0 = plan.row0 + r;
      const col0 = plan.col0 + c;
      out.push({ a1: cellA1(row0, col0), row0, col0, input: v });
    }),
  );
  return out;
}

/** The rectangles a plan touches: the block's extent, or one per cell. */
export function planRects(plan: WritePlan): GridRect[] {
  if (plan.kind === "cells") {
    return plan.cells.map((c) => ({ r0: c.row0, c0: c.col0, r1: c.row0 + 1, c1: c.col0 + 1 }));
  }
  const shape = blockShape(plan.rows);
  return [
    {
      r0: plan.row0,
      c0: plan.col0,
      r1: plan.row0 + Math.max(shape.rows, 1),
      c1: plan.col0 + Math.max(shape.cols, 1),
    },
  ];
}

/** The allocation a plan needs: the tab's, grown to cover every rectangle. */
export function grownGrid(
  tab: { rows: number; cols: number },
  rects: GridRect[],
): { rows: number; cols: number; grown: boolean } {
  const rows = Math.max(tab.rows, ...rects.map((r) => r.r1));
  const cols = Math.max(tab.cols, ...rects.map((r) => r.c1));
  return { rows, cols, grown: rows > tab.rows || cols > tab.cols };
}

/** `header:` for --header: what the freeze is, and whether to send it. */
export function headerState(frozenRows: number): { send: boolean; text: string } {
  if (frozenRows === 0) return { send: true, text: "frozen" };
  if (frozenRows === 1) return { send: false, text: "frozen" };
  return { send: false, text: `frozen (${frozenRows} rows, unchanged)` };
}

async function batchUpdate(
  target: WriteTarget,
  requests: sheets_v4.Schema$Request[],
  operation: string,
  range: string,
): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
  try {
    const res = await target.api.spreadsheets.batchUpdate({
      spreadsheetId: target.meta.id,
      requestBody: { requests },
    });
    return res.data;
  } catch (err) {
    throw translateWriteError(err, {
      account: target.account,
      operation,
      spreadsheetId: target.meta.id,
      range,
    });
  }
}

/** Formulas of the reported errors the block did not write (≤5, one call). */
async function collateralFormulas(
  target: WriteTarget,
  errors: ReportedError[],
  known: Map<string, string>,
): Promise<void> {
  const want = errors
    .slice(0, 5)
    .filter((e) => !known.has(e.cell))
    .map((e) => `${quoteTitle(target.tab.title)}!${e.cell}`);
  if (want.length === 0) return;
  try {
    const data = await fetchGrid(target.api, target.account, target.meta.id, want, FORMULA_FIELDS);
    for (const [a1, { cell }] of gridCells(data)) {
      const f = cell.userEnteredValue?.formulaValue;
      if (f) known.set(a1, f);
    }
  } catch {
    // Best-effort: a fix line without a formula still names the cell.
  }
}

/** Whole-tab error scan when the allocation allows it, else `undefined`. */
function scanRange(tab: TabInfo, grid: { rows: number; cols: number }): string | undefined {
  return grid.rows * grid.cols <= ERROR_SCAN_BOUND ? quoteTitle(tab.title) : undefined;
}

/**
 * `update`'s path, shared by `create` and `add-tab` (`fresh`: a new tab, with
 * nothing to pre-read). Read → compare → grow → write → freeze → read back.
 */
export async function writePlan(
  target: WriteTarget,
  plan: WritePlan,
  opts: { raw: boolean; header: boolean; fresh?: boolean },
): Promise<WriteOutcome> {
  const { api, account, meta, tab } = target;
  const q = quoteTitle(tab.title);
  const planned = plannedCells(plan);
  const rects = planRects(plan);
  const a1 = plan.kind === "cells" ? plan.cells.map((c) => c.a1).join(",") : rectA1(rects[0]);
  const range = `${q}!${a1}`;
  const shape = plan.kind === "block" ? blockShape(plan.rows) : undefined;
  const grid = grownGrid(tab, rects);
  const wholeScan = scanRange(tab, grid);
  const writtenCells = planned.map((p) => p.a1);

  // 1. Pre-read: the target (clipped to the allocation) and the tab's errors.
  const preRanges = rects
    .map((r) => clipRect(r, tab))
    .filter((r): r is GridRect => !!r)
    .map((r) => `${q}!${rectA1(r)}`);
  const [preData, preErrData] = opts.fresh
    ? [[], []]
    : await Promise.all([
        fetchGrid(api, account, meta.id, preRanges, TARGET_FIELDS),
        wholeScan
          ? fetchGrid(api, account, meta.id, [wholeScan], ERROR_FIELDS)
          : Promise.resolve(undefined),
      ]);
  const pre = cellMap(preData);

  // 2. Compare.
  const diffs = diffBlock(planned, pre, opts.raw);
  const anyChange = diffs.some((d) => d.changed);
  const header = opts.header ? headerState(tab.frozenRows) : undefined;
  const base = {
    range,
    a1,
    shape,
    cells: planned.length,
    writtenCells,
    formulas: new Map<string, string>(),
    errorScan: wholeScan ? undefined : `written range only (tab is ${grid.rows}×${grid.cols})`,
  };
  if (!anyChange && !header?.send) {
    return {
      ...base,
      action: "unchanged",
      changed: 0,
      header: header?.text,
      report: { formulas: [], written: [], changed: 0 },
    };
  }

  // 3. Grow the allocation so the values call is never refused for its extent.
  let gridNote: string | undefined;
  if (grid.grown) {
    await batchUpdate(
      target,
      [
        {
          updateSheetProperties: {
            properties: {
              sheetId: tab.gid,
              gridProperties: { rowCount: grid.rows, columnCount: grid.cols },
            },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        },
      ],
      "sheets.spreadsheets.batchUpdate(updateSheetProperties)",
      range,
    );
    gridNote = `grown to ${grid.rows}×${grid.cols}`;
  }

  // 4. The values call.
  if (anyChange) {
    const valueInputOption = opts.raw ? "RAW" : "USER_ENTERED";
    try {
      if (plan.kind === "cells") {
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: meta.id,
          requestBody: {
            valueInputOption,
            data: plan.cells.map((c) => ({ range: `${q}!${c.a1}`, values: [[c.value]] })),
          },
        });
      } else {
        await api.spreadsheets.values.update({
          spreadsheetId: meta.id,
          range,
          valueInputOption,
          requestBody: { values: plan.rows },
        });
      }
    } catch (err) {
      throw translateWriteError(err, {
        account,
        operation: `sheets.spreadsheets.values.${plan.kind === "cells" ? "batchUpdate" : "update"}`,
        spreadsheetId: meta.id,
        range,
      });
    }
  }

  // 5. The freeze, when --header asks for one that isn't there.
  if (header?.send) {
    await batchUpdate(
      target,
      [
        {
          updateSheetProperties: {
            properties: { sheetId: tab.gid, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
      "sheets.spreadsheets.batchUpdate(updateSheetProperties)",
      range,
    );
  }

  // 6. Read back: what Sheets made of it, and the tab's errors now.
  const postRanges = rects.map((r) => `${q}!${rectA1(r)}`);
  const [postData, postErrData] = await Promise.all([
    fetchGrid(api, account, meta.id, postRanges, TARGET_FIELDS),
    wholeScan
      ? fetchGrid(api, account, meta.id, [wholeScan], ERROR_FIELDS)
      : Promise.resolve(undefined),
  ]);
  const post = cellMap(postData);
  const report = reportWrite(planned, pre, post, opts.raw);
  const errors = diffErrors(
    collectErrors(preErrData ?? preData),
    collectErrors(postErrData ?? postData),
    new Set(writtenCells),
  );
  for (const f of report.formulas) base.formulas.set(f.cell, f.formula);
  await collateralFormulas(target, errors.errors, base.formulas);

  return {
    ...base,
    action: "updated",
    changed: report.changed,
    grid: gridNote,
    header: header?.text,
    report,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Rendering

const FORMULAS_SCHEMA = [field("cell"), field("formula"), field("result"), field("message")];
const WRITTEN_SCHEMA = [field("cell"), field("before"), field("input"), field("now")];
const ERRORS_SCHEMA = [field("cell"), field("error"), field("message"), field("written")];
export const WRITTEN_CAP = 50;

/** `errors: N` and its siblings — the header lines directly under `action`. */
export function errorHeader(
  errors: ErrorDiff | undefined,
  errorScan: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (errors && (errors.errors.length > 0 || errors.fixed > 0)) {
    out.errors = errors.errors.length;
    if (errors.fixed > 0) out.errors_fixed = errors.fixed;
  }
  if (errors && errors.elsewhere > 0) out.errors_elsewhere = errors.elsewhere;
  if (errorScan) out.error_scan = errorScan;
  return out;
}

export function spreadsheetBlock(meta: SpreadsheetMeta, tab: TabInfo): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title,
    tab: tab.title,
    gid: tab.gid,
    web_view_link: tabLink(meta.id, tab.gid),
  };
}

/** The body blocks a write's outcome renders: formulas[], written[], errors[]. */
export function outcomeBlocks(
  report: WriteReport,
  errors: ErrorDiff | undefined,
  writtenOverride?: WrittenRow[],
): { blocks: string[]; writtenTotal?: number } {
  const blocks: string[] = [];
  if (report.formulas.length > 0) {
    blocks.push(renderList("formulas", report.formulas as FormulaRow[], FORMULAS_SCHEMA));
  }
  const written = writtenOverride ?? report.written;
  let writtenTotal: number | undefined;
  if (written.length > 0) {
    if (written.length > WRITTEN_CAP) writtenTotal = written.length;
    blocks.push(renderList("written", written.slice(0, WRITTEN_CAP), WRITTEN_SCHEMA));
  }
  if (errors && errors.errors.length > 0) {
    blocks.push(
      renderList(
        "errors",
        errors.errors
          .slice(0, WRITTEN_CAP)
          .map((e) => ({ ...e, written: e.written ? "yes" : "no" })),
        ERRORS_SCHEMA,
      ),
    );
  }
  return { blocks, writtenTotal };
}

/** help[]: error count, fix lines and the `sheets cell` line, when errors[] is non-empty. */
export function errorHelp(
  errors: ErrorDiff | undefined,
  formulas: Map<string, string>,
  ctx: { spreadsheetId: string; tabTitle: string; account: string; writtenCells: string[] },
): string[] {
  if (!errors || errors.errors.length === 0) return [];
  return [errorCountLine(errors.errors.length, "write"), ...fixLines(errors.errors, formulas, ctx)];
}

export function inputModeLine(raw: boolean, hasFormulaText: boolean): string {
  if (raw) {
    return hasFormulaText
      ? "Strings were stored verbatim (--raw): =… was stored as text, not a formula. Drop --raw to parse values as typed"
      : "Strings were stored verbatim (--raw); drop it to parse dates, numbers and =formulas as typed";
  }
  return "Values were parsed as typed (USER_ENTERED): dates, numbers, currencies and =formulas take effect. Pass --raw to store strings verbatim";
}

export function revisionsLine(spreadsheetId: string): string {
  return `Run \`gws-axi drive revisions ${spreadsheetId}\` for the version history; the pre-write version is the newest revision before this one`;
}

function hasFormulaText(planned: PlannedCell[]): boolean {
  return planned.some((p) => typeof p.input === "string" && p.input.startsWith("="));
}

/** The `--header` hint: a 2+ column block written at row 1 without --header. */
export function headerHint(plan: WritePlan, header: boolean, example: string): string | undefined {
  if (header || plan.kind !== "block" || plan.row0 !== 0) return undefined;
  if (blockShape(plan.rows).cols < 2) return undefined;
  return `Add --header to freeze row 1 as the header, so \`sheets read\` names columns by it: ${example}`;
}

// ---------------------------------------------------------------------------
// sheets update

/** Resolve the tab from --tab and a qualified range, which must agree. */
export function tabFromFlags(
  meta: SpreadsheetMeta,
  tabFlag: string | undefined,
  qualified: string | undefined,
  retry: (tab: string) => string,
): TabInfo {
  if (tabFlag !== undefined && qualified !== undefined) {
    const a = findTab(meta.tabs, tabFlag);
    const b = findTab(meta.tabs, qualified);
    if (!a) throw tabNotFound(meta, tabFlag);
    if (!b) throw tabNotFound(meta, qualified);
    if (a.gid !== b.gid) {
      throw new AxiError(
        `--tab ${tabFlag} and the range's tab '${qualified}' disagree`,
        "VALIDATION_ERROR",
        ["Drop --tab, or drop the tab from the range", "Nothing was written"],
      );
    }
    return a;
  }
  return requireTab(meta, qualified ?? tabFlag, retry);
}

/** Where a block goes for `--range`: its anchor, after checking it fits. */
export function placeBlock(
  rangeA1: string,
  shape: Shape,
  grid: { rows: number; cols: number },
): { row0: number; col0: number; leftOver: number } {
  const ref = parseA1(rangeA1);
  if (!ref) {
    throw new AxiError(`'${rangeA1}' is not an A1 reference`, "RANGE_INVALID", [
      "Use a cell (B2), a range (B2:D9), whole columns (B:B) or whole rows (3:3)",
      "Named ranges are not accepted here",
    ]);
  }
  const rect = toRect(ref, grid);
  if (ref.kind === "cell") return { row0: rect.r0, col0: rect.c0, leftOver: 0 };
  const height = rect.r1 - rect.r0;
  const width = rect.c1 - rect.c0;
  if (shape.rows > height || shape.cols > width) {
    throw new AxiError(
      `The block is ${shape.rows}x${shape.cols} but --range ${rangeA1} is ${height}x${width}`,
      "VALIDATION_ERROR",
      [
        `Give a single cell as --range (${cellA1(rect.r0, rect.c0)}) to let the block set its own extent, or a range large enough`,
        "Nothing was written",
      ],
    );
  }
  return { row0: rect.r0, col0: rect.c0, leftOver: height * width - shape.rows * shape.cols };
}

export async function sheetsUpdateCommand(account: string, args: string[]): Promise<string> {
  const flags = parseUpdateFlags(args);
  let plan: WritePlan;
  let qualified: string | undefined;
  let rangeA1: string | undefined;
  let rows: Block | undefined;
  if (flags.cells) {
    plan = { kind: "cells", cells: flags.cells };
    qualified = flags.cells.find((c) => c.tab !== undefined)?.tab;
  } else {
    const split = splitQualifiedRange(flags.range as string);
    qualified = split.tabTitle;
    rangeA1 = split.a1;
    if (!parseA1(rangeA1)) {
      throw new AxiError(`'${flags.range}' is not an A1 reference`, "RANGE_INVALID", [
        "Use a cell (B2), a range (B2:D9), whole columns (B:B) or whole rows (3:3)",
        "Named ranges are not accepted here",
      ]);
    }
    if (flags.header && (parseA1(rangeA1)?.r0 ?? 0) !== 0) {
      throw new AxiError(
        `--header freezes row 1, but --range ${flags.range} starts below it`,
        "VALIDATION_ERROR",
        ["The header is row 1; write it with --range A1", "Nothing was written"],
      );
    }
    const block = await loadBlock(flags, { allowObjects: false });
    rows = block?.kind === "grid" ? block.rows : [];
    refuseEmptyBlock(rows);
    plan = { kind: "block", row0: 0, col0: 0, rows };
  }

  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId);
  const tab = tabFromFlags(
    meta,
    flags.tab,
    qualified,
    (t) =>
      `gws-axi sheets update ${meta.id} --tab ${shellArg(t)} ${flags.cells ? "--cell …" : `--range ${flags.range} …`} --account ${account}`,
  );
  let leftOver = 0;
  if (plan.kind === "block" && rangeA1 && rows) {
    const placed = placeBlock(rangeA1, blockShape(rows), tab);
    plan = { kind: "block", row0: placed.row0, col0: placed.col0, rows };
    leftOver = placed.leftOver;
  }

  const target: WriteTarget = { api, account, meta, tab };
  const outcome = await writePlan(target, plan, { raw: flags.raw, header: flags.header });
  return renderUpdate(target, plan, outcome, { ...flags, leftOver });
}

function renderUpdate(
  target: WriteTarget,
  plan: WritePlan,
  outcome: WriteOutcome,
  flags: UpdateFlags & { leftOver: number },
): string {
  const { meta, tab, account } = target;
  const id = meta.id;
  const head: Record<string, unknown> = { account, action: outcome.action };
  Object.assign(head, errorHeader(outcome.errors, outcome.errorScan));
  const summary: Record<string, unknown> = { range: outcome.range };
  if (outcome.shape) summary.shape = `${outcome.shape.rows}x${outcome.shape.cols}`;
  summary.cells = outcome.cells;
  summary.changed = outcome.changed;
  if (outcome.grid) summary.grid = outcome.grid;
  if (outcome.header) summary.header = outcome.header;
  summary.input = flags.raw ? "raw" : "user-entered";
  const body = outcomeBlocks(outcome.report, outcome.errors);
  if (body.writtenTotal) summary.written_total = body.writtenTotal;

  const tabArg = shellArg(tab.title);
  const help: string[] = [
    ...errorHelp(outcome.errors, outcome.formulas, {
      spreadsheetId: id,
      tabTitle: tab.title,
      account,
      writtenCells: outcome.writtenCells,
    }),
  ];
  if (outcome.action === "unchanged") {
    help.push(
      outcome.header
        ? "Nothing was written: every cell already holds what the block would store, and row 1 is already frozen"
        : "Nothing was written: every cell already holds what the block would store",
    );
  }
  const readRange = plan.kind === "cells" ? rectA1(cellsBounds(plan.cells)) : outcome.a1;
  help.push(
    `Run \`gws-axi sheets read ${id} --tab ${tabArg} --range ${readRange}\` to read the range back`,
  );
  if (outcome.action === "updated") help.push(revisionsLine(id));
  help.push(inputModeLine(flags.raw, hasFormulaText(plannedCells(plan))));
  if (outcome.report.parsed) help.push(parsedLine(outcome.report.parsed));
  const hint = headerHint(
    plan,
    flags.header,
    `gws-axi sheets update ${id} --tab ${tabArg} --range A1 <source> --header --account ${account}`,
  );
  if (hint) help.push(hint);
  if (flags.leftOver > 0) {
    help.push(
      `${flags.leftOver} cells of the range were left as they were; \`gws-axi sheets clear ${id} --tab ${tabArg} --range <A1>\` empties them`,
    );
  }

  return joinBlocks(
    renderObject(head),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    renderObject(summary),
    ...body.blocks,
    renderHelp(help),
  );
}

function cellsBounds(cells: CellArg[]): GridRect {
  return {
    r0: Math.min(...cells.map((c) => c.row0)),
    c0: Math.min(...cells.map((c) => c.col0)),
    r1: Math.max(...cells.map((c) => c.row0)) + 1,
    c1: Math.max(...cells.map((c) => c.col0)) + 1,
  };
}

// ---------------------------------------------------------------------------
// sheets append

export async function sheetsAppendCommand(account: string, args: string[]): Promise<string> {
  const flags = parseAppendFlags(args);
  const block = (await loadBlock(flags, { allowObjects: true })) as JsonBlock;
  if (block.kind === "grid") refuseEmptyBlock(block.rows);

  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId);
  const tab = requireTab(
    meta,
    flags.tab,
    (t) => `gws-axi sheets append ${meta.id} --tab ${shellArg(t)} <source> --account ${account}`,
  );
  const q = quoteTitle(tab.title);
  const target: WriteTarget = { api, account, meta, tab };

  if (block.kind === "keyed") {
    return appendKeyed(target, block.objects, flags.raw);
  }
  const rows = block.rows;

  const wholeScan = scanRange(tab, tab);
  const preErr = wholeScan
    ? await fetchGrid(api, account, meta.id, [wholeScan], ERROR_FIELDS)
    : undefined;

  let updatedRange: string;
  try {
    const res = await api.spreadsheets.values.append({
      spreadsheetId: meta.id,
      range: q,
      valueInputOption: flags.raw ? "RAW" : "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    updatedRange = res.data.updates?.updatedRange ?? "";
  } catch (err) {
    throw translateWriteError(err, {
      account,
      operation: "sheets.spreadsheets.values.append",
      spreadsheetId: meta.id,
      range: q,
    });
  }

  // Where the rows landed: the API's updatedRange gives the first row and
  // column; the block's own shape gives the extent.
  const landed = parseA1(splitQualifiedRange(updatedRange).a1.split(":")[0]);
  const plan: WritePlan = { kind: "block", row0: landed?.r0 ?? 0, col0: landed?.c0 ?? 0, rows };
  const planned = plannedCells(plan);
  const rect = planRects(plan)[0];
  const grown = {
    rows: Math.max(tab.rows + rows.length, rect.r1),
    cols: Math.max(tab.cols, rect.c1),
  };
  const postScan = preErr ? scanRange(tab, grown) : undefined;
  const [postData, postErr] = await Promise.all([
    fetchGrid(api, account, meta.id, [`${q}!${rectA1(rect)}`], TARGET_FIELDS),
    postScan
      ? fetchGrid(api, account, meta.id, [postScan], ERROR_FIELDS)
      : Promise.resolve(undefined),
  ]);
  const report = reportWrite(planned, new Map(), cellMap(postData), flags.raw);
  const errors = diffErrors(
    collectErrors(preErr ?? []),
    collectErrors(postErr ?? postData),
    new Set(planned.map((p) => p.a1)),
  );
  const formulas = new Map(report.formulas.map((f) => [f.cell, f.formula]));
  await collateralFormulas(target, errors.errors, formulas);
  return renderAppend(target, {
    plan,
    rect,
    report,
    errors,
    formulas,
    raw: flags.raw,
    errorScan: postScan ? undefined : `written range only (tab is ${grown.rows}×${grown.cols})`,
  });
}

/**
 * Header-keyed rows go under the header, at column A of the row after the
 * last row with data in the header's columns — written through update's path,
 * not values.append, whose table detection can start the rows in another
 * column (specs/commands/sheets-write.md § Header-keyed rows).
 */
async function appendKeyed(
  target: WriteTarget,
  objects: Array<Record<string, InputValue>>,
  raw: boolean,
): Promise<string> {
  const { api, account, meta, tab } = target;
  const q = quoteTitle(tab.title);
  const headerData = await fetchGrid(
    api,
    account,
    meta.id,
    [`${q}!1:1`],
    "sheets(data(startRow,startColumn,rowData(values(formattedValue))))",
  );
  const headerCells: string[] = [];
  for (const [, { col0, row0, cell }] of gridCells(headerData)) {
    if (row0 === 0) headerCells[col0] = cell.formattedValue ?? "";
  }
  const rows = mapKeyedRows(
    objects,
    Array.from(headerCells, (h) => h ?? ""),
  );
  refuseEmptyBlock(rows);

  const lastCol = columnLetter(Math.max(headerCells.length, 1) - 1);
  let lastRow: number;
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: meta.id,
      range: `${q}!A:${lastCol}`,
      fields: "values",
    });
    lastRow = res.data.values?.length ?? 1;
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.values.get" });
  }
  const plan: WritePlan = { kind: "block", row0: Math.max(lastRow, 1), col0: 0, rows };
  const outcome = await writePlan(target, plan, { raw, header: false });
  return renderAppend(target, {
    plan,
    rect: planRects(plan)[0],
    report: outcome.report,
    errors: outcome.errors,
    formulas: outcome.formulas,
    raw,
    errorScan: outcome.errorScan,
    grid: outcome.grid,
    keyedThrough: `A:${lastCol}`,
  });
}

function renderAppend(
  target: WriteTarget,
  r: {
    plan: WritePlan & { kind: "block" };
    rect: GridRect;
    report: WriteReport;
    errors: ErrorDiff | undefined;
    formulas: Map<string, string>;
    raw: boolean;
    errorScan?: string;
    grid?: string;
    keyedThrough?: string;
  },
): string {
  const { meta, tab, account } = target;
  const q = quoteTitle(tab.title);
  const planned = plannedCells(r.plan);
  const head: Record<string, unknown> = { account, action: "appended" };
  Object.assign(head, errorHeader(r.errors, r.errorScan));
  const shape = blockShape(r.plan.rows);
  const summary: Record<string, unknown> = {
    range: `${q}!${rectA1(r.rect)}`,
    shape: `${shape.rows}x${shape.cols}`,
    cells: shape.cells,
  };
  if (r.grid) summary.grid = r.grid;
  summary.input = r.raw ? "raw" : "user-entered";
  const body = outcomeBlocks(r.report, r.errors);
  if (body.writtenTotal) summary.written_total = body.writtenTotal;

  const tabArg = shellArg(tab.title);
  const help: string[] = [
    ...errorHelp(r.errors, r.formulas, {
      spreadsheetId: meta.id,
      tabTitle: tab.title,
      account,
      writtenCells: planned.map((p) => p.a1),
    }),
  ];
  if (r.keyedThrough) {
    help.push(
      `Header-keyed rows were written under row 1's headers, after the last row with data in ${r.keyedThrough}`,
    );
  }
  help.push(
    `Run \`gws-axi sheets read ${meta.id} --tab ${tabArg} --range ${rectA1(r.rect)}\` to read the rows back`,
    "Re-running appends the same rows again (append is not idempotent)",
    revisionsLine(meta.id),
    inputModeLine(r.raw, hasFormulaText(planned)),
  );
  if (r.report.parsed) help.push(parsedLine(r.report.parsed));

  return joinBlocks(
    renderObject(head),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    renderObject(summary),
    ...body.blocks,
    renderHelp(help),
  );
}

// ---------------------------------------------------------------------------
// sheets clear

export async function sheetsClearCommand(account: string, args: string[]): Promise<string> {
  const flags = parseClearFlags(args);
  let qualified: string | undefined;
  let rangeA1: string | undefined;
  if (flags.range !== undefined) {
    const split = splitQualifiedRange(flags.range);
    qualified = split.tabTitle;
    rangeA1 = split.a1;
    if (!parseA1(rangeA1)) {
      throw new AxiError(`'${flags.range}' is not an A1 reference`, "RANGE_INVALID", [
        "Use a cell (B2), a range (B2:D9), whole columns (B:B) or whole rows (3:3)",
      ]);
    }
  }
  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId);
  const tab = tabFromFlags(
    meta,
    flags.tab,
    qualified,
    (t) =>
      `gws-axi sheets clear ${meta.id} --tab ${shellArg(t)} ${flags.all ? "--all" : `--range ${flags.range}`} --account ${account}`,
  );
  const q = quoteTitle(tab.title);
  const rect: GridRect = rangeA1
    ? toRect(parseA1(rangeA1) as NonNullable<ReturnType<typeof parseA1>>, tab)
    : { r0: 0, c0: 0, r1: Math.max(tab.rows, 1), c1: Math.max(tab.cols, 1) };
  const a1 = rectA1(rect);
  const range = `${q}!${a1}`;
  const clipped = clipRect(rect, tab);
  const wholeScan = scanRange(tab, tab);

  const [preData, preErr] = await Promise.all([
    clipped
      ? fetchGrid(api, account, meta.id, [`${q}!${rectA1(clipped)}`], TARGET_FIELDS)
      : Promise.resolve([] as GridDataLike[]),
    wholeScan
      ? fetchGrid(api, account, meta.id, [wholeScan], ERROR_FIELDS)
      : Promise.resolve(undefined),
  ]);
  const held: WrittenRow[] = [];
  for (const [cell, { cell: data }] of gridCells(preData)) {
    if (!isEmptyCell(data)) held.push({ cell, before: enteredText(data), input: "", now: "" });
  }
  const tabArg = shellArg(tab.title);
  const head: Record<string, unknown> = { account, action: held.length ? "cleared" : "unchanged" };

  if (held.length === 0) {
    return joinBlocks(
      renderObject(head),
      renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
      renderObject({ range, cells: 0 }),
      renderHelp([
        "Nothing was cleared: the range holds no values",
        `Run \`gws-axi sheets read ${meta.id} --tab ${tabArg}\` to see where the tab's data is`,
      ]),
    );
  }

  try {
    await api.spreadsheets.values.clear({ spreadsheetId: meta.id, range, requestBody: {} });
  } catch (err) {
    throw translateWriteError(err, {
      account,
      operation: "sheets.spreadsheets.values.clear",
      spreadsheetId: meta.id,
      range,
    });
  }

  const postErr = wholeScan
    ? await fetchGrid(api, account, meta.id, [wholeScan], ERROR_FIELDS)
    : await fetchGrid(
        api,
        account,
        meta.id,
        clipped ? [`${q}!${rectA1(clipped)}`] : [],
        ERROR_FIELDS,
      );
  const clearedCells = held.map((h) => h.cell);
  const errors = diffErrors(
    collectErrors(preErr ?? preData),
    collectErrors(postErr),
    new Set(clearedCells),
  );
  const formulas = new Map<string, string>();
  const target: WriteTarget = { api, account, meta, tab };
  await collateralFormulas(target, errors.errors, formulas);

  Object.assign(
    head,
    errorHeader(
      errors,
      wholeScan ? undefined : `written range only (tab is ${tab.rows}×${tab.cols})`,
    ),
  );
  const summary: Record<string, unknown> = { range, cells: held.length };
  const body = outcomeBlocks({ formulas: [], written: [], changed: 0 }, errors, held);
  if (body.writtenTotal) summary.written_total = body.writtenTotal;
  const help = [
    ...errorHelp(errors, formulas, {
      spreadsheetId: meta.id,
      tabTitle: tab.title,
      account,
      writtenCells: clearedCells,
    }),
    `Values only: formatting, validation and notes in ${a1} are as they were`,
    revisionsLine(meta.id),
  ];
  if (body.writtenTotal) {
    help.push(
      `written[] shows the first ${WRITTEN_CAP} of ${body.writtenTotal} cleared cells; the rest are in the version history`,
    );
  }
  return joinBlocks(
    renderObject(head),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    renderObject(summary),
    ...body.blocks,
    renderHelp(help),
  );
}
