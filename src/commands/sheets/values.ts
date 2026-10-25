import { AxiError } from "axi-sdk-js";
import { cellA1, parseA1, splitQualifiedRange } from "./shared.js";

/**
 * The value block (specs/commands/sheets-write.md § The value block): CSV/TSV
 * or a JSON grid, chosen by flag, never by sniffing. Pure — no Google client.
 */

/** One input cell: a string in the input mode, a typed JSON value, or `null` (skip). */
export type InputValue = string | number | boolean | null;
export type Block = InputValue[][];

/**
 * RFC 4180: `sep`-separated fields, `"…"` quoting with `""` for a literal
 * quote, newlines inside quotes, `\r\n` or `\n` rows. A wholly blank line is an
 * empty row — nothing written in it — not a row with one empty field that
 * would clear column A. An unterminated quote is refused with the line it
 * opened on.
 */
export function parseCsv(text: string, sep = ","): string[][] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let fieldText = "";
  let inQuotes = false;
  let quoteLine = 0;
  let line = 1;
  let rowHasContent = false;
  let i = 0;

  const endRow = () => {
    if (rowHasContent || row.length > 0 || fieldText !== "") {
      row.push(fieldText);
      rows.push(row);
    } else {
      rows.push([]);
    }
    row = [];
    fieldText = "";
    rowHasContent = false;
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          fieldText += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === "\n") line++;
      fieldText += ch;
      i++;
      continue;
    }
    if (ch === '"' && fieldText === "") {
      inQuotes = true;
      quoteLine = line;
      rowHasContent = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(fieldText);
      fieldText = "";
      rowHasContent = true;
      i++;
      continue;
    }
    if (ch === "\r" && src[i + 1] === "\n") {
      endRow();
      line++;
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRow();
      line++;
      i++;
      continue;
    }
    fieldText += ch;
    i++;
  }
  if (inQuotes) {
    throw new AxiError(
      `Malformed ${sep === "\t" ? "TSV" : "CSV"}: a quoted field opened on line ${quoteLine} is never closed`,
      "VALIDATION_ERROR",
      [
        'Close the quote, or write a literal quote as "" inside a quoted field',
        "Nothing was written",
      ],
    );
  }
  // The last row, unless the text ended with a newline.
  if (rowHasContent || row.length > 0 || fieldText !== "") endRow();
  // Trailing blank lines are not rows.
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

function cellName(r: number, c: number): string {
  return `row ${r + 1}, column ${c + 1}`;
}

function checkScalar(value: unknown, where: string): InputValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    // JSON.parse turns 1e400 into Infinity, which would serialize as null — a
    // silent skip of a cell counted as written.
    if (!Number.isFinite(value)) {
      throw new AxiError(`JSON ${where} is not a finite number`, "VALIDATION_ERROR", [
        'Write very large numbers as strings, e.g. "1e400"',
        "Nothing was written",
      ]);
    }
    return value;
  }
  throw new AxiError(
    `JSON ${where} is ${Array.isArray(value) ? "an array" : "an object"} — a cell takes a string, number, boolean or null`,
    "VALIDATION_ERROR",
    ["Nothing was written"],
  );
}

export type JsonBlock =
  | { kind: "grid"; rows: Block }
  | { kind: "keyed"; objects: Array<Record<string, InputValue>> };

/**
 * A JSON block: a 2-D array of rows; for `append` (`allowObjects`) also an
 * array of objects keyed by header title.
 */
export function parseJsonGrid(text: string, opts: { allowObjects: boolean }): JsonBlock {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new AxiError(`Malformed JSON: ${(err as Error).message}`, "VALIDATION_ERROR", [
      '--json takes a 2-D array of rows, e.g. [["Name","Qty"],["bolts",40]]',
    ]);
  }
  if (!Array.isArray(data)) {
    throw new AxiError("JSON block is not an array of rows", "VALIDATION_ERROR", [
      '--json takes a 2-D array of rows, e.g. [["Name","Qty"],["bolts",40]]',
    ]);
  }
  const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (data.length > 0 && data.every(isObject)) {
    if (!opts.allowObjects) {
      throw new AxiError(
        "JSON objects keyed by header are an `append` block only",
        "VALIDATION_ERROR",
        [
          'Pass a 2-D array of rows instead, e.g. [["Name","Qty"],["bolts",40]]',
          "Or append the rows: `gws-axi sheets append <id> --json …`",
        ],
      );
    }
    const objects = (data as Array<Record<string, unknown>>).map((obj, r) =>
      Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k, checkScalar(v, `row ${r + 1}, key "${k}"`)]),
      ),
    );
    return { kind: "keyed", objects };
  }
  if (data.length > 0 && data.every((v) => !Array.isArray(v) && !isObject(v))) {
    throw new AxiError(
      "JSON block is a one-dimensional array — a block is an array of rows",
      "VALIDATION_ERROR",
      [`A single row is [[…]]: ${JSON.stringify([data.slice(0, 3)])}`, "Nothing was written"],
    );
  }
  const rows = data.map((row, r) => {
    if (!Array.isArray(row)) {
      throw new AxiError(
        `JSON row ${r + 1} is not an array — every row of a block is an array of cells`,
        "VALIDATION_ERROR",
        ["Nothing was written"],
      );
    }
    return row.map((v, c) => checkScalar(v, cellName(r, c)));
  });
  return { kind: "grid", rows };
}

/**
 * Header-keyed rows → a grid aligned to the tab's row 1. A key naming no
 * header cell is COLUMN_NOT_FOUND before any write; a header no object names
 * is `null` (left untouched).
 */
export function mapKeyedRows(
  objects: Array<Record<string, InputValue>>,
  headerCells: string[],
): Block {
  const index = new Map<string, number>();
  headerCells.forEach((h, j) => {
    const key = h.trim();
    if (key && !index.has(key)) index.set(key, j);
  });
  if (index.size === 0) {
    throw new AxiError(
      "Header-keyed rows need a header row, and row 1 of this tab is empty",
      "HEADER_REQUIRED",
      [
        "Write the header first: `gws-axi sheets update <id> --tab <tab> --range A1 --content 'Name,Status' --header`",
        "Or append a 2-D array of rows instead",
        "Nothing was written",
      ],
    );
  }
  const unknown = new Set<string>();
  for (const obj of objects)
    for (const k of Object.keys(obj)) if (!index.has(k.trim())) unknown.add(k);
  if (unknown.size > 0) {
    const headers = [...index.keys()];
    throw new AxiError(
      `No header cell named ${[...unknown].map((k) => JSON.stringify(k)).join(", ")} in row 1`,
      "COLUMN_NOT_FOUND",
      [
        `Headers in row 1: ${headers.join(", ")}`,
        "Keys match header cells exactly (trimmed, case-sensitive)",
        "Nothing was written",
      ],
    );
  }
  const width = Math.max(...index.values()) + 1;
  return objects.map((obj) => {
    const row: InputValue[] = Array.from({ length: width }, () => null);
    for (const [k, v] of Object.entries(obj)) row[index.get(k.trim()) as number] = v;
    // Trailing nulls write nothing; drop them.
    while (row.length > 0 && row[row.length - 1] === null) row.pop();
    return row;
  });
}

export interface CellArg {
  /** The tab the cell names, when qualified. */
  tab?: string;
  a1: string;
  row0: number;
  col0: number;
  value: string;
}

/** Split `Costs!B5=4800` at the first `=` after the cell (a quoted title may hold one). */
function splitCellArg(arg: string): [string, string] | undefined {
  let from = 0;
  if (arg.startsWith("'")) {
    const close = arg.indexOf("'!", 1);
    if (close !== -1) from = close + 2;
  }
  const eq = arg.indexOf("=", from);
  if (eq === -1) return undefined;
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * `--cell <A1>=<value>`, repeatable: everything before the first `=` is the
 * cell, everything after it the value (so a formula keeps its own `=`).
 */
export function parseCellArgs(args: string[]): CellArg[] {
  const out: CellArg[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const split = splitCellArg(arg);
    if (!split) {
      throw new AxiError(
        `--cell ${arg} has no '=' — the form is <A1>=<value>`,
        "VALIDATION_ERROR",
        ["e.g. --cell B5=4800 --cell D2='=B2*C2'"],
      );
    }
    const [ref, value] = split;
    const { tabTitle, a1 } = splitQualifiedRange(ref.trim());
    const parsed = parseA1(a1);
    if (!parsed || parsed.kind !== "cell") {
      throw new AxiError(`--cell ${arg}: '${ref}' is not one A1 cell`, "RANGE_INVALID", [
        "Name one cell per --cell, e.g. B5 or Costs!B5; a block goes through --range",
        "Nothing was written",
      ]);
    }
    const key = cellA1(parsed.r0 as number, parsed.c0 as number);
    if (seen.has(key)) {
      throw new AxiError(`--cell names ${key} twice`, "VALIDATION_ERROR", [
        "Give each cell once",
        "Nothing was written",
      ]);
    }
    seen.add(key);
    out.push({
      tab: tabTitle,
      a1: key,
      row0: parsed.r0 as number,
      col0: parsed.c0 as number,
      value,
    });
  }
  const tabs = new Set(out.map((c) => c.tab).filter((t) => t !== undefined));
  if (tabs.size > 1) {
    throw new AxiError(
      `--cell names more than one tab (${[...tabs].join(", ")}) — one write targets one tab`,
      "VALIDATION_ERROR",
      ["Run one `sheets update` per tab", "Nothing was written"],
    );
  }
  return out;
}

export interface Shape {
  rows: number;
  cols: number;
  /** Cells the block carries (`null` excluded). */
  cells: number;
}

export function blockShape(rows: Block): Shape {
  return {
    rows: rows.length,
    cols: rows.reduce((w, r) => Math.max(w, r.length), 0),
    cells: rows.reduce((n, r) => n + r.filter((v) => v !== null).length, 0),
  };
}

/** No cell writes anything: no rows, or every cell empty or `null`. */
export function isEmptyBlock(rows: Block): boolean {
  return rows.every((r) => r.every((v) => v === null || v === ""));
}
