import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { sheetsClient, translateGoogleError } from "../../google/client.js";
import {
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
  type FieldDef,
} from "../../output/index.js";

export const READ_HELP = `usage: gws-axi sheets read <spreadsheetId> [flags]
args[1]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
flags[7]:
  --tab <name|gid>     Tab to render (by title or numeric sheetId). Omit for a
                       single-tab file; required to pick one in a multi-tab file
  --range <A1>         Restrict to an A1 range within the tab (e.g. A1:D50). A
                       tab-qualified range (Costs!A1:D50) makes --tab optional
  --header-row         Force-promote the first fetched row to column names
                       (rows[N]{…}) instead of the A1 column-letter grid
  --raw                Force the A1 column-letter grid, overriding header
                       auto-detection
  --full               Don't cap rendered rows (default cap: 50)
  --max-rows <n>       Override the 50-row render cap (ignored with --full)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi sheets read 1AbC...
  gws-axi sheets read 1AbC... --tab Costs
  gws-axi sheets read 1AbC... --tab Costs --range A1:D50
  gws-axi sheets read 1AbC... --tab Costs --header-row
output:
  A \`spreadsheet{id,title,tab?,tab_count?}\` header, a \`sheets[N]{gid,title,
  index,rows,cols}\` tabs listing (always shown), and — when a tab is selected —
  a \`cells[N]{row,A,B,…}\` grid (real sheet row numbers + A1 column letters).
  Embedded links are resolved inline as markdown \`[text](url)\` in the cells;
  cell notes come back in a \`notes[N]{cell,note}\` block. Multi-tab files
  without --tab return only the tabs listing so you can pick one.
notes:
  A single frozen top row is auto-promoted to column names (header_source:
  frozen-row in the output); pass --raw to override, or --header-row to force
  promotion when no row is frozen.
  Cell values are FORMATTED_VALUE (displayed strings), not formulas/raw numbers.
  For review comments use \`gws-axi sheets comments <id>\` (Drive comments).
  Operates on native Google Sheets only; uploaded .xlsx/.csv route to Drive.
`;

/** Default number of data rows rendered before truncation. */
const DEFAULT_MAX_ROWS = 50;
/** Per-cell character cap. */
const CELL_CAP = 200;

interface ParsedFlags {
  spreadsheetId: string;
  tab: string | undefined;
  range: string | undefined;
  headerRow: boolean;
  raw: boolean;
  full: boolean;
  maxRows: number;
}

const KNOWN_FLAGS = new Set(["--tab", "--range", "--header-row", "--raw", "--full", "--max-rows"]);

function parseFlags(args: string[]): ParsedFlags {
  let spreadsheetId: string | undefined;
  let tab: string | undefined;
  let range: string | undefined;
  let headerRow = false;
  let raw = false;
  let full = false;
  let maxRows = DEFAULT_MAX_ROWS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      if (spreadsheetId === undefined) spreadsheetId = arg;
      continue;
    }
    switch (arg) {
      case "--tab":
        tab = args[++i];
        break;
      case "--range":
        range = args[++i];
        break;
      case "--header-row":
        headerRow = true;
        break;
      case "--raw":
        raw = true;
        break;
      case "--full":
        full = true;
        break;
      case "--max-rows": {
        const raw = args[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new AxiError(`--max-rows must be a positive integer (got '${raw}')`, "VALIDATION_ERROR", [
            "Usage: gws-axi sheets read <spreadsheetId> --max-rows <n>",
          ]);
        }
        maxRows = n;
        break;
      }
      default:
        throw new AxiError(`unknown flag ${arg} for \`sheets read\``, "VALIDATION_ERROR", [
          `valid flags: ${[...KNOWN_FLAGS].join(", ")} (globals --account, --help always allowed)`,
        ]);
    }
  }

  if (!spreadsheetId) {
    throw new AxiError("Missing spreadsheetId argument", "VALIDATION_ERROR", [
      "Usage: gws-axi sheets read <spreadsheetId> [--tab <name|gid>] [--range <A1>]",
    ]);
  }
  if (headerRow && raw) {
    throw new AxiError("--header-row and --raw are mutually exclusive", "VALIDATION_ERROR", [
      "Use --header-row to force header promotion, or --raw to force the column-letter grid",
    ]);
  }
  return { spreadsheetId, tab, range, headerRow, raw, full, maxRows };
}

/**
 * Decide whether to promote the first fetched row to column names. Explicit
 * flags win; otherwise a single frozen top row (a user-declared header) inside
 * the fetched window auto-promotes. Multi-row frozen headers are left as-is —
 * promoting only the first of several would misrepresent the data.
 */
export function resolveHeaderMode(opts: {
  explicitHeader: boolean;
  explicitRaw: boolean;
  frozenRows: number;
  originRow1: number;
}): { headerRow: boolean; auto: boolean } {
  if (opts.explicitHeader) return { headerRow: true, auto: false };
  if (opts.explicitRaw) return { headerRow: false, auto: false };
  const auto = opts.frozenRows === 1 && opts.originRow1 === 1;
  return { headerRow: auto, auto };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly, no Google client)
// ---------------------------------------------------------------------------

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

export interface RangeOrigin {
  col0: number;
  row1: number;
}

/**
 * Parse the top-left origin of a `values.get` range echo. Handles a bare range
 * (`C5:E9`), a tab-qualified range (`Costs!C5:E9`), quoted titles that may
 * contain `!` (`'My Sheet!x'!A1:B2`), absolute refs (`$C$5`), and open-ended
 * ranges (`Costs!A:D` → row 1; `Costs!5:9` → col A). Falls back to A1 when the
 * origin can't be determined, so a parse miss degrades to a safe default rather
 * than mis-addressing.
 */
export function parseRangeOrigin(range: string | undefined | null): RangeOrigin {
  const fallback: RangeOrigin = { col0: 0, row1: 1 };
  if (!range) return fallback;

  // Strip a leading tab qualifier. A quoted title ('...') ends at the closing
  // quote (doubled '' = literal quote); an unquoted title ends at the last `!`.
  let a1 = range;
  if (range.startsWith("'")) {
    const close = range.indexOf("'!", 1);
    if (close !== -1) a1 = range.slice(close + 2);
  } else {
    const bang = range.lastIndexOf("!");
    if (bang !== -1) a1 = range.slice(bang + 1);
  }

  const start = a1.split(":")[0] ?? "";
  const m = start.match(/^\$?([A-Za-z]+)?\$?([0-9]+)?$/);
  if (!m) return fallback;
  const [, letters, digits] = m;
  return {
    col0: letters ? columnIndex(letters) : 0,
    row1: digits ? Number(digits) : 1,
  };
}

function truncateCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (s.length <= CELL_CAP) return s;
  // Never truncate a cell that carries a markdown link — cutting a URL
  // mid-string yields a broken link, and the resolved link is exactly the
  // high-value content this render exists to surface.
  if (/\]\(https?:\/\//.test(s)) return s;
  return `${s.slice(0, CELL_CAP - 1)}…`;
}

export interface GridRender {
  /** Row objects ready for renderList. */
  rows: Array<Record<string, unknown>>;
  /** Column schema for renderList. */
  schema: FieldDef[];
  /** Field name for the rendered list (`cells` or `rows`). */
  listName: string;
  /** Total data rows available (before the render cap). */
  totalRows: number;
  /** Whether the render was capped below totalRows. */
  truncated: boolean;
}

/**
 * Turn a `values.get` 2D array into row objects + a matching TOON schema.
 *
 * Default: `cells[N]{row,A,B,…}` — real sheet row numbers, A1 column letters
 * from `origin`, ragged rows padded to the widest row.
 * With `headerRow`: the first fetched row becomes the column names (`rows[N]{…}`),
 * the `row` column is dropped, and duplicate/empty headers fall back to letters.
 */
export function buildGrid(
  values: unknown[][],
  origin: RangeOrigin,
  opts: { headerRow: boolean; maxRows: number; full: boolean },
): GridRender {
  const width = values.reduce((w, r) => Math.max(w, r.length), 0);
  const letters = Array.from({ length: width }, (_, j) => columnLetter(origin.col0 + j));

  if (opts.headerRow) {
    const [headerCells = [], ...dataRows] = values;
    const used = new Set<string>();
    const names = letters.map((letter, j) => {
      const raw = truncateCell(headerCells[j]).trim();
      let name = raw || letter;
      if (used.has(name)) name = `${name} (${letter})`;
      used.add(name);
      return name;
    });
    const totalRows = dataRows.length;
    const capped = opts.full ? dataRows : dataRows.slice(0, opts.maxRows);
    const rows = capped.map((r) =>
      Object.fromEntries(names.map((name, j) => [name, truncateCell(r[j])])),
    );
    return {
      rows,
      schema: names.map((n) => field(n)),
      listName: "rows",
      totalRows,
      truncated: !opts.full && totalRows > opts.maxRows,
    };
  }

  const totalRows = values.length;
  const capped = opts.full ? values : values.slice(0, opts.maxRows);
  const rows = capped.map((r, i) => {
    const obj: Record<string, unknown> = { row: origin.row1 + i };
    letters.forEach((letter, j) => {
      obj[letter] = truncateCell(r[j]);
    });
    return obj;
  });
  return {
    rows,
    schema: [field("row"), ...letters.map((l) => field(l))],
    listName: "cells",
    totalRows,
    truncated: !opts.full && totalRows > opts.maxRows,
  };
}

// ---------------------------------------------------------------------------
// Rich grid extraction (includeGridData): values with markdown-inlined links,
// plus cell notes. Pure + unit-tested; input shape mirrors the googleapis
// CellData/RowData fields we request.
// ---------------------------------------------------------------------------

export interface GridCellLike {
  formattedValue?: string | null;
  hyperlink?: string | null;
  note?: string | null;
  textFormatRuns?: Array<{
    startIndex?: number | null;
    format?: { link?: { uri?: string | null } | null } | null;
  }> | null;
}
export interface GridRowLike {
  values?: GridCellLike[] | null;
}
export interface NoteEntry {
  cell: string;
  note: string;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}
export interface ExtractedGrid {
  /** Cell values with links rendered inline as markdown `[text](url)`. */
  values: string[][];
  /** Cell notes (distinct from Drive comments), keyed by A1 cell. */
  notes: NoteEntry[];
  /** Total number of resolved links inlined into the grid. */
  linkCount: number;
}

/**
 * Render one cell's display value, inlining any embedded links as markdown.
 * - A whole-cell `hyperlink` wraps the entire value: `[value](url)`.
 * - Rich-text links (`textFormatRuns` with a `format.link.uri`) wrap only the
 *   linked span, reconstructed from the run boundaries, so a cell with several
 *   links (`…here and here`) becomes `…[here](u1) and [here](u2)`.
 * Returns `{ text, links }` where `links` counts resolved links in the cell.
 */
export function cellToMarkdown(cell: GridCellLike): { text: string; links: number } {
  const raw = cell.formattedValue ?? "";
  const runs = (cell.textFormatRuns ?? []).filter(Boolean);
  const linkRuns = runs.filter((r) => r?.format?.link?.uri);

  if (linkRuns.length > 0) {
    // Walk the string by run boundaries. Each run applies from its startIndex
    // (default 0) until the next run's startIndex (or end of string).
    const starts = runs.map((r) => r?.startIndex ?? 0);
    let out = "";
    let links = 0;
    // Leading text before the first run (if any).
    if (starts.length && starts[0] > 0) out += raw.slice(0, starts[0]);
    for (let i = 0; i < runs.length; i++) {
      const start = starts[i];
      const end = i + 1 < runs.length ? starts[i + 1] : raw.length;
      const span = raw.slice(start, end);
      const uri = runs[i]?.format?.link?.uri;
      if (uri) {
        out += `[${span}](${uri})`;
        links++;
      } else {
        out += span;
      }
    }
    return { text: out, links };
  }

  if (cell.hyperlink) {
    // Empty-text link: fall back to showing the URL as its own label.
    return raw ? { text: `[${raw}](${cell.hyperlink})`, links: 1 } : { text: cell.hyperlink, links: 1 };
  }

  return { text: raw, links: 0 };
}

/**
 * Extract a values grid (with markdown-inlined links) + notes from
 * includeGridData rowData. `origin` supplies the A1 coordinate of the top-left
 * cell so notes are addressed correctly. Trailing fully-empty rows are trimmed
 * to mirror the used-range behavior of a plain values fetch.
 */
export function extractGrid(rows: GridRowLike[], origin: RangeOrigin): ExtractedGrid {
  const values: string[][] = [];
  const notes: NoteEntry[] = [];
  let linkCount = 0;

  rows.forEach((row, ri) => {
    const cells = row.values ?? [];
    const line: string[] = cells.map((cell, ci) => {
      if (cell.note) {
        notes.push({
          cell: `${columnLetter(origin.col0 + ci)}${origin.row1 + ri}`,
          note: cell.note,
        });
      }
      const { text, links } = cellToMarkdown(cell);
      linkCount += links;
      return text;
    });
    values.push(line);
  });

  // Trim trailing fully-empty rows (includeGridData pads a bounded window).
  while (values.length > 0 && values[values.length - 1].every((c) => c === "")) {
    values.pop();
  }

  return { values, notes, linkCount };
}

// ---------------------------------------------------------------------------

interface TabInfo {
  gid: number;
  title: string;
  index: number;
  rows: number;
  cols: number;
  frozenRows: number;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}

function toTabInfo(props: sheets_v4.Schema$SheetProperties): TabInfo {
  return {
    gid: props.sheetId ?? 0,
    title: props.title ?? "",
    index: props.index ?? 0,
    rows: props.gridProperties?.rowCount ?? 0,
    cols: props.gridProperties?.columnCount ?? 0,
    frozenRows: props.gridProperties?.frozenRowCount ?? 0,
  };
}

/** Split a possibly tab-qualified A1 range into { tabTitle?, a1 }. */
function splitQualifiedRange(range: string): { tabTitle?: string; a1: string } {
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

/** Quote a tab title for use in an A1 reference. */
function quoteTitle(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

export async function sheetsReadCommand(account: string, args: string[]): Promise<string> {
  const flags = parseFlags(args);
  const api = await sheetsClient(account);

  let meta: sheets_v4.Schema$Spreadsheet;
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId: flags.spreadsheetId,
      fields:
        "spreadsheetId,properties.title,sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))",
    });
    meta = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "sheets.spreadsheets.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Spreadsheet '${flags.spreadsheetId}' not found (or ${account} doesn't have access)`,
        "SPREADSHEET_NOT_FOUND",
        [
          `Verify the spreadsheet ID is correct (the portion of the URL after /d/)`,
          `Confirm ${account} has at least view access`,
          `If this is an uploaded .xlsx/.csv (not a native Google Sheet), use \`gws-axi drive download ${flags.spreadsheetId}\` or convert it with \`gws-axi drive upload --convert\``,
        ],
      );
    }
    throw translated;
  }

  const gridSheets = (meta.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is sheets_v4.Schema$SheetProperties => !!p && (p.sheetType ?? "GRID") === "GRID")
    .map(toTabInfo);

  // Resolve which tab (if any) to render.
  //  - tab-qualified --range → that tab
  //  - --tab → by title, else by gid
  //  - single grid tab → it
  //  - multiple + no selector → disambiguation (listing only)
  let rangeA1: string | undefined = flags.range;
  let selector: string | undefined = flags.tab;
  if (flags.range) {
    const { tabTitle, a1 } = splitQualifiedRange(flags.range);
    if (tabTitle) selector = tabTitle;
    rangeA1 = a1;
  }

  let target: TabInfo | undefined;
  if (selector !== undefined) {
    target =
      gridSheets.find((t) => t.title === selector) ??
      gridSheets.find((t) => String(t.gid) === selector);
    if (!target) {
      throw new AxiError(
        `Tab '${selector}' not found in spreadsheet '${flags.spreadsheetId}'`,
        "TAB_NOT_FOUND",
        [
          `Available tabs: ${gridSheets.map((t) => `${t.title} (gid ${t.gid})`).join(", ") || "none"}`,
          `Run \`gws-axi sheets read ${flags.spreadsheetId}\` to list tabs`,
        ],
      );
    }
  } else if (gridSheets.length === 1) {
    target = gridSheets[0];
  }

  // --- assemble output ---
  const blocks: string[] = [];
  blocks.push(renderObject({ account }));

  const header: Record<string, unknown> = {
    id: meta.spreadsheetId ?? flags.spreadsheetId,
    title: meta.properties?.title ?? "",
  };
  if (target) header.tab = target.title;
  else header.tab_count = gridSheets.length;

  const tabsSchema: FieldDef[] = [
    field("gid"),
    field("title"),
    field("index"),
    field("rows"),
    field("cols"),
  ];

  // When no tab is rendered we still want the header first, then the listing.
  const suggestions: string[] = [];

  if (!target) {
    blocks.push(renderObject({ spreadsheet: header }));
    blocks.push(renderList("sheets", gridSheets, tabsSchema));
    for (const t of gridSheets.slice(0, 4)) {
      suggestions.push(
        `Run \`gws-axi sheets read ${flags.spreadsheetId} --tab ${quoteTitle(t.title)}\` to read the '${t.title}' tab`,
      );
    }
    if (suggestions.length) blocks.push(renderHelp(suggestions));
    return joinBlocks(...blocks);
  }

  // Fetch the selected tab's grid via includeGridData — one call yields cell
  // values AND embedded links (whole-cell + rich-text) AND cell notes. To keep
  // reads context-sized and fast, the default (no --range/--full) window is
  // bounded to the render cap rather than pulling the whole sheet only to cap
  // it. `+2` gives headroom so --header-row still detects rows beyond the cap.
  // An explicit --range is honored verbatim; --full pulls the whole tab.
  const boundedDefault = !flags.full && !rangeA1;
  const lastCol = target.cols > 0 ? columnLetter(target.cols - 1) : undefined;
  let windowRange: string;
  if (rangeA1) {
    windowRange = `${quoteTitle(target.title)}!${rangeA1}`;
  } else if (boundedDefault && lastCol) {
    windowRange = `${quoteTitle(target.title)}!A1:${lastCol}${flags.maxRows + 2}`;
  } else {
    windowRange = quoteTitle(target.title);
  }

  let rowData: GridRowLike[];
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId: flags.spreadsheetId,
      ranges: [windowRange],
      includeGridData: true,
      fields:
        "sheets(data(rowData(values(formattedValue,hyperlink,note,textFormatRuns(startIndex,format(link(uri)))))))",
    });
    rowData = (res.data.sheets?.[0]?.data?.[0]?.rowData ?? []) as GridRowLike[];
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get(gridData)" });
  }

  // Origin: the top-left of the fetched window. Bounded/full start at A1; an
  // explicit --range starts wherever it says.
  const origin = rangeA1 ? parseRangeOrigin(rangeA1) : { col0: 0, row1: 1 };
  const extracted = extractGrid(rowData, origin);
  const values = extracted.values;

  if (values.length === 0) {
    blocks.push(renderObject({ spreadsheet: header }));
    blocks.push(renderList("sheets", gridSheets, tabsSchema));
    blocks.push(renderObject({ cells: `no data in ${rangeA1 ?? target.title}` }));
    suggestions.push(
      `Run \`gws-axi drive revisions ${flags.spreadsheetId}\` to see this spreadsheet's version history`,
    );
    blocks.push(renderHelp(suggestions));
    return joinBlocks(...blocks);
  }

  const headerMode = resolveHeaderMode({
    explicitHeader: flags.headerRow,
    explicitRaw: flags.raw,
    frozenRows: target.frozenRows,
    originRow1: origin.row1,
  });
  if (headerMode.auto) header.header_source = "frozen-row";

  const grid = buildGrid(values, origin, {
    headerRow: headerMode.headerRow,
    maxRows: flags.maxRows,
    full: flags.full,
  });

  if (grid.truncated) {
    header.cells_truncated = true;
    header.cells_rendered = grid.rows.length;
    if (boundedDefault) {
      // We fetched only a bounded window, so the exact total is unknown — state
      // that more rows exist rather than reporting a misleading count.
      header.cells_note = `rendered first ${grid.rows.length} rows; more exist beyond the cap`;
    } else {
      header.cells_total_rows = grid.totalRows;
    }
  }
  if (extracted.linkCount > 0) header.links_resolved = extracted.linkCount;
  if (extracted.notes.length > 0) header.notes = extracted.notes.length;

  blocks.push(renderObject({ spreadsheet: header }));
  blocks.push(renderList("sheets", gridSheets, tabsSchema));
  blocks.push(renderList(grid.listName, grid.rows, grid.schema));
  if (extracted.notes.length > 0) {
    blocks.push(renderList("notes", extracted.notes, [field("cell"), field("note")]));
  }

  // help[]
  if (grid.truncated) {
    suggestions.push(
      `Run \`gws-axi sheets read ${flags.spreadsheetId} --tab ${quoteTitle(target.title)} --full\` to render all ${grid.totalRows} rows, or add \`--range <A1>\` to scope`,
    );
  }
  if (grid.listName === "rows") {
    suggestions.push(
      headerMode.auto
        ? `First row auto-promoted to headers (a single frozen row); run with \`--raw\` for the A1 column-letter grid instead`
        : `Run with \`--raw\` for the A1 column-letter grid (row numbers + column letters) instead`,
    );
  } else {
    suggestions.push(
      `Run with \`--header-row\` to promote the first row to column names (drops A1 addressing)`,
    );
  }
  if (extracted.linkCount > 0) {
    suggestions.push(
      `${extracted.linkCount} embedded link(s) resolved inline as markdown \`[text](url)\` in the cells above`,
    );
  }
  suggestions.push(
    `Cell values are FORMATTED_VALUE (displayed strings), not formulas or raw numbers; embedded links are inlined as markdown and cell notes (if any) are in the notes[] block`,
  );
  suggestions.push(
    `Run \`gws-axi sheets comments ${flags.spreadsheetId}\` for review comments, or \`gws-axi drive revisions ${flags.spreadsheetId}\` / \`gws-axi drive activity ${flags.spreadsheetId}\` for version history`,
  );
  blocks.push(renderHelp(suggestions));

  return joinBlocks(...blocks);
}
