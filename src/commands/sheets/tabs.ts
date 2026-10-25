import { AxiError } from "axi-sdk-js";
import type { sheets_v4 } from "googleapis";
import { sheetsClient, translateGoogleError } from "../../google/client.js";
import {
  type FieldDef,
  computed,
  field,
  joinBlocks,
  renderHelp,
  renderList,
  renderObject,
} from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import type { TabSummary } from "../docs/tabs.js";
import type { TabPlacement } from "./add-tab.js";
import {
  type CellError,
  type ErrorDiff,
  type GridDataLike,
  type SpreadsheetMeta,
  collectErrors,
  compareA1,
  diffErrors,
  displayTitle,
  fixLines,
  gridCells,
  quoteTitle,
  shellArg,
  splitQualifiedRange,
  spreadsheetNotFound,
  toTabInfo,
  translateWriteError,
} from "./shared.js";
import { ERROR_SCAN_BOUND, WRITTEN_CAP, errorHeader } from "./write.js";

/**
 * Sheet-listing helper for `drive upload --update`. A spreadsheet's sheets are
 * its tabs (the same framing `sheets read` uses), and replacing a Spreadsheet's
 * content collapses it to a single sheet exactly as a Doc collapses to a single
 * tab — so the guard needs a count before it writes.
 *
 * Shares `TabSummary` with the Docs helper: one shape for "named sub-surface of
 * a container file", so `drive upload` handles both with one code path.
 */

/** Field mask for a sheet-count fetch: identity only, no cell data. */
const SHEET_COUNT_FIELDS = "sheets.properties(sheetId,title)";

/**
 * List a Spreadsheet's sheets (identity only). Returns `[]` when the API
 * reports none — callers treat "unknown" as "not multi-sheet" rather than
 * blocking a write on a missing field.
 */
export async function listSpreadsheetSheets(
  account: string,
  spreadsheetId: string,
): Promise<TabSummary[]> {
  const sheets = await sheetsClient(account);
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: SHEET_COUNT_FIELDS,
    });
    return (res.data.sheets ?? []).map((sheet) => ({
      id: sheet.properties?.sheetId != null ? String(sheet.properties.sheetId) : "",
      title: sheet.properties?.title ?? "",
    }));
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get" });
  }
}

// ---------------------------------------------------------------------------
// sheets tabs, sheets tabs update, sheets tabs delete
// (specs/commands/sheets-tabs.md). A spreadsheet's sheets as objects — chart
// sheets included — with the placement vocabulary `sheets add-tab` and
// `docs tabs` share.

export const TABS_HELP = `usage: gws-axi sheets tabs <spreadsheetId> [flags]
       gws-axi sheets tabs update <spreadsheetId> <tab> [--title <title>] [--first | --last | --before <tab> | --after <tab>] [--hide | --show] [--freeze-rows <n>] [--freeze-cols <n>] [flags]
       gws-axi sheets tabs delete <spreadsheetId> <tab> [flags]
args[1]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
flags[1]:
  --account <email>    Account to read with (default: the default account)
examples:
  gws-axi sheets tabs 1AbC...
  gws-axi sheets tabs update 1AbC... Archive --first --account you@example.com
  gws-axi sheets tabs delete 1AbC... Archive --account you@example.com
output:
  tabs[N]{gid,title,index,kind,hidden,frozen_rows,frozen_cols} — every sheet in
  order, chart sheets included (kind: chart; frozen_* empty).
notes:
  Properties only, no cells, so it is cheap on any spreadsheet. \`sheets read\`
  lists grid tabs only; this lists every sheet. \`sheets tabs update --help\` and
  \`sheets tabs delete --help\` describe the writes.
`;

export const TABS_UPDATE_HELP = `usage: gws-axi sheets tabs update <spreadsheetId> <tab> [--title <title>] [--first | --last | --before <tab> | --after <tab>] [--hide | --show] [--freeze-rows <n>] [--freeze-cols <n>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <tab>                The sheet to change: title or gid (chart sheets too)
flags[11]:
  --title <title>      Rename it (titles are unique, ignoring case)
  --first              Move it first
  --last               Move it last
  --before <tab>       Move it before this sheet (title or gid)
  --after <tab>        Move it after this sheet (title or gid)
  --hide               Hide it (one sheet must stay visible)
  --show               Show it
  --freeze-rows <n>    Freeze the top n rows; 0 unfreezes. 1 is the header row
                       \`sheets read\` promotes to column names
  --freeze-cols <n>    Freeze the left n columns; 0 unfreezes
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets tabs update 1AbC... Archive --first --account you@example.com
  gws-axi sheets tabs update 1AbC... 882013 --title "Archive 2025" --hide --account you@example.com
  gws-axi sheets tabs update 1AbC... Costs --freeze-rows 1 --account you@example.com
output:
  action: updated (or unchanged), changed[] (the properties written), tab{} as
  it is now, the tabs[N] listing, and an undo line.
notes:
  One request, every flag combinable. Idempotent: when the sheet already
  matches, action: unchanged and nothing is written. Freezing is the only
  formatting-adjacent property; a chart sheet has no grid to freeze.
`;

export const TABS_DELETE_HELP = `usage: gws-axi sheets tabs delete <spreadsheetId> <tab> [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <tab>                The sheet to delete: title or gid (chart sheets too)
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets tabs delete 1AbC... Archive --account you@example.com
output:
  action: deleted, deleted{gid,title,kind,cells} (cells: the populated cells it
  held), errors[] for formulas on other tabs the delete broke (#REF!) with a fix
  line each, and the tabs[N] that remain.
notes:
  The content leaves the live spreadsheet but stays in version history
  (\`drive revisions\`). The only sheet can't be deleted — \`sheets clear\` empties
  it — nor the only visible one while others are hidden. The error scan covers
  the whole spreadsheet up to ${ERROR_SCAN_BOUND.toLocaleString("en-US")} allocated cells; past that it is skipped
  and the header says so. An unknown tab is TAB_NOT_FOUND, not a no-op.
`;

export const TABS_FLAGS: FlagSpec = { value: [], boolean: [] };
export const TABS_UPDATE_FLAGS: FlagSpec = {
  value: ["--title", "--before", "--after", "--freeze-rows", "--freeze-cols"],
  boolean: ["--first", "--last", "--hide", "--show"],
};
export const TABS_DELETE_FLAGS: FlagSpec = { value: [], boolean: [] };

const LIST_USAGE = "gws-axi sheets tabs <spreadsheetId>";
const UPDATE_USAGE =
  "gws-axi sheets tabs update <spreadsheetId> <tab> [--title <title>] [--first | --last | --before <tab> | --after <tab>] [--hide | --show] [--freeze-rows <n>] [--freeze-cols <n>]";
const DELETE_USAGE = "gws-axi sheets tabs delete <spreadsheetId> <tab>";

export type SheetKind = "grid" | "chart" | "other";

/** One sheet as this group lists it — grid or not. */
export interface SheetRow {
  gid: number;
  title: string;
  index: number;
  kind: SheetKind;
  hidden: boolean;
  /** Grid sheets only. */
  frozenRows?: number;
  frozenCols?: number;
  rows?: number;
  cols?: number;
  // Assignable to renderList's Record<string, unknown> row type.
  [key: string]: unknown;
}

/** Upstream calls a chart sheet `OBJECT` (observed); `kind` names what it holds. */
export function sheetKind(sheetType: string | null | undefined): SheetKind {
  const t = sheetType ?? "GRID";
  if (t === "GRID") return "grid";
  if (t === "OBJECT") return "chart";
  return "other";
}

export function toSheetRow(p: sheets_v4.Schema$SheetProperties): SheetRow {
  const kind = sheetKind(p.sheetType);
  const row: SheetRow = {
    gid: p.sheetId ?? 0,
    title: p.title ?? "",
    index: p.index ?? 0,
    kind,
    hidden: p.hidden === true,
  };
  if (kind === "grid") {
    row.frozenRows = p.gridProperties?.frozenRowCount ?? 0;
    row.frozenCols = p.gridProperties?.frozenColumnCount ?? 0;
    row.rows = p.gridProperties?.rowCount ?? 0;
    row.cols = p.gridProperties?.columnCount ?? 0;
  }
  return row;
}

const SHEET_LIST_SCHEMA: FieldDef[] = [
  field("gid"),
  field("title"),
  field("index"),
  field("kind"),
  computed("hidden", (s) => (s.hidden ? "yes" : "no")),
  computed("frozen_rows", (s) => s.frozenRows),
  computed("frozen_cols", (s) => s.frozenCols),
];

export function renderSheetList(sheets: SheetRow[]): string {
  return renderList("tabs", sheets, SHEET_LIST_SCHEMA);
}

function sheetView(s: SheetRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    gid: s.gid,
    title: s.title,
    index: s.index,
    kind: s.kind,
    hidden: s.hidden ? "yes" : "no",
  };
  if (s.kind === "grid") {
    out.frozen_rows = s.frozenRows;
    out.frozen_cols = s.frozenCols;
  }
  return out;
}

const SHEET_FIELDS =
  "spreadsheetId,properties(title,locale),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))";

export interface SheetState {
  meta: SpreadsheetMeta;
  /** Every sheet, grid and chart, in index order. */
  sheets: SheetRow[];
}

/** Every sheet's properties (no cells) — the read this group starts from. */
export async function fetchSheets(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
): Promise<SheetState> {
  let data: sheets_v4.Schema$Spreadsheet;
  try {
    const res = await api.spreadsheets.get({ spreadsheetId, fields: SHEET_FIELDS });
    data = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "sheets.spreadsheets.get" });
    if (translated.code === "NOT_FOUND") throw spreadsheetNotFound(spreadsheetId, account);
    throw translated;
  }
  const props = (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is sheets_v4.Schema$SheetProperties => !!p);
  const sheets = props.map(toSheetRow).sort((a, b) => a.index - b.index);
  return {
    meta: {
      id: data.spreadsheetId ?? spreadsheetId,
      title: data.properties?.title ?? "",
      tabs: props.filter((p) => sheetKind(p.sheetType) === "grid").map(toTabInfo),
      otherTitles: props.filter((p) => sheetKind(p.sheetType) !== "grid").map((p) => p.title ?? ""),
      namedRanges: [],
      locale: data.properties?.locale ?? undefined,
    },
    sheets,
  };
}

/** Title first, then numeric gid — every `sheets` command's order — over every sheet. */
export function findSheet(sheets: SheetRow[], selector: string): SheetRow | undefined {
  return sheets.find((s) => s.title === selector) ?? sheets.find((s) => String(s.gid) === selector);
}

function describeSheets(sheets: SheetRow[]): string {
  return (
    sheets
      .map((s) => `${s.title} (gid ${s.gid}${s.kind === "grid" ? "" : `, ${s.kind}`})`)
      .join(", ") || "none"
  );
}

export function sheetNotFound(state: SheetState, selector: string, what = "Tab"): AxiError {
  return new AxiError(
    `${what} '${selector}' not found in spreadsheet '${state.meta.id}'`,
    "TAB_NOT_FOUND",
    [
      `Available tabs: ${describeSheets(state.sheets)}`,
      `Run \`gws-axi sheets tabs ${state.meta.id}\` to list every sheet`,
      "Nothing was written",
    ],
  );
}

function requireSheet(state: SheetState, selector: string, what = "Tab"): SheetRow {
  const found = findSheet(state.sheets, selector);
  if (!found) throw sheetNotFound(state, selector, what);
  return found;
}

function positionals(args: string[], spec: FlagSpec, command: string, usage: string) {
  const parsed = parseArgs(args, spec, command);
  const [spreadsheetId, tab, extra] = parsed.positionals;
  if (!spreadsheetId) {
    throw new AxiError("Missing spreadsheetId argument", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "The spreadsheetId is the portion of the URL after /d/",
    ]);
  }
  return { parsed, spreadsheetId, tab, extra };
}

function requireTabArg(tab: string | undefined, extra: string | undefined, usage: string): string {
  if (tab === undefined || tab === "") {
    throw new AxiError("Missing tab argument (title or gid)", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "Run `gws-axi sheets tabs <spreadsheetId>` to list every sheet",
    ]);
  }
  if (extra !== undefined) {
    throw new AxiError(`Unexpected argument: ${extra}`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
  }
  return tab;
}

function acct(account: string): string {
  return ` --account ${account}`;
}

// ---------------------------------------------------------------------------
// sheets tabs

export async function sheetsTabsCommand(account: string, args: string[]): Promise<string> {
  const { spreadsheetId, tab } = positionals(args, TABS_FLAGS, "sheets tabs", LIST_USAGE);
  if (tab !== undefined) {
    throw new AxiError(`Unexpected argument: ${tab}`, "VALIDATION_ERROR", [
      `Usage: ${LIST_USAGE}`,
      `To change a tab: ${UPDATE_USAGE}`,
    ]);
  }
  const api = await sheetsClient(account);
  const state = await fetchSheets(api, account, spreadsheetId);
  const id = state.meta.id;
  return joinBlocks(
    renderObject({ account }),
    renderObject({ spreadsheet: { id, title: state.meta.title } }),
    renderSheetList(state.sheets),
    renderHelp([
      `Run \`gws-axi sheets read ${id} --tab <title>\` to read one`,
      `Run \`gws-axi sheets tabs update ${id} <tab> --first|--title "<title>"|--hide|--freeze-rows 1${acct(account)}\` to move, rename, hide or freeze a tab`,
      `Run \`gws-axi sheets tabs delete ${id} <tab>${acct(account)}\` to delete one`,
    ]),
  );
}

// ---------------------------------------------------------------------------
// sheets tabs update

export interface TabUpdateFlags {
  spreadsheetId: string;
  tab: string;
  title?: string;
  placement?: TabPlacement;
  hidden?: boolean;
  frozenRows?: number;
  frozenCols?: number;
}

function freezeCount(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\s*\d+\s*$/.test(raw) || !Number.isSafeInteger(n)) {
    throw new AxiError(
      `${flag} expects a non-negative whole number, got: ${raw}`,
      "VALIDATION_ERROR",
      [`${flag} 0 unfreezes; ${flag} 1 freezes the first`],
    );
  }
  return n;
}

export function parseTabUpdateFlags(args: string[]): TabUpdateFlags {
  const { parsed, spreadsheetId, tab, extra } = positionals(
    args,
    TABS_UPDATE_FLAGS,
    "sheets tabs update",
    UPDATE_USAGE,
  );
  const target = requireTabArg(tab, extra, UPDATE_USAGE);

  const given = [
    parsed.booleans.has("--first") && "--first",
    parsed.booleans.has("--last") && "--last",
    parsed.values["--before"] !== undefined && "--before",
    parsed.values["--after"] !== undefined && "--after",
  ].filter((f): f is string => !!f);
  if (given.length > 1) {
    throw new AxiError(`${given.join(" and ")} are mutually exclusive`, "VALIDATION_ERROR", [
      "Pick one position: --first, --last, --before <tab>, or --after <tab>",
    ]);
  }
  let placement: TabPlacement | undefined;
  if (parsed.booleans.has("--first")) placement = { kind: "first" };
  else if (parsed.booleans.has("--last")) placement = { kind: "last" };
  else if (parsed.values["--before"] !== undefined)
    placement = { kind: "before", anchor: parsed.values["--before"] };
  else if (parsed.values["--after"] !== undefined)
    placement = { kind: "after", anchor: parsed.values["--after"] };

  if (parsed.booleans.has("--hide") && parsed.booleans.has("--show")) {
    throw new AxiError("--hide and --show are mutually exclusive", "VALIDATION_ERROR", [
      "Pick one",
    ]);
  }
  const hidden = parsed.booleans.has("--hide")
    ? true
    : parsed.booleans.has("--show")
      ? false
      : undefined;

  let title: string | undefined;
  if (parsed.values["--title"] !== undefined) {
    title = parsed.values["--title"].trim();
    if (!title) {
      throw new AxiError("--title can't be empty", "VALIDATION_ERROR", [
        "Give the new title: --title 'Archive 2025'",
      ]);
    }
  }

  const flags: TabUpdateFlags = {
    spreadsheetId,
    tab: target,
    title,
    placement,
    hidden,
    frozenRows: freezeCount("--freeze-rows", parsed.values["--freeze-rows"]),
    frozenCols: freezeCount("--freeze-cols", parsed.values["--freeze-cols"]),
  };
  if (
    flags.title === undefined &&
    !flags.placement &&
    flags.hidden === undefined &&
    flags.frozenRows === undefined &&
    flags.frozenCols === undefined
  ) {
    throw new AxiError("Nothing to change — pass at least one property flag", "VALIDATION_ERROR", [
      "Properties: --title <title>, --first | --last | --before <tab> | --after <tab>, --hide | --show, --freeze-rows <n>, --freeze-cols <n>",
      `Usage: ${UPDATE_USAGE}`,
    ]);
  }
  return flags;
}

/**
 * The `index` to send for a move, or `"unchanged"` when the sheet already sits
 * where the placement describes. Upstream reads `index` in before-the-move
 * positions (observed; specs/commands/sheets-tabs.md § Upstream): `--first`
 * → 0, `--last` → the sheet count, `--before X` → X.index, `--after X` →
 * X.index + 1 — no adjustment for the direction of the move.
 */
export function resolveTabPlacement(
  sheets: SheetRow[],
  moving: SheetRow,
  placement: TabPlacement,
  notFound: (selector: string, what: string) => AxiError = (s, what) =>
    new AxiError(`${what} '${s}' not found`, "TAB_NOT_FOUND", []),
): number | "unchanged" {
  switch (placement.kind) {
    case "first":
      return moving.index === 0 ? "unchanged" : 0;
    case "last":
      return moving.index === sheets.length - 1 ? "unchanged" : sheets.length;
    case "before":
    case "after": {
      const flag = `--${placement.kind}`;
      const anchor = findSheet(sheets, placement.anchor);
      if (!anchor) throw notFound(placement.anchor, `${flag} tab`);
      if (anchor.gid === moving.gid) {
        throw new AxiError(
          `${flag} ${placement.anchor} names the tab being moved`,
          "VALIDATION_ERROR",
          ["Anchor on a different tab, or use --first / --last"],
        );
      }
      if (placement.kind === "before") {
        return moving.index === anchor.index - 1 ? "unchanged" : anchor.index;
      }
      return moving.index === anchor.index + 1 ? "unchanged" : anchor.index + 1;
    }
  }
}

export interface DesiredTabProps {
  title?: string;
  index?: number | "unchanged";
  hidden?: boolean;
  frozenRows?: number;
  frozenCols?: number;
}

export interface TabPropsDiff {
  properties: sheets_v4.Schema$SheetProperties;
  /** The `fields` mask, upstream names. */
  fields: string[];
  /** The properties written, output names, in a fixed order. */
  changed: string[];
}

/** Compare the desired properties with the read ones; only differences are sent. */
export function diffTabProps(current: SheetRow, desired: DesiredTabProps): TabPropsDiff {
  const properties: sheets_v4.Schema$SheetProperties = { sheetId: current.gid };
  const fields: string[] = [];
  const changed: string[] = [];
  if (desired.index !== undefined && desired.index !== "unchanged") {
    properties.index = desired.index;
    fields.push("index");
    changed.push("index");
  }
  if (desired.title !== undefined && desired.title !== current.title) {
    properties.title = desired.title;
    fields.push("title");
    changed.push("title");
  }
  if (desired.hidden !== undefined && desired.hidden !== current.hidden) {
    properties.hidden = desired.hidden;
    fields.push("hidden");
    changed.push("hidden");
  }
  if (desired.frozenRows !== undefined && desired.frozenRows !== (current.frozenRows ?? 0)) {
    (properties.gridProperties ??= {}).frozenRowCount = desired.frozenRows;
    fields.push("gridProperties.frozenRowCount");
    changed.push("frozen_rows");
  }
  if (desired.frozenCols !== undefined && desired.frozenCols !== (current.frozenCols ?? 0)) {
    (properties.gridProperties ??= {}).frozenColumnCount = desired.frozenCols;
    fields.push("gridProperties.frozenColumnCount");
    changed.push("frozen_cols");
  }
  return { properties, fields, changed };
}

/** Refuse what upstream would, before any call: collisions, freeze bounds, the last visible sheet. */
export function checkTabUpdate(
  sheets: SheetRow[],
  target: SheetRow,
  flags: Pick<TabUpdateFlags, "title" | "hidden" | "frozenRows" | "frozenCols" | "spreadsheetId">,
  account?: string,
): void {
  if (flags.title !== undefined) {
    const lower = flags.title.toLowerCase();
    const other = sheets.find((s) => s.gid !== target.gid && s.title.toLowerCase() === lower);
    if (other) {
      throw new AxiError(
        `A sheet titled '${other.title}' (gid ${other.gid}${other.kind === "grid" ? "" : `, ${other.kind}`}) already exists — titles are unique, ignoring case`,
        "VALIDATION_ERROR",
        ["Pick another --title", "Nothing was written"],
      );
    }
  }
  if (flags.frozenRows !== undefined || flags.frozenCols !== undefined) {
    if (target.kind !== "grid") {
      throw new AxiError(
        `'${target.title}' is a ${target.kind} sheet — it has no rows or columns to freeze`,
        "VALIDATION_ERROR",
        ["--freeze-rows / --freeze-cols apply to grid tabs only", "Nothing was written"],
      );
    }
    for (const [flag, n, alloc, noun] of [
      ["--freeze-rows", flags.frozenRows, target.rows ?? 0, "rows"],
      ["--freeze-cols", flags.frozenCols, target.cols ?? 0, "columns"],
    ] as const) {
      if (n !== undefined && n > 0 && n >= alloc) {
        throw new AxiError(
          `${flag} ${n} is at or past the tab's ${alloc} ${noun} — at least one must stay unfrozen`,
          "VALIDATION_ERROR",
          [`Use ${flag} ${Math.max(alloc - 1, 0)} or less`, "Nothing was written"],
        );
      }
    }
  }
  if (flags.hidden === true && !target.hidden) {
    const visible = sheets.filter((s) => !s.hidden);
    if (visible.length === 1 && visible[0].gid === target.gid) {
      throw lastVisible(sheets, target, "hidden", flags.spreadsheetId, account);
    }
  }
}

function lastVisible(
  sheets: SheetRow[],
  target: SheetRow,
  verb: "hidden" | "deleted",
  spreadsheetId: string,
  account?: string,
): AxiError {
  const hidden = sheets.filter((s) => s.hidden);
  const a = account ? acct(account) : "";
  return new AxiError(
    `'${target.title}' is the only visible sheet in spreadsheet '${spreadsheetId}' — it can't be ${verb} while every other sheet is hidden`,
    "LAST_VISIBLE_TAB",
    [
      `Hidden sheets: ${describeSheets(hidden)}`,
      hidden.length
        ? `Run \`gws-axi sheets tabs update ${spreadsheetId} ${hidden[0].gid} --show${a}\` to show one first`
        : `Add a tab first: \`gws-axi sheets add-tab ${spreadsheetId} --title <title>${a}\``,
      "Nothing was written",
    ],
  );
}

/** The flags that put back exactly what `changed` names, from the pre-read. */
export function undoFlags(before: SheetRow, sheets: SheetRow[], changed: string[]): string[] {
  const undo: string[] = [];
  if (changed.includes("index")) {
    const prev = sheets.find((s) => s.index === before.index - 1);
    undo.push(prev ? `--after ${shellArg(prev.title)}` : "--first");
  }
  if (changed.includes("title")) undo.push(`--title ${shellArg(before.title)}`);
  if (changed.includes("hidden")) undo.push(before.hidden ? "--hide" : "--show");
  if (changed.includes("frozen_rows")) undo.push(`--freeze-rows ${before.frozenRows ?? 0}`);
  if (changed.includes("frozen_cols")) undo.push(`--freeze-cols ${before.frozenCols ?? 0}`);
  return undo;
}

function upstreamMessage(err: unknown): string {
  const e = err as { message?: string; response?: { data?: { error?: { message?: string } } } };
  return e?.response?.data?.error?.message ?? e?.message ?? "";
}

/** A 400 from updateSheetProperties the local checks missed (the sheets changed since the read, or hidden rows). */
function translateTabUpdateError(
  err: unknown,
  ctx: { account: string; spreadsheetId: string; target: SheetRow; title?: string },
): AxiError {
  const message = upstreamMessage(err);
  if (/already exists/i.test(message)) {
    return new AxiError(
      `A sheet titled '${ctx.title}' already exists (titles are unique, ignoring case)`,
      "VALIDATION_ERROR",
      [
        `Run \`gws-axi sheets tabs ${ctx.spreadsheetId}\` to list every sheet`,
        "Nothing was written",
      ],
    );
  }
  if (/hide all the sheets/i.test(message)) {
    return new AxiError(
      `'${ctx.target.title}' is the only visible sheet — upstream refused to hide it`,
      "LAST_VISIBLE_TAB",
      [
        `Run \`gws-axi sheets tabs ${ctx.spreadsheetId}\` to see which sheets are hidden`,
        "Nothing was written",
      ],
    );
  }
  if (/freeze|not a grid|index is too high/i.test(message)) {
    return new AxiError(`Upstream refused the change: ${message}`, "VALIDATION_ERROR", [
      `Run \`gws-axi sheets tabs ${ctx.spreadsheetId}\` to see the current properties`,
      "Nothing was written",
    ]);
  }
  return translateWriteError(err, {
    account: ctx.account,
    operation: "sheets.spreadsheets.batchUpdate(updateSheetProperties)",
    spreadsheetId: ctx.spreadsheetId,
    range: `'${ctx.target.title}'`,
  });
}

export async function sheetsTabsUpdateCommand(account: string, args: string[]): Promise<string> {
  const flags = parseTabUpdateFlags(args);
  const api = await sheetsClient(account);
  const state = await fetchSheets(api, account, flags.spreadsheetId);
  const id = state.meta.id;
  const before = requireSheet(state, flags.tab);

  const index = flags.placement
    ? resolveTabPlacement(state.sheets, before, flags.placement, (s, what) =>
        sheetNotFound(state, s, what),
      )
    : undefined;
  checkTabUpdate(state.sheets, before, { ...flags, spreadsheetId: id }, account);
  const diff = diffTabProps(before, {
    title: flags.title,
    index,
    hidden: flags.hidden,
    frozenRows: flags.frozenRows,
    frozenCols: flags.frozenCols,
  });

  if (diff.fields.length === 0) {
    return joinBlocks(
      renderObject({ account, action: "unchanged" }),
      renderObject({ tab: sheetView(before) }),
      renderSheetList(state.sheets),
      renderHelp([
        "Already as requested; nothing was written",
        `Run \`gws-axi sheets tabs ${id}\` to list every sheet`,
      ]),
    );
  }

  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [
          { updateSheetProperties: { properties: diff.properties, fields: diff.fields.join(",") } },
        ],
      },
    });
  } catch (err) {
    throw translateTabUpdateError(err, {
      account,
      spreadsheetId: id,
      target: before,
      title: flags.title,
    });
  }

  const after = await fetchSheets(api, account, id);
  const tab = after.sheets.find((s) => s.gid === before.gid) ?? before;
  const help: string[] = [];
  if (tab.kind === "grid") {
    help.push(`Run \`gws-axi sheets read ${id} --tab ${shellArg(tab.title)}\` to read it`);
  }
  help.push(
    `Run \`gws-axi sheets tabs update ${id} ${tab.gid} ${undoFlags(before, state.sheets, diff.changed).join(" ")}${acct(account)}\` to undo`,
  );
  return joinBlocks(
    renderObject({ account, action: "updated", changed: diff.changed }),
    renderObject({ tab: sheetView(tab) }),
    renderSheetList(after.sheets),
    renderHelp(help),
  );
}

// ---------------------------------------------------------------------------
// sheets tabs delete

/** Errors-only, every grid sheet, tab-titled so cells can be qualified. */
const SCAN_FIELDS =
  "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(effectiveValue/errorValue))))";
const FORMULA_SCAN_FIELDS =
  "sheets(properties(title),data(startRow,startColumn,rowData(values(userEnteredValue/formulaValue))))";

/** A cell qualified by its tab: `Costs!D2`, `'Q4 plan'!D2`. */
export function qualifiedCell(title: string, a1: string): string {
  return `${displayTitle(title)}!${a1}`;
}

/** Every formula error in the spreadsheet, keyed by tab-qualified cell, skipping one sheet. */
export function collectSheetErrors(
  sheets: Array<{
    properties?: { sheetId?: number | null; title?: string | null } | null;
    data?: GridDataLike[] | null;
  }>,
  skipGid?: number,
): Map<string, CellError> {
  const out = new Map<string, CellError>();
  for (const s of sheets) {
    if (skipGid !== undefined && s.properties?.sheetId === skipGid) continue;
    const title = s.properties?.title ?? "";
    for (const [a1, err] of collectErrors(s.data)) {
      const cell = qualifiedCell(title, a1);
      out.set(cell, { ...err, cell });
    }
  }
  return out;
}

async function scanErrors(
  api: sheets_v4.Sheets,
  account: string,
  spreadsheetId: string,
  skipGid?: number,
): Promise<Map<string, CellError>> {
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      includeGridData: true,
      fields: SCAN_FIELDS,
    });
    return collectSheetErrors(res.data.sheets ?? [], skipGid);
  } catch (err) {
    throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.get(gridData)" });
  }
}

/** The tab-qualified cell split back into its tab title and A1. */
function splitCell(cell: string): { title: string; a1: string } {
  const { tabTitle, a1 } = splitQualifiedRange(cell);
  return { title: tabTitle ?? "", a1 };
}

/** Sheet order, then row-major within a sheet. */
export function sortQualified<T extends { cell: string }>(errors: T[], sheets: SheetRow[]): T[] {
  const order = new Map(sheets.map((s) => [s.title, s.index]));
  return [...errors].sort((x, y) => {
    const a = splitCell(x.cell);
    const b = splitCell(y.cell);
    return (order.get(a.title) ?? 0) - (order.get(b.title) ?? 0) || compareA1(a.a1, b.a1);
  });
}

/** The formulas of the first few error cells, best-effort, for their fix lines. */
async function errorFormulas(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  errors: CellError[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = errors.slice(0, 5).map((e) => {
    const { title, a1 } = splitCell(e.cell);
    return `${quoteTitle(title)}!${a1}`;
  });
  if (want.length === 0) return out;
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      ranges: want,
      includeGridData: true,
      fields: FORMULA_SCAN_FIELDS,
    });
    for (const s of res.data.sheets ?? []) {
      const title = s.properties?.title ?? "";
      for (const [a1, { cell }] of gridCells(s.data as GridDataLike[] | undefined)) {
        const f = cell.userEnteredValue?.formulaValue;
        if (f) out.set(qualifiedCell(title, a1), f);
      }
    }
  } catch {
    // Best-effort: a fix line without a formula still names the cell.
  }
  return out;
}

/** One fix line per error (up to 5), in the write side's words, with the cell tab-qualified. */
export function deleteFixLines(
  errors: CellError[],
  formulas: Map<string, string>,
  ctx: { spreadsheetId: string; account: string },
): string[] {
  return errors.slice(0, 5).map((err) => {
    const { title, a1 } = splitCell(err.cell);
    const local = new Map<string, string>();
    const f = formulas.get(err.cell);
    if (f) local.set(a1, f);
    const [line] = fixLines([{ ...err, cell: a1 }], local, {
      spreadsheetId: ctx.spreadsheetId,
      tabTitle: title,
      account: ctx.account,
    });
    return line.replace(/^Fix \S+/, `Fix ${err.cell}`);
  });
}

/** Populated cells (display text) in a grid tab — the delete's record of what went. */
export function countPopulated(values: unknown[][] | null | undefined): number {
  let n = 0;
  for (const row of values ?? []) for (const v of row ?? []) if (v !== "" && v != null) n++;
  return n;
}

const ERRORS_SCHEMA: FieldDef[] = [
  field("cell"),
  field("error"),
  field("message"),
  field("written"),
];

export async function sheetsTabsDeleteCommand(account: string, args: string[]): Promise<string> {
  const {
    spreadsheetId,
    tab: tabArg,
    extra,
  } = positionals(args, TABS_DELETE_FLAGS, "sheets tabs delete", DELETE_USAGE);
  const selector = requireTabArg(tabArg, extra, DELETE_USAGE);
  const api = await sheetsClient(account);
  const state = await fetchSheets(api, account, spreadsheetId);
  const id = state.meta.id;
  const target = requireSheet(state, selector);

  if (state.sheets.length === 1) {
    throw new AxiError(
      `'${target.title}' is the only sheet in spreadsheet '${id}' — it can't be deleted`,
      "LAST_TAB",
      [
        `Run \`gws-axi sheets clear ${id} --tab ${shellArg(target.title)} --all${acct(account)}\` to empty it instead`,
        `Run \`gws-axi drive trash ${id}${acct(account)}\` to trash the whole spreadsheet`,
      ],
    );
  }
  if (!target.hidden && state.sheets.every((s) => s.gid === target.gid || s.hidden)) {
    throw lastVisible(state.sheets, target, "deleted", id, account);
  }

  // What goes: the populated-cell count, before the delete.
  let cells: number | undefined;
  if (target.kind === "grid") {
    try {
      const res = await api.spreadsheets.values.get({
        spreadsheetId: id,
        range: quoteTitle(target.title),
      });
      cells = countPopulated(res.data.values);
    } catch (err) {
      throw translateGoogleError(err, { account, operation: "sheets.spreadsheets.values.get" });
    }
  }

  // What breaks: every formula error in the spreadsheet, before and after.
  const allocation = state.sheets.reduce((n, s) => n + (s.rows ?? 0) * (s.cols ?? 0), 0);
  const scan = allocation <= ERROR_SCAN_BOUND;
  const before = scan ? await scanErrors(api, account, id, target.gid) : undefined;

  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ deleteSheet: { sheetId: target.gid } }] },
    });
  } catch (err) {
    const message = upstreamMessage(err);
    if (/remove all the (visible )?sheets/i.test(message)) {
      throw /visible/i.test(message)
        ? lastVisible(state.sheets, target, "deleted", id, account)
        : new AxiError(
            `'${target.title}' is the only sheet — upstream refused to delete it`,
            "LAST_TAB",
            [`Run \`gws-axi sheets tabs ${id}\` to list every sheet`],
          );
    }
    throw translateWriteError(err, {
      account,
      operation: "sheets.spreadsheets.batchUpdate(deleteSheet)",
      spreadsheetId: id,
      range: `'${target.title}'`,
    });
  }

  const after = await fetchSheets(api, account, id);
  let errors: ErrorDiff | undefined;
  let formulas = new Map<string, string>();
  if (before) {
    try {
      errors = diffErrors(before, await scanErrors(api, account, id), new Set());
      errors.errors = sortQualified(errors.errors, after.sheets);
      formulas = await errorFormulas(api, id, errors.errors);
    } catch {
      // The delete happened; a failed read-back must not report it as failed.
      errors = undefined;
    }
  }

  const deleted: Record<string, unknown> = {
    gid: target.gid,
    title: target.title,
    kind: target.kind,
  };
  if (cells !== undefined) deleted.cells = cells;

  const head: Record<string, unknown> = {
    ...errorHeader(
      errors,
      !scan
        ? `skipped (spreadsheet is ${allocation} cells)`
        : errors
          ? undefined
          : "failed (the read-back after the delete did not complete)",
    ),
  };
  const blocks: string[] = [];
  if (errors && errors.errors.length > 0) {
    blocks.push(
      renderList(
        "errors",
        errors.errors.slice(0, WRITTEN_CAP).map((e) => ({ ...e, written: "no" })),
        ERRORS_SCHEMA,
      ),
    );
  }
  const help: string[] = [];
  if (errors && errors.errors.length > 0) {
    const n = errors.errors.length;
    help.push(`${n} formula error${n === 1 ? "" : "s"} after this delete — see errors[]`);
    help.push(...deleteFixLines(errors.errors, formulas, { spreadsheetId: id, account }));
  }
  if (!scan) {
    help.push(
      `Formula errors on other tabs were not checked (the spreadsheet is over ${ERROR_SCAN_BOUND.toLocaleString("en-US")} cells); run \`gws-axi sheets read ${id} --tab <title> --full\` to see a tab's errors`,
    );
  }
  help.push(
    `The content is out of the live spreadsheet but stays in version history: \`gws-axi drive revisions ${id}\``,
    `Run \`gws-axi sheets tabs ${id}\` to list what remains`,
  );
  return joinBlocks(
    renderObject({ account, action: "deleted" }),
    renderObject({ deleted }),
    Object.keys(head).length ? renderObject(head) : "",
    ...blocks,
    renderSheetList(after.sheets),
    renderHelp(help),
  );
}
