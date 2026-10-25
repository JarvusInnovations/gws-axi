import { AxiError } from "axi-sdk-js";
import { sheetsClient } from "../../google/client.js";
import {
  type GvizCell,
  type GvizColumn,
  type GvizIssue,
  type GvizRequest,
  type GvizResponse,
  fetchGvizCsv,
  runGvizQuery,
} from "../../google/gviz.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type ExportOutcome, parseExportRequest, writeExport } from "../../util/export.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import {
  columnLetter,
  displayTitle,
  fetchMeta,
  requireTab,
  shellArg,
  spreadsheetNotFound,
} from "./shared.js";

/**
 * `sheets query <id> "<tq>"` — Google's Visualization Query Language against
 * one tab, over the gviz/tq endpoint (specs/commands/sheets-query.md). The
 * query is Google's to parse: passed through verbatim, never rewritten or
 * limit-injected; the preview cap is applied to the result.
 */

export const QUERY_FLAGS: FlagSpec = {
  value: ["--tab", "--headers", "--limit"],
  optional: ["--json-out", "--csv-out"],
  hints: {
    "--max-rows": "The preview cap is --limit <n> here",
    "--range": "A query reads the whole tab; narrow it with `where` or `select` in the query",
    "--out": "Name the format: --csv-out[=<path>] or --json-out[=<path>]",
  },
};

export const QUERY_HELP = `usage: gws-axi sheets query <spreadsheetId> "<query>" [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <query>              Google's Visualization Query Language, one argument, the
                       language =QUERY() evaluates: select, where, group by,
                       pivot, order by, limit, offset, label, format. Columns
                       are letters (select A, sum(C) where D = 'open' group by A)
flags[6]:
  --tab <name|gid>     The tab to query. Required on a multi-tab spreadsheet
  --headers <n>        Header rows on top of the tab. Default: 1 when the top row
                       is frozen, else Google detects; 0 for none
  --limit <n>          Rows in the preview (default 50). Not added to the query:
                       a \`limit\` clause in the query is separate
  --json-out[=<path>]  Write the full result as JSON {query, columns, rows}
                       (default path: a 0600 file in the OS temp dir)
  --csv-out[=<path>]   Write Google's own CSV of the full result
  --account <email>    Account override when 2+ are configured
examples:
  gws-axi sheets query 1AbC... "select A, sum(C) where D = 'open' group by A" --tab Costs
  gws-axi sheets query 1AbC... "select * where B > 100 order by B desc" --tab Costs --limit 10
  gws-axi sheets query 1AbC... "select A, B" --tab Costs --headers 0
  gws-axi sheets query 1AbC... "select *" --tab Costs --csv-out=./costs.csv
output:
  The spreadsheet{id,title,tab,gid} header, the query, rows: (<n>, or <shown>
  of <total>), columns: <id>:<label>(<type>) for every result column, and
  rows[N]{…} named by the column labels. Cells show the sheet's formatted
  value where Google sends one. With an export flag: wrote: <path> (<rows>
  rows, <cols> cols) and a jq/head line.
notes:
  Read-only: the query runs on Google's side and nothing in the spreadsheet
  changes. There are no joins; one tab per query. A wrong query is
  QUERY_ERROR with Google's own message. The =QUERY() formula with the same
  query is in help[], for keeping the result in the sheet.
`;

const DEFAULT_LIMIT = 50;
const CELL_CAP = 200;
const REFERENCE = "https://developers.google.com/chart/interactive/docs/querylanguage";

interface QueryFlags {
  spreadsheetId: string;
  query: string;
  tab?: string;
  headers?: number;
  limit: number;
}

function nonNegative(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n)) {
    throw new AxiError(
      `${flag} expects a whole number (0 or more), got: ${raw}`,
      "VALIDATION_ERROR",
      ["Run `gws-axi sheets query --help` for usage"],
    );
  }
  return n;
}

function parseFlags(args: string[]) {
  const parsed = parseArgs(args, QUERY_FLAGS, "sheets query");
  const [spreadsheetId, query, ...extra] = parsed.positionals;
  if (!spreadsheetId || query === undefined) {
    throw new AxiError(
      !spreadsheetId ? "Missing spreadsheetId argument" : "Missing the query argument",
      "VALIDATION_ERROR",
      ['Usage: gws-axi sheets query <spreadsheetId> "<query>" [--tab <name|gid>]'],
    );
  }
  if (query.trim() === "") {
    throw new AxiError("The query is empty", "VALIDATION_ERROR", [
      `Pass a query, e.g. gws-axi sheets query ${spreadsheetId} "select *"`,
    ]);
  }
  if (extra.length) {
    throw new AxiError(
      `Unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}`,
      "VALIDATION_ERROR",
      ['Quote the whole query as one argument: "select A, B where C > 1"'],
    );
  }
  const flags: QueryFlags = {
    spreadsheetId,
    query,
    tab: parsed.values["--tab"],
    headers: nonNegative("--headers", parsed.values["--headers"]),
    limit: nonNegative("--limit", parsed.values["--limit"]) ?? DEFAULT_LIMIT,
  };
  return { flags, exportReq: parseExportRequest(parsed) };
}

// ---------------------------------------------------------------------------
// Pure rendering (unit-tested)

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `Date(2026,0,15)` / `Date(2026,9,25,12,30,4)` — the month is zero-based. */
function parseGvizDate(v: unknown): number[] | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^Date\(([\d,\s-]+)\)$/.exec(v);
  if (!m) return undefined;
  const parts = m[1].split(",").map((p) => Number(p.trim()));
  return parts.some((p) => !Number.isFinite(p)) ? undefined : parts;
}

/** A date, datetime or time of day as ISO text; undefined when `v` is not one. */
export function isoValue(v: unknown, type: string, sep = "T"): string | undefined {
  if (type === "timeofday" && Array.isArray(v)) {
    const [h = 0, mi = 0, s = 0] = v as number[];
    return `${pad(h)}:${pad(mi)}:${pad(s)}`;
  }
  if (type !== "date" && type !== "datetime") return undefined;
  const parts = parseGvizDate(v);
  if (!parts) return undefined;
  const [y, mo = 0, d = 1, h = 0, mi = 0, s = 0] = parts;
  const date = `${pad(y, 4)}-${pad(mo + 1)}-${pad(d)}`;
  return type === "date" ? date : `${date}${sep}${pad(h)}:${pad(mi)}:${pad(s)}`;
}

/** What the preview shows for one cell: `f` when sent, else `v` rendered. */
export function displayCell(cell: GvizCell, col: GvizColumn): string {
  if (!cell || cell.v === null || cell.v === undefined) return cell?.f ?? "";
  if (typeof cell.f === "string") return cell.f;
  const iso = isoValue(cell.v, col.type, " ");
  if (iso !== undefined) return iso;
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return String(cell.v);
}

/** The raw value for the JSON file: `v`, with dates as ISO strings. */
export function rawCell(cell: GvizCell, col: GvizColumn): unknown {
  if (!cell || cell.v === undefined) return null;
  return isoValue(cell.v, col.type) ?? cell.v;
}

function truncate(s: string): string {
  return s.length <= CELL_CAP ? s : `${s.slice(0, CELL_CAP - 1)}…`;
}

/** Preview column names: the label, else the id; a repeated name gets its id. */
export function columnNames(cols: GvizColumn[]): string[] {
  const base = cols.map((c) => c.label.trim() || c.id);
  const counts = new Map<string, number>();
  for (const n of base) counts.set(n, (counts.get(n) ?? 0) + 1);
  const used = new Set<string>();
  return base.map((n, i) => {
    let name = (counts.get(n) ?? 0) > 1 ? `${n} (${cols[i].id})` : n;
    while (used.has(name)) name = `${name}'`;
    used.add(name);
    return name;
  });
}

export function columnsLine(cols: GvizColumn[]): string {
  return cols.map((c) => `${c.id}:${c.label}(${c.type})`).join(", ");
}

export function rowsLine(shown: number, total: number, truncated: boolean): string | number {
  if (truncated) return `${shown} of ${total} (Google truncated the result)`;
  return shown < total ? `${shown} of ${total}` : total;
}

/** The `=QUERY()` that keeps this result in the sheet. */
export function queryFormula(
  tab: { title: string; cols: number },
  query: string,
  headers: number | undefined,
): string {
  const lastCol = columnLetter(Math.max(tab.cols, 1) - 1);
  const range = `${displayTitle(tab.title)}!A:${lastCol}`;
  const q = `"${query.replace(/"/g, '""')}"`;
  return `=QUERY(${range}, ${q}${headers !== undefined ? `, ${headers}` : ""})`;
}

/** Google's text for an error block, folded onto one line. */
function issueText(issue: GvizIssue | undefined): string {
  const text = issue?.detailed_message || issue?.message || issue?.reason || "unknown error";
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The query with `»` at the position Google names (`line L, column C`). An
 * error's help[] renders inline, so a caret on the next line could not line up.
 */
export function markedQuery(query: string, message: string): string {
  const flat = (q: string) => q.replace(/\n/g, " ");
  const m = /line (\d+), column (\d+)/.exec(message);
  if (!m) return `query: ${flat(query)}`;
  const lines = query.split("\n");
  const line = Number(m[1]);
  const col = Number(m[2]);
  const text = lines[line - 1];
  if (text === undefined || col < 1 || col > text.length + 1) return `query: ${flat(query)}`;
  lines[line - 1] = `${text.slice(0, col - 1)}»${text.slice(col - 1)}`;
  return `query (» marks line ${line}, column ${col}): ${flat(lines.join("\n"))}`;
}

export function queryError(res: GvizResponse, query: string, account: string): AxiError {
  const issue = res.errors?.[0];
  const reason = issue?.reason ?? "unknown";
  const text = issueText(issue);
  if (reason === "access_denied") {
    return new AxiError(`The query endpoint denied access: ${text}`, "ACCESS_DENIED", [
      `Confirm ${account} can open the spreadsheet (view access is enough)`,
      `Run \`gws-axi auth login --account ${account}\` if the account's sign-in has lapsed`,
    ]);
  }
  return new AxiError(
    reason === "invalid_query" ? text : `Query failed (${reason}): ${text}`,
    "QUERY_ERROR",
    [
      markedQuery(query, text),
      "Columns are letters (A, B, …), strings take single quotes ('open'), dates are date 'YYYY-MM-DD'",
      `Query language reference: ${REFERENCE}`,
    ],
  );
}

// ---------------------------------------------------------------------------

export async function sheetsQueryCommand(account: string, args: string[]): Promise<string> {
  const { flags, exportReq } = parseFlags(args);
  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId);
  const tab = requireTab(
    meta,
    flags.tab,
    (t) => `gws-axi sheets query ${meta.id} ${shellArg(flags.query)} --tab ${shellArg(t)}`,
    { read: true },
  );
  // A single frozen top row is a declared header — `sheets read`'s rule.
  const headers = flags.headers ?? (tab.frozenRows === 1 ? 1 : undefined);

  const req: GvizRequest = { spreadsheetId: meta.id, gid: tab.gid, query: flags.query, headers };
  let res: GvizResponse;
  try {
    res = await runGvizQuery(account, req);
  } catch (err) {
    if (err instanceof AxiError && err.code === "NOT_FOUND") {
      throw spreadsheetNotFound(flags.spreadsheetId, account);
    }
    throw err;
  }
  if (res.status === "error") throw queryError(res, flags.query, account);

  const cols = res.table?.cols ?? [];
  const rows = res.table?.rows ?? [];
  const warnings = res.warnings ?? [];
  const truncated = warnings.some((w) => w.reason === "data_truncated");
  const shown = Math.min(flags.limit, rows.length);

  // --- export (before rendering, so its outcome lands in the header) ---
  let outcome: ExportOutcome | undefined;
  if (exportReq) {
    if (exportReq.format === "json") {
      const payload = {
        query: flags.query,
        columns: cols.map((c) => ({ id: c.id, label: c.label, type: c.type })),
        rows: rows.map((r) => cols.map((c, j) => rawCell(r.c?.[j] ?? null, c))),
      };
      outcome = writeExport(exportReq, "query", `${JSON.stringify(payload)}\n`, {
        rows: rows.length,
        cols: cols.length,
      });
    } else {
      let csv: Awaited<ReturnType<typeof fetchGvizCsv>> | undefined;
      let failure: string | undefined;
      try {
        csv = await fetchGvizCsv(account, req);
        if ("error" in csv) failure = issueText(csv.error.errors?.[0]);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      outcome =
        csv && "csv" in csv
          ? writeExport(exportReq, "query", csv.csv, { rows: rows.length, cols: cols.length })
          : {
              ok: false,
              path: "",
              error: {
                code: "EXPORT_WRITE_FAILED",
                message: `Google's CSV of this query failed: ${failure}`,
                path: "",
              },
              helpLine:
                "Nothing was written; --json-out writes the same result from the response shown here",
            };
    }
  }

  // --- render ---
  const blocks: string[] = [renderObject({ account })];
  blocks.push(
    renderObject({ spreadsheet: { id: meta.id, title: meta.title, tab: tab.title, gid: tab.gid } }),
  );
  const head: Record<string, unknown> = { query: flags.query };
  if (rows.length > 0) head.rows = rowsLine(shown, rows.length, truncated);
  head.columns = columnsLine(cols);
  if (outcome?.ok) head.wrote = outcome.wrote;
  blocks.push(renderObject(head));
  if (outcome && !outcome.ok) blocks.push(renderObject({ export_error: outcome.error }));

  if (rows.length === 0) {
    blocks.push(
      renderObject({
        rows: truncated ? "no rows (Google truncated the result)" : "no rows matched",
      }),
    );
  } else if (shown > 0) {
    const names = columnNames(cols);
    const preview = rows
      .slice(0, shown)
      .map((r) =>
        Object.fromEntries(
          names.map((n, j) => [n, truncate(displayCell(r.c?.[j] ?? null, cols[j]))]),
        ),
      );
    blocks.push(
      renderList(
        "rows",
        preview,
        names.map((n) => field(n)),
      ),
    );
  }

  // --- help[] ---
  const help: string[] = [];
  if (truncated) {
    help.push(
      "Google truncated the result: narrow it with `where`, or page it with `limit`/`offset` in the query",
    );
  }
  for (const w of warnings.filter((w) => w.reason !== "data_truncated")) {
    help.push(`Google warned (${w.reason ?? "warning"}): ${issueText(w)}`);
  }
  help.push(
    `Columns are letters in the query (A, B, …); run \`gws-axi sheets read ${meta.id} --tab ${shellArg(tab.title)} --range 1:1 --raw\` to see what each letter holds`,
  );
  if (outcome) help.push(outcome.helpLine);
  else help.push("Save the full result: --csv-out or --json-out");
  help.push(`The same query inside the sheet: ${queryFormula(tab, flags.query, headers)}`);
  blocks.push(renderHelp(help));

  if (outcome && !outcome.ok) process.exitCode = 1;
  return joinBlocks(...blocks);
}
