import { AxiError } from "axi-sdk-js";
import { type GridRect, cellA1, columnLetter } from "./shared.js";
import { type Block, type CellArg, type InputValue, mapKeyedRows } from "./values.js";

/**
 * Header-keyed edits of existing rows — `sheets update --json --key <header>`
 * (specs/commands/sheets-write.md § Header-keyed rows). Pure: the caller
 * fetches row 1 and the key column's displayed text; this decides which row
 * each object edits and which cells it writes, or refuses the whole block
 * before anything is written.
 */

export interface KeyColumn {
  /** The header text, trimmed. */
  name: string;
  col0: number;
}

/**
 * The label column: `--key` matched to row 1 (trimmed, case-sensitive), or
 * column A's header when no `--key` was given.
 */
export function resolveKeyColumn(headerCells: string[], key: string | undefined): KeyColumn {
  const headers = headerCells.map((h) => (h ?? "").trim());
  const named = headers.filter((h) => h !== "");
  if (named.length === 0) {
    throw new AxiError(
      "Header-keyed rows need a header row, and row 1 of this tab is empty",
      "HEADER_REQUIRED",
      [
        "Write the header first: `gws-axi sheets update <id> --tab <tab> --range A1 --content 'Name,Status' --header`",
        "Nothing was written",
      ],
    );
  }
  if (key === undefined) {
    if (headers[0]) return { name: headers[0], col0: 0 };
    throw new AxiError(
      "Column A has no header, so there is no default key column",
      "COLUMN_NOT_FOUND",
      [`Name the label column with --key: one of ${named.join(", ")}`, "Nothing was written"],
    );
  }
  const want = key.trim();
  const col0 = headers.indexOf(want);
  if (col0 === -1) {
    throw new AxiError(
      `--key ${JSON.stringify(key)} names no header cell in row 1`,
      "COLUMN_NOT_FOUND",
      [
        `Headers in row 1: ${named.join(", ")}`,
        "--key matches a header cell exactly (trimmed, case-sensitive)",
        "Nothing was written",
      ],
    );
  }
  return { name: want, col0 };
}

/** A key value as the cell would display it: numbers plain, booleans TRUE/FALSE. */
export function keyText(value: Exclude<InputValue, null>): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // String(1e21) is "1e+21"; an integer that large is written out in full.
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) >= 1e21) {
    return BigInt(value).toString();
  }
  return String(value).trim();
}

export interface KeyedMatch {
  key: string;
  /** Position of the object in the block, 0-based. */
  index: number;
  row0: number;
  /** The cells the object writes in its row (key and nulls excluded). */
  cells: CellArg[];
}

export interface KeyedMiss {
  key: string;
  index: number;
  /** The object as a row aligned to row 1, key included — what the keyed append writes. */
  row: Block[number];
}

export interface KeyedMatchPlan {
  matches: KeyedMatch[];
  missing: KeyedMiss[];
}

/**
 * Match each object to the one row whose key cell displays its key value.
 * `keyTexts[row0]` is the key column's displayed text (index 0, the header,
 * is ignored). Every refusal happens here, for the whole block, before any
 * write: an object without its key, the same key twice, a key matching 2+
 * rows (`ROW_AMBIGUOUS`), and — unless `appendMissing` — a key matching none
 * (`ROW_NOT_FOUND`).
 */
export function matchKeyedRows(
  objects: Array<Record<string, InputValue>>,
  headerCells: string[],
  key: KeyColumn,
  keyTexts: Array<string | undefined>,
  opts: { appendMissing: boolean },
): KeyedMatchPlan {
  // Aligns every object to row 1, refusing unknown keys (COLUMN_NOT_FOUND).
  const rows = mapKeyedRows(objects, headerCells);
  const letter = columnLetter(key.col0);

  const keys = rows.map((row, i) => {
    const v = row[key.col0];
    const text = v === null || v === undefined ? "" : keyText(v);
    if (text === "") {
      throw new AxiError(
        `Object ${i + 1} has no ${JSON.stringify(key.name)} — every object needs the key that finds its row`,
        "VALIDATION_ERROR",
        [
          `Add "${key.name}": <label> to object ${i + 1}, or pass --key to match on another column`,
          "Nothing was written",
        ],
      );
    }
    return text;
  });
  const seen = new Map<string, number>();
  keys.forEach((k, i) => {
    const first = seen.get(k);
    if (first !== undefined) {
      throw new AxiError(
        `Objects ${first + 1} and ${i + 1} both have ${key.name} ${JSON.stringify(k)}`,
        "VALIDATION_ERROR",
        ["Give each row once: merge the two objects", "Nothing was written"],
      );
    }
    seen.set(k, i);
  });

  // Rows by displayed key text, below the header.
  const byText = new Map<string, number[]>();
  keyTexts.forEach((t, row0) => {
    if (row0 === 0 || t === undefined) return;
    const text = t.trim();
    if (text === "") return;
    const list = byText.get(text);
    if (list) list.push(row0);
    else byText.set(text, [row0]);
  });

  const ambiguous = keys
    .map((k) => ({ k, rows: byText.get(k) ?? [] }))
    .filter((a) => a.rows.length > 1);
  if (ambiguous.length > 0) {
    const what = ambiguous
      .map((a) => `${JSON.stringify(a.k)} (rows ${a.rows.map((r) => r + 1).join(", ")})`)
      .join("; ");
    throw new AxiError(`${key.name} matches more than one row: ${what}`, "ROW_AMBIGUOUS", [
      `Address one of them by cell instead: --cell <A1>=<value>, or --range with a grid block`,
      "Or match on a column whose labels are unique: --key <header>",
      "Nothing was written",
    ]);
  }

  const matches: KeyedMatch[] = [];
  const missing: KeyedMiss[] = [];
  rows.forEach((row, index) => {
    const k = keys[index];
    const hit = byText.get(k)?.[0];
    if (hit === undefined) {
      missing.push({ key: k, index, row });
      return;
    }
    const cells: CellArg[] = [];
    row.forEach((v, col0) => {
      if (v === null || col0 === key.col0) return;
      cells.push({ a1: cellA1(hit, col0), row0: hit, col0, value: v });
    });
    matches.push({ key: k, index, row0: hit, cells });
  });

  // A near miss is refused even under --append-missing: appending it would
  // leave the row it meant stale and add a duplicate the next run matches.
  const near = missing.flatMap((m) => {
    const hit = nearMiss(m.key, byText);
    return hit
      ? [
          `${JSON.stringify(m.key)}: row ${hit.row0 + 1} displays ${JSON.stringify(hit.text)} (${hit.why})`,
        ]
      : [];
  });
  if (near.length > 0) {
    throw new AxiError(
      `No row's ${key.name} (column ${letter}) displays ${missing.map((m) => JSON.stringify(m.key)).join(", ")} exactly, but a row nearly does`,
      "ROW_NOT_FOUND",
      [
        ...near,
        "Pass the label exactly as displayed, or fix the sheet",
        ...(opts.appendMissing
          ? ["--append-missing does not append a near miss as a new row"]
          : []),
        "Nothing was written",
      ],
    );
  }
  if (missing.length > 0 && !opts.appendMissing) {
    throw new AxiError(
      `No row's ${key.name} (column ${letter}) displays ${missing.map((m) => JSON.stringify(m.key)).join(", ")}`,
      "ROW_NOT_FOUND",
      [
        "Labels match the key column's displayed text exactly (trimmed, case-sensitive)",
        "Pass --append-missing to add unmatched objects as new rows",
        "Nothing was written",
      ],
    );
  }
  return { matches, missing };
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** A displayed number without its formatting (`$1,200.00` → 1200), or undefined. */
export function strippedNumber(text: string): number | undefined {
  const bare = text.replace(/[\s,$€£¥%]/g, "");
  if (!NUMBER.test(bare)) return undefined;
  const n = Number(bare);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The row an unmatched key almost names: one displaying it case-insensitively,
 * or — for a numeric key — one whose displayed number equals it once its
 * formatting is stripped (`7` against `7.00`, `1200` against `1,200`).
 */
export function nearMiss(
  key: string,
  byText: Map<string, number[]>,
): { row0: number; text: string; why: string } | undefined {
  const lower = key.toLowerCase();
  for (const [text, rows] of byText) {
    if (text.toLowerCase() === lower) {
      return { row0: rows[0], text, why: "labels are case-sensitive" };
    }
  }
  const n = NUMBER.test(key.replace(/,/g, "")) ? Number(key.replace(/,/g, "")) : undefined;
  if (n === undefined) return undefined;
  for (const [text, rows] of byText) {
    if (strippedNumber(text) === n) {
      return { row0: rows[0], text, why: "labels match the displayed text, formatting included" };
    }
  }
  return undefined;
}

/**
 * One read rectangle per row: the bounding box of the cells written in it,
 * widened to take in the key cell when `keyCol0` is given (a matched row, whose
 * key the pre-read re-checks). Rows in first-seen order.
 */
export function rowRects(cells: CellArg[], keyCol0?: number): GridRect[] {
  const byRow = new Map<number, { c0: number; c1: number }>();
  for (const c of cells) {
    const r = byRow.get(c.row0);
    if (r) {
      r.c0 = Math.min(r.c0, c.col0);
      r.c1 = Math.max(r.c1, c.col0 + 1);
    } else byRow.set(c.row0, { c0: c.col0, c1: c.col0 + 1 });
  }
  return [...byRow].map(([row0, { c0, c1 }]) => ({
    r0: row0,
    r1: row0 + 1,
    c0: keyCol0 === undefined ? c0 : Math.min(c0, keyCol0),
    c1: keyCol0 === undefined ? c1 : Math.max(c1, keyCol0 + 1),
  }));
}

/** Appended rows as cells, from `row0` down (nulls skipped). */
export function appendedCells(missing: KeyedMiss[], row0: number): CellArg[][] {
  return missing.map((m, i) => {
    const out: CellArg[] = [];
    m.row.forEach((v, col0) => {
      if (v === null) return;
      out.push({ a1: cellA1(row0 + i, col0), row0: row0 + i, col0, value: v });
    });
    return out;
  });
}
