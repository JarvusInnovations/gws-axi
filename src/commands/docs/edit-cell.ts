import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { docsClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import { renderCellMarkdown } from "./markdown.js";
import { cellFillRequests, parseCellMarkdown } from "./md-to-doc.js";
import { type TabInfo, describeTabs, flattenTabInfos, renderTabListing } from "./tabs.js";
import { batch } from "./write.js";

/**
 * `docs edit-cell` (specs/commands/docs-edit-cell.md): replace one table
 * cell's content, addressed by its row's label, and nothing else — the
 * table's widths, borders and other cells stay as the humans left them.
 */

export const EDIT_CELL_HELP = `usage: gws-axi docs edit-cell <documentId> --row <label | #n> --text <markdown> [--tab <id>] [--table <n>] [--col <n>] [flags]
args[1]:
  <documentId>         The Doc
flags[6]:
  --row <label | #n>   REQUIRED. The row whose first cell reads <label> (emphasis
                       ignored: **State** matches State), or #n for the n-th row
  --text <markdown>    REQUIRED. The cell's new content — styles, links, <br> lines,
                       "- " / "1. " / "- [ ] " items; "" empties the cell
  --tab <id>           The tab (id as \`docs tabs\` lists it). Omit on a single-tab Doc
  --table <n>          Which table in the tab, 1-based (default: 1)
  --col <n>            Which cell in the row, 1-based (default: 2, the value column)
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi docs edit-cell 1BxAbc... --row "State" --text "**Refining** (round 4)" --account you@example.com
  gws-axi docs edit-cell 1BxAbc... --row "Inputs" --text "- [Brief](https://…)<br>- [Transcript](https://…)" --tab t.k3j2 --account you@example.com
  gws-axi docs edit-cell 1BxAbc... --row "#3" --col 3 --text "done" --account you@example.com
notes:
  Touches one cell: the table's column widths, borders and every other cell are
  left alone. The new content gets the styles its Markdown asks for (write
  **bold** to keep bold). Identical text is action: unchanged. The response
  carries the cell's previous content as Markdown and an undo line. Refused if
  the Doc changed since it was read.
`;

export const EDIT_CELL_FLAGS: FlagSpec = {
  value: ["--row", "--text", "--tab", "--table", "--col"],
  boolean: [],
};

export interface EditCellFlags {
  documentId: string;
  row: string;
  text: string;
  tab?: string;
  table: number;
  col: number;
}

const USAGE =
  "gws-axi docs edit-cell <documentId> --row <label | #n> --text <markdown> [--tab <id>]";

function positiveInt(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new AxiError(`${flag} expects a positive whole number, got: ${raw}`, "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  return n;
}

export function parseEditCellFlags(args: string[]): EditCellFlags {
  const parsed = parseArgs(args, EDIT_CELL_FLAGS, "docs edit-cell");
  const documentId = parsed.positionals[0];
  if (!documentId) {
    throw new AxiError("Missing documentId argument", "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
      "The documentId is the portion of the URL after /d/ and before /edit",
    ]);
  }
  if (parsed.positionals.length > 1) {
    throw new AxiError(`Unexpected argument: ${parsed.positionals[1]}`, "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  const row = parsed.values["--row"];
  const text = parsed.values["--text"];
  if (row === undefined || !row.trim() || text === undefined) {
    throw new AxiError(
      `Missing ${row === undefined || !row.trim() ? "--row" : "--text"}`,
      "VALIDATION_ERROR",
      [`Usage: ${USAGE}`, 'Pass --text "" to empty the cell'],
    );
  }
  return {
    documentId,
    row: row.trim(),
    text,
    tab: parsed.values["--tab"],
    table: positiveInt("--table", parsed.values["--table"], 1),
    col: positiveInt("--col", parsed.values["--col"], 2),
  };
}

// ---------------------------------------------------------------------------
// Locating the cell

/** A cell's text as a human reads it: paragraphs on lines, hard breaks as lines. */
export function cellPlainText(cell: docs_v1.Schema$TableCell): string {
  return (cell.content ?? [])
    .map((el) =>
      (el.paragraph?.elements ?? [])
        .map((pe) => pe.textRun?.content ?? "")
        .join("")
        .replace(/\n$/, ""),
    )
    .join("\n")
    .split("\u000b")
    .join("\n")
    .trim();
}

export interface RowMatch {
  /** 1-based row number. */
  row: number;
  label: string;
}

/**
 * Which row `--row` names: `#n` is the n-th row; otherwise the rows whose
 * first cell's text equals the label (emphasis is not text, so `**State**`
 * matches `State`). Pure, so the ambiguity rules are unit-testable.
 */
export function resolveRow(
  table: docs_v1.Schema$Table,
  requested: string,
): { match: RowMatch } | { error: "not_found" | "ambiguous"; candidates: RowMatch[] } {
  const rows = table.tableRows ?? [];
  const labels: RowMatch[] = rows.map((r, i) => ({
    row: i + 1,
    label: r.tableCells?.[0] ? cellPlainText(r.tableCells[0]) : "",
  }));
  const numbered = /^#(\d+)$/.exec(requested);
  if (numbered) {
    const n = Number(numbered[1]);
    const match = labels[n - 1];
    return match ? { match } : { error: "not_found", candidates: labels };
  }
  const hits = labels.filter((l) => l.label === requested);
  if (hits.length === 1) return { match: hits[0] };
  return {
    error: hits.length ? "ambiguous" : "not_found",
    candidates: hits.length ? hits : labels,
  };
}

// ---------------------------------------------------------------------------

async function fetchDocument(
  api: docs_v1.Docs,
  account: string,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  try {
    const res = await api.documents.get({ documentId, includeTabsContent: true });
    return res.data;
  } catch (err) {
    const translated = translateGoogleError(err, { account, operation: "docs.documents.get" });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Document '${documentId}' not found (or ${account} doesn't have access)`,
        "DOCUMENT_NOT_FOUND",
        [
          "Verify the document ID is correct (the portion of the URL after /d/)",
          `Confirm ${account} has edit access to the document`,
        ],
      );
    }
    if (translated.code === "OPERATION_NOT_SUPPORTED") {
      throw new AxiError(
        `'${documentId}' is not a native Google Doc — the Docs API can't edit it`,
        "NON_NATIVE_DOCUMENT",
        ["Open it in Drive and use File → Save as Google Docs, then edit the new Doc"],
      );
    }
    throw translated;
  }
}

function chooseTab(
  doc: docs_v1.Schema$Document,
  requested: string | undefined,
  account: string,
): { tab: TabInfo; documentTab: docs_v1.Schema$DocumentTab } {
  const infos = flattenTabInfos(doc.tabs ?? undefined);
  const byId = new Map<string, docs_v1.Schema$Tab>();
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined) => {
    for (const t of tabs ?? []) {
      byId.set(t.tabProperties?.tabId ?? "", t);
      walk(t.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);
  let tab: TabInfo | undefined;
  if (requested) {
    tab = infos.find((t) => t.id === requested);
    if (!tab) {
      throw new AxiError(
        `Tab '${requested}' not found in document '${doc.documentId}'`,
        "TAB_NOT_FOUND",
        [
          `Available tabs: ${describeTabs(infos)}`,
          `Run \`gws-axi docs tabs ${doc.documentId}\` to see the tabs list`,
        ],
      );
    }
  } else if (infos.length === 1) {
    tab = infos[0];
  } else {
    throw new AxiError(
      `Document '${doc.documentId}' has ${infos.length} tabs — pass --tab <id> to choose one`,
      "TAB_REQUIRED",
      [
        renderTabListing(infos),
        `Run \`gws-axi docs edit-cell ${doc.documentId} --row <label> --text <markdown> --tab <id> --account ${account}\` with one of the ids above`,
        "Nothing was written",
      ],
    );
  }
  return { tab, documentTab: byId.get(tab.id)?.documentTab ?? {} };
}

export async function docsEditCellCommand(account: string, args: string[]): Promise<string> {
  const flags = parseEditCellFlags(args);
  // Convert first: a refusal costs no read.
  const parsed = parseCellMarkdown(flags.text);

  const api = await docsClient(account);
  const doc = await fetchDocument(api, account, flags.documentId);
  const documentId = doc.documentId ?? flags.documentId;
  const revisionBefore = doc.revisionId ?? "";
  const { tab, documentTab } = chooseTab(doc, flags.tab, account);

  const tables = (documentTab.body?.content ?? []).filter((el) => el.table);
  const element = tables[flags.table - 1];
  if (!element?.table) {
    throw new AxiError(
      tables.length
        ? `Tab ${tab.id} has ${tables.length} table${tables.length === 1 ? "" : "s"}; there is no table ${flags.table}`
        : `Tab ${tab.id} has no table`,
      "TABLE_NOT_FOUND",
      tables.length
        ? [`Pass --table 1${tables.length > 1 ? `…${tables.length}` : ""}`]
        : [`Run \`gws-axi docs read ${documentId} --tab ${tab.id}\` to see the tab`],
    );
  }
  const table = element.table;
  const resolved = resolveRow(table, flags.row);
  if ("error" in resolved) {
    if (resolved.error === "ambiguous") {
      throw new AxiError(
        `${resolved.candidates.length} rows read ${JSON.stringify(flags.row)} — say which with --row "#<n>"`,
        "ROW_AMBIGUOUS",
        [
          renderList("rows", resolved.candidates as unknown as Array<Record<string, unknown>>, [
            field("row"),
            field("label"),
          ]),
          "Nothing was written",
        ],
      );
    }
    throw new AxiError(
      `No row of table ${flags.table} in tab ${tab.id} reads ${JSON.stringify(flags.row)}`,
      "ROW_NOT_FOUND",
      [
        renderList("rows", resolved.candidates as unknown as Array<Record<string, unknown>>, [
          field("row"),
          field("label"),
        ]),
        'Pass one of the labels above, or --row "#<n>" for a row number',
      ],
    );
  }
  const { match } = resolved;
  const rowCells = table.tableRows?.[match.row - 1]?.tableCells ?? [];
  const cell = rowCells[flags.col - 1];
  if (!cell) {
    throw new AxiError(
      `Row ${match.row} has ${rowCells.length} cell${rowCells.length === 1 ? "" : "s"}; there is no column ${flags.col}`,
      "VALIDATION_ERROR",
      [`Pass --col 1…${rowCells.length}`],
    );
  }

  const before = renderCellMarkdown(cell, documentTab.lists ?? undefined);
  const newText = parsed.cell.paragraphs
    .map((p) => p.inline.runs.map((r) => r.text).join(""))
    .join("\n")
    .split("\u000b")
    .join("\n")
    .trim();
  const document = {
    id: documentId,
    title: doc.title ?? "",
    tab: tab.id,
    tab_title: tab.title,
  };
  const tableInfo = {
    index: flags.table,
    rows: table.tableRows?.length ?? 0,
    columns: table.columns ?? rowCells.length,
  };
  const cellInfo = {
    row: match.row,
    col: flags.col,
    label: match.label,
    before,
    after: flags.text,
  };

  if (cellPlainText(cell) === newText) {
    return joinBlocks(
      renderObject({ account, action: "unchanged" }),
      renderObject({ document: { ...document, revision_id: revisionBefore } }),
      renderObject({ table: tableInfo, cell: cellInfo }),
      renderHelp(["The cell already reads this; nothing was written (styles are not compared)"]),
    );
  }

  const start = cell.content?.[0]?.startIndex ?? 0;
  const end = cell.endIndex ?? start + 1;
  const requests: docs_v1.Schema$Request[] = [];
  // Clear the cell down to its final paragraph, drop any bullet it had, refill.
  if (end - 1 > start) {
    requests.push({
      deleteContentRange: { range: { startIndex: start, endIndex: end - 1, tabId: tab.id } },
    });
  }
  requests.push({
    deleteParagraphBullets: { range: { startIndex: start, endIndex: start + 1, tabId: tab.id } },
  });
  requests.push(...cellFillRequests(parsed.cell, start, tab.id));
  const reply = await batch(api, account, documentId, requests, revisionBefore);
  const revisionAfter = reply.writeControl?.requiredRevisionId ?? revisionBefore;

  const blocks = [
    renderObject({ account, action: "edited" }),
    renderObject({ document: { ...document, revision_id: revisionAfter } }),
    renderObject({ table: tableInfo, cell: cellInfo }),
    parsed.lossy.length
      ? renderList("lossy", parsed.lossy as unknown as Array<Record<string, unknown>>, [
          field("construct"),
          field("count"),
          field("handling"),
        ])
      : renderObject({ lossy: "none" }),
    renderHelp([
      `Verify: \`gws-axi docs read ${documentId} --tab ${tab.id}\``,
      `Compare with the version before: \`gws-axi docs diff ${documentId} ${revisionBefore}\``,
      `Undo: \`gws-axi docs edit-cell ${documentId} --row ${JSON.stringify(flags.row)} --text ${JSON.stringify(before)}${flags.table !== 1 ? ` --table ${flags.table}` : ""}${flags.col !== 2 ? ` --col ${flags.col}` : ""} --tab ${tab.id} --account ${account}\``,
    ]),
  ];
  return joinBlocks(...blocks);
}
