import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { sheetsClient } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import {
  type CellLike,
  type FormulaRef,
  type GridRect,
  type SpreadsheetMeta,
  type TabInfo,
  cellA1,
  cellArg,
  errorText,
  fetchMeta,
  findTab,
  gridCells,
  parseA1,
  parseFormulaRefs,
  displayTitle,
  quoteTitle,
  rectA1,
  requireTab,
  shellArg,
  splitQualifiedRange,
  tabNotFound,
  toRect,
} from "./shared.js";
import { fetchGrid } from "./write.js";

export { parseFormulaRefs, type FormulaRef } from "./shared.js";

/**
 * `sheets cell` (specs/commands/sheets-cell.md): one cell — what was entered,
 * what it shows, and for a formula the current value of every cell it reads.
 * Read-only.
 */

export const CELL_HELP = `usage: gws-axi sheets cell <spreadsheetId> <A1> [--tab <name|gid>] [--depth <n>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <A1>                 One cell, optionally tab-qualified (Costs!D2)
flags[3]:
  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet unless the cell names it
  --depth <n>          Levels of referenced formulas to expand (default 1, max 3)
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi sheets cell 1AbC... D2 --tab Costs
  gws-axi sheets cell 1AbC... 'Costs!E9' --depth 2
output:
  cell{ref,formula,value,error,message,kind,note,link,number_format,validation}
  — fields only when they apply — then, for a formula, refs[N]{ref,kind,value,
  formula}: every cell it references, in formula order (a range shows its first
  20 cells and ref_cells_total). --depth 2+ adds refs_<ref>[N] blocks for
  referenced formulas.
notes:
  The detail view for a formula error: the message names the symptom, the
  referenced values name the cause. INDIRECT/OFFSET references are listed as
  kind: dynamic with no value — they are computed, not written in the formula.
`;

export const CELL_FLAGS: FlagSpec = { value: ["--tab", "--depth"], boolean: [] };

const USAGE = "gws-axi sheets cell <spreadsheetId> <A1> [--tab <name|gid>] [--depth <n>]";
/** Cells shown per referenced range. */
const REF_CAP = 20;

export interface CellFlags {
  spreadsheetId: string;
  cell: string;
  cellTab?: string;
  tab?: string;
  depth: number;
}

export function parseCellFlags(args: string[]): CellFlags {
  const parsed = parseArgs(args, CELL_FLAGS, "sheets cell");
  const [spreadsheetId, ref, extra] = parsed.positionals;
  if (!spreadsheetId || !ref) {
    throw new AxiError("Missing spreadsheetId or cell argument", "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  if (extra !== undefined) {
    throw new AxiError(`Unexpected argument: ${extra}`, "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  const { tabTitle, a1 } = splitQualifiedRange(ref);
  const parsedRef = parseA1(a1);
  if (!parsedRef) {
    throw new AxiError(`'${ref}' is not an A1 cell`, "VALIDATION_ERROR", [
      "Name one cell, e.g. D2 or Costs!D2",
    ]);
  }
  if (parsedRef.kind !== "cell") {
    throw new AxiError(`'${ref}' is a range — sheets cell shows one cell`, "VALIDATION_ERROR", [
      `Run \`gws-axi sheets read ${spreadsheetId} --range ${shellArg(ref)}\` to read a range`,
    ]);
  }
  const rawDepth = parsed.values["--depth"];
  const depth = rawDepth === undefined ? 1 : Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    throw new AxiError(`--depth takes 1, 2 or 3, got: ${rawDepth}`, "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  return {
    spreadsheetId,
    cell: cellA1(parsedRef.r0 as number, parsedRef.c0 as number),
    cellTab: tabTitle,
    tab: parsed.values["--tab"],
    depth,
  };
}

// ---------------------------------------------------------------------------
// Rendering a cell

export type CellKind = "number" | "text" | "bool" | "error" | "empty";

export function cellKind(cell: CellLike | undefined): CellKind {
  const v = cell?.effectiveValue;
  if (!v) return "empty";
  if (v.errorValue) return "error";
  if (v.numberValue != null) return "number";
  if (v.boolValue != null) return "bool";
  if (v.stringValue != null) return "text";
  return "empty";
}

interface DetailCell extends CellLike {
  note?: string | null;
  hyperlink?: string | null;
  dataValidation?: sheets_v4.Schema$DataValidationRule | null;
  userEnteredFormat?: {
    numberFormat?: { type?: string | null; pattern?: string | null } | null;
  } | null;
}

export function validationSummary(
  rule: sheets_v4.Schema$DataValidationRule | null | undefined,
): string | undefined {
  const cond = rule?.condition;
  if (!cond?.type) return undefined;
  const values = (cond.values ?? [])
    .map((v) => v.userEnteredValue ?? v.relativeDate ?? "")
    .filter(Boolean);
  return values.length ? `${cond.type} ${values.join(", ")}` : cond.type;
}

export interface RefRow {
  ref: string;
  kind: string;
  value: string;
  formula: string;
  [key: string]: unknown;
}

/** A row plus where it lives, for expanding the next level. */
interface Located {
  row: RefRow;
  tab?: TabInfo;
}

interface Resolved {
  ref: FormulaRef;
  /** Tab the reference points at (undefined → missing tab or unknown name). */
  tab?: TabInfo;
  rect?: GridRect;
  label: string;
}

/** Resolve a reference's tab and rectangle; named ranges through the metadata. */
export function resolveRef(ref: FormulaRef, home: TabInfo, meta: SpreadsheetMeta): Resolved {
  if (ref.dynamic) return { ref, label: ref.text };
  if (ref.a1 === undefined) {
    const named = meta.namedRanges.find((n) => n.name?.toUpperCase() === ref.name?.toUpperCase());
    const gr = named?.range;
    const tab = gr ? meta.tabs.find((t) => t.gid === (gr.sheetId ?? 0)) : undefined;
    if (!gr || !tab) return { ref, label: ref.text };
    const rect = {
      r0: gr.startRowIndex ?? 0,
      r1: gr.endRowIndex ?? tab.rows,
      c0: gr.startColumnIndex ?? 0,
      c1: gr.endColumnIndex ?? tab.cols,
    };
    return { ref, tab, rect, label: ref.text };
  }
  const tab = ref.tab !== undefined ? findTab(meta.tabs, ref.tab) : home;
  const qual = ref.tab !== undefined ? `${displayTitle(ref.tab)}!` : "";
  const parsed = parseA1(ref.a1);
  if (!parsed || !tab) return { ref, label: `${qual}${ref.a1}` };
  return { ref, tab, rect: toRect(parsed, tab), label: `${qual}${ref.a1}` };
}

const REF_FIELDS =
  "sheets(properties(sheetId),data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue/formulaValue,effectiveValue))))";

/** Fetch every resolvable reference in one call; rows in reference order. */
async function expandRefs(
  api: sheets_v4.Sheets,
  meta: SpreadsheetMeta,
  home: TabInfo,
  refs: FormulaRef[],
): Promise<{ rows: Located[]; total: number; capped: Resolved[] }> {
  const resolved = refs.map((r) => resolveRef(r, home, meta));
  const fetchable = resolved.filter(
    (r): r is Resolved & { tab: TabInfo; rect: GridRect } => !!r.tab && !!r.rect,
  );
  const clip = (r: { tab: TabInfo; rect: GridRect }): GridRect => ({
    ...r.rect,
    r1: Math.min(r.rect.r1, Math.max(r.tab.rows, r.rect.r0 + 1)),
    c1: Math.min(r.rect.c1, Math.max(r.tab.cols, r.rect.c0 + 1)),
  });
  const ranges = fetchable.map((r) => `${quoteTitle(r.tab.title)}!${rectA1(clip(r))}`);
  // One call; each range comes back as a GridData under its sheet, in request order.
  let sheets: sheets_v4.Schema$Sheet[] = [];
  if (ranges.length) {
    try {
      const res = await api.spreadsheets.get({
        spreadsheetId: meta.id,
        ranges,
        includeGridData: true,
        fields: REF_FIELDS,
      });
      sheets = res.data.sheets ?? [];
    } catch {
      // A reference upstream cannot fetch shows as empty rather than failing the view.
    }
  }
  const perSheet = new Map<number, number>();
  const rows: Located[] = [];
  const capped: Resolved[] = [];
  let total = 0;
  for (const r of resolved) {
    if (r.ref.dynamic || (r.ref.a1 === undefined && !r.tab)) {
      rows.push({ row: { ref: r.label, kind: "dynamic", value: "", formula: "" } });
      continue;
    }
    if (!r.tab || !r.rect) {
      // A tab that does not exist: the formula shows #REF!, nothing to fetch.
      rows.push({ row: { ref: r.label, kind: "error", value: "#REF!", formula: "" } });
      continue;
    }
    const tab = r.tab;
    const k = perSheet.get(tab.gid) ?? 0;
    perSheet.set(tab.gid, k + 1);
    const sheet = sheets.find((sh) => (sh.properties?.sheetId ?? 0) === tab.gid);
    const data = sheet?.data?.[k];
    const found = gridCells(data ? [data] : []);
    const qual =
      tab.gid === home.gid && r.ref.tab === undefined ? "" : `${displayTitle(tab.title)}!`;
    const rect = clip({ tab, rect: r.rect });
    const kind = r.ref.a1 ? parseA1(r.ref.a1)?.kind : "range";
    // Whole columns/rows stop at the tab's data, not its allocation.
    const cells = [...found.values()];
    const r1 = kind === "cols" ? Math.max(rect.r0, ...cells.map((c) => c.row0 + 1)) : rect.r1;
    const c1 = kind === "rows" ? Math.max(rect.c0, ...cells.map((c) => c.col0 + 1)) : rect.c1;
    const coords: string[] = [];
    for (let row = rect.r0; row < r1; row++) {
      for (let col = rect.c0; col < c1; col++) coords.push(cellA1(row, col));
    }
    total += coords.length;
    if (coords.length > REF_CAP) capped.push(r);
    for (const a1 of coords.slice(0, REF_CAP)) {
      const cell = found.get(a1)?.cell;
      const err = cell?.effectiveValue?.errorValue;
      rows.push({
        tab,
        row: {
          ref: `${qual}${a1}`,
          kind: cellKind(cell),
          value: err ? (cell?.formattedValue ?? errorText(err.type)) : (cell?.formattedValue ?? ""),
          formula: cell?.userEnteredValue?.formulaValue ?? "",
        },
      });
    }
  }
  return { rows, total, capped };
}

const REF_SCHEMA = [field("ref"), field("kind"), field("value"), field("formula")];

export async function sheetsCellCommand(account: string, args: string[]): Promise<string> {
  const flags = parseCellFlags(args);
  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId, { namedRanges: true });
  let tab: TabInfo;
  if (flags.cellTab !== undefined && flags.tab !== undefined) {
    const a = findTab(meta.tabs, flags.tab);
    const b = findTab(meta.tabs, flags.cellTab);
    if (!a) throw tabNotFound(meta, flags.tab);
    if (!b) throw tabNotFound(meta, flags.cellTab);
    if (a.gid !== b.gid) {
      throw new AxiError(
        `--tab ${flags.tab} and the cell's tab '${flags.cellTab}' disagree`,
        "VALIDATION_ERROR",
        ["Drop --tab, or drop the tab from the cell"],
      );
    }
    tab = a;
  } else {
    tab = requireTab(
      meta,
      flags.cellTab ?? flags.tab,
      (t) => `gws-axi sheets cell ${meta.id} ${flags.cell} --tab ${shellArg(t)}`,
    );
  }
  const q = quoteTitle(tab.title);
  const data = await fetchGrid(
    api,
    account,
    meta.id,
    [`${q}!${flags.cell}`],
    "sheets(data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue,effectiveValue,note,hyperlink,dataValidation,userEnteredFormat/numberFormat))))",
  );
  const cell = gridCells(data).get(flags.cell)?.cell as DetailCell | undefined;
  const formula = cell?.userEnteredValue?.formulaValue ?? undefined;
  const err = cell?.effectiveValue?.errorValue;

  const detail: Record<string, unknown> = { ref: `${displayTitle(tab.title)}!${flags.cell}` };
  if (formula) detail.formula = formula;
  detail.value = cell?.formattedValue ?? "";
  if (err) {
    detail.error = err.type ?? "ERROR";
    if (err.message) detail.message = err.message;
  }
  detail.kind = cellKind(cell);
  if (cell?.note) detail.note = cell.note;
  if (cell?.hyperlink) detail.link = cell.hyperlink;
  const nf = cell?.userEnteredFormat?.numberFormat;
  if (nf?.type) detail.number_format = nf.pattern ? `${nf.type} ${nf.pattern}` : nf.type;
  const validation = validationSummary(cell?.dataValidation);
  if (validation) detail.validation = validation;

  const tabArg = shellArg(tab.title);
  const blocks: string[] = [renderObject({ account }), renderObject({ cell: detail })];
  const help: string[] = [];
  if (err && formula) {
    help.push(
      `Fix: gws-axi sheets update ${meta.id} --tab ${tabArg} --cell ${cellArg(flags.cell, formula)} --account ${account}`,
    );
  }

  let capped: Resolved[] = [];
  if (formula) {
    const level1 = await expandRefs(api, meta, tab, parseFormulaRefs(formula));
    capped = [...level1.capped];
    if (level1.capped.length > 0) blocks.push(renderObject({ ref_cells_total: level1.total }));
    blocks.push(
      level1.rows.length
        ? renderList(
            "refs",
            level1.rows.map((l) => l.row),
            REF_SCHEMA,
          )
        : renderObject({ refs: "the formula references no cells" }),
    );
    const next = level1.rows.find((l) => l.row.kind === "error" || l.row.formula);
    if (next) {
      const where = next.tab && next.tab.gid !== tab.gid ? next.tab.title : tab.title;
      const bare = next.row.ref.includes("!") ? splitQualifiedRange(next.row.ref).a1 : next.row.ref;
      help.push(
        `Run \`gws-axi sheets cell ${meta.id} ${bare} --tab ${shellArg(where)}\` to inspect a referenced cell`,
      );
    }

    // --depth: breadth-first through referenced formulas; cycles reported, not followed.
    const key = (t: TabInfo, ref: string) =>
      `${t.gid}!${ref.includes("!") ? splitQualifiedRange(ref).a1 : ref}`;
    const visited = new Set<string>([key(tab, flags.cell)]);
    let frontier = level1.rows.filter((l) => l.row.formula && l.tab);
    for (let level = 2; level <= flags.depth && frontier.length; level++) {
      const nextFrontier: Located[] = [];
      for (const l of frontier) {
        const home = l.tab as TabInfo;
        const k = key(home, l.row.ref);
        if (visited.has(k)) {
          help.push(`Cycle: ${l.row.ref} is already expanded — not followed again`);
          continue;
        }
        visited.add(k);
        const expanded = await expandRefs(api, meta, home, parseFormulaRefs(l.row.formula));
        blocks.push(
          renderList(
            `refs_${l.row.ref}`,
            expanded.rows.map((e) => e.row),
            REF_SCHEMA,
          ),
        );
        capped.push(...expanded.capped);
        nextFrontier.push(...expanded.rows.filter((e) => e.row.formula && e.tab));
      }
      frontier = nextFrontier;
    }
  }

  for (const r of capped.slice(0, 2)) {
    help.push(
      `Run \`gws-axi sheets read ${meta.id} --tab ${shellArg((r.tab as TabInfo).title)} --range ${rectA1(r.rect as GridRect)}\` for the whole range (refs shows its first ${REF_CAP} cells)`,
    );
  }
  const row = Number(flags.cell.replace(/^[A-Z]+/, ""));
  help.push(
    `Run \`gws-axi sheets read ${meta.id} --tab ${tabArg} --range ${row}:${row} --formulas\` to see the formula among its neighbors`,
  );
  blocks.push(renderHelp(help));
  return joinBlocks(...blocks);
}
