import { type CellLike, enteredText, errorText, isEmptyCell } from "./shared.js";
import type { InputValue } from "./values.js";

/**
 * The comparisons around a write (specs/commands/sheets-write.md § Behavior,
 * § Output): before the write, would this input store what is already there;
 * after it, what changed and what Sheets made of the input. Pure.
 */

/** One cell the block writes (its `null` cells are not planned at all). */
export interface PlannedCell {
  a1: string;
  row0: number;
  col0: number;
  input: Exclude<InputValue, null>;
}

/** The text a cell was given, as the response echoes it. */
export function inputText(input: Exclude<InputValue, null>): string {
  if (typeof input === "boolean") return input ? "TRUE" : "FALSE";
  return String(input);
}

const CANONICAL_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const CANONICAL_INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** How typed text parses where it lands: the spreadsheet's locale. */
export interface ParseContext {
  locale?: string;
}

/** The locale's decimal separator; `.` when the locale is unknown or unreadable. */
export function decimalSeparator(locale: string | undefined): string {
  if (!locale) return ".";
  try {
    const parts = new Intl.NumberFormat(locale.replace(/_/g, "-")).formatToParts(1.5);
    return parts.find((p) => p.type === "decimal")?.value ?? ".";
  } catch {
    return ".";
  }
}

/** TRUE/FALSE read as booleans only in an English locale (or an unknown one). */
function englishLocale(locale: string | undefined): boolean {
  return !locale || /^en([_-]|$)/i.test(locale);
}

/** A USER_ENTERED string that can only be stored as the same text. */
function isPlainText(s: string): boolean {
  return (
    !/[0-9]/.test(s) && !/^\s*(true|false)\s*$/i.test(s) && !/^[=+'#-]/.test(s) && s.trim() === s
  );
}

/**
 * Would writing `input` store exactly what `stored` holds? Errs toward
 * "no": anything USER_ENTERED might parse into another kind counts as a
 * change, because a false "unchanged" would leave the sheet wrong while a
 * false "changed" costs a harmless re-write.
 */
export function storesSame(
  input: Exclude<InputValue, null>,
  stored: CellLike | undefined,
  raw: boolean,
  ctx: ParseContext = {},
): boolean {
  const v = stored?.userEnteredValue;
  if (isEmptyCell(stored)) return input === "";
  if (input === "") return false;
  // A TEXT-formatted cell stores what is typed as a string (observed), so no
  // number or boolean shortcut holds there.
  const textCell = stored?.effectiveFormat?.numberFormat?.type === "TEXT";
  if (typeof input === "number") return !textCell && v?.numberValue === input;
  if (typeof input === "boolean") return !textCell && v?.boolValue === input;
  if (raw) return v?.stringValue === input;
  if (input.startsWith("=")) return v?.formulaValue === input;
  if (CANONICAL_NUMBER.test(input)) {
    // An integer reads the same everywhere; a decimal only where `.` is the
    // separator (in de_DE `5.5` is a date — observed).
    const sure = CANONICAL_INTEGER.test(input) || decimalSeparator(ctx.locale) === ".";
    return sure && !textCell && v?.numberValue === Number(input);
  }
  if (/^(true|false)$/i.test(input)) {
    return (
      englishLocale(ctx.locale) && !textCell && v?.boolValue === (input.toLowerCase() === "true")
    );
  }
  if (isPlainText(input)) return v?.stringValue === input;
  return false;
}

export interface CellDiff {
  cell: string;
  before: string;
  changed: boolean;
}

/** The pre-write comparison, per cell. */
export function diffBlock(
  planned: PlannedCell[],
  current: Map<string, CellLike>,
  raw: boolean,
  ctx: ParseContext = {},
): CellDiff[] {
  return planned.map((p) => {
    const stored = current.get(p.a1);
    return {
      cell: p.a1,
      before: isEmptyCell(stored) ? "" : enteredText(stored),
      changed: !storesSame(p.input, stored, raw, ctx),
    };
  });
}

/** Did the cell's entered value change between two reads? */
export function sameEntered(a: CellLike | undefined, b: CellLike | undefined): boolean {
  if (isEmptyCell(a) && isEmptyCell(b)) return true;
  const norm = (c: CellLike | undefined) => {
    const v = c?.userEnteredValue ?? {};
    return JSON.stringify([
      v.stringValue ?? null,
      v.numberValue ?? null,
      v.boolValue ?? null,
      v.formulaValue ?? null,
    ]);
  };
  return norm(a) === norm(b);
}

/** Sheets' date serial (days since 1899-12-30) → `YYYY-MM-DD`. */
export function serialToIsoDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * What a cell displays after the write. A string Sheets parsed into a date
 * also shows the date it became — `1/2` keeps displaying `1/2` under its `m/d`
 * format, so the display alone hides the parse (observed).
 */
export function displayNow(cell: CellLike | undefined, input: Exclude<InputValue, null>): string {
  const shown = cell?.formattedValue ?? "";
  const type = cell?.effectiveFormat?.numberFormat?.type;
  const serial = cell?.userEnteredValue?.numberValue;
  if (typeof input === "string" && serial != null && (type === "DATE" || type === "DATE_TIME")) {
    const iso = serialToIsoDate(serial);
    if (input.trim() !== iso) return `${shown} (date ${iso})`;
  }
  return shown;
}

export interface FormulaRow {
  cell: string;
  formula: string;
  result: string;
  message: string;
  [key: string]: unknown;
}

export interface WrittenRow {
  cell: string;
  before: string;
  input: string;
  now: string;
  [key: string]: unknown;
}

export interface WriteReport {
  formulas: FormulaRow[];
  written: WrittenRow[];
  /** Cells whose entered value differs after the write. */
  changed: number;
  /** The `written[]` row the input-mode help line names, when one shows a parse. */
  parsed?: WrittenRow;
}

/**
 * The read-back report: every formula with its result or error; and every
 * non-formula cell worth a second look — one that had a value and got a
 * different one, or whose display differs from what was typed. A cell that was
 * empty and now displays exactly what was typed is the block's own record.
 */
export function reportWrite(
  planned: PlannedCell[],
  pre: Map<string, CellLike>,
  post: Map<string, CellLike>,
  raw: boolean,
): WriteReport {
  const formulas: FormulaRow[] = [];
  const written: WrittenRow[] = [];
  let changed = 0;
  let parsed: WrittenRow | undefined;
  for (const p of planned) {
    const before = pre.get(p.a1);
    const after = post.get(p.a1);
    const differs = !sameEntered(before, after);
    if (differs) changed++;
    const formula = after?.userEnteredValue?.formulaValue;
    if (!raw && formula != null) {
      const err = after?.effectiveValue?.errorValue;
      formulas.push({
        cell: p.a1,
        formula,
        result: err
          ? (after?.formattedValue ?? errorText(err.type))
          : (after?.formattedValue ?? ""),
        message: err?.message ?? "",
      });
      continue;
    }
    const typed = inputText(p.input);
    const now = displayNow(after, p.input);
    const hadValue = !isEmptyCell(before);
    if ((hadValue && differs) || now !== typed) {
      const row = {
        cell: p.a1,
        before: hadValue ? enteredText(before) : "",
        input: typed,
        now,
      };
      written.push(row);
      // Name a parse over a mere number format: a formatted number is what was meant.
      if (now !== typed && typed !== "" && (!parsed || formatOnly(parsed.input))) {
        if (!parsed || !formatOnly(typed)) parsed = row;
      }
    }
  }
  return { formulas, written, changed, parsed };
}

/** A plain number whose display differs only by the cell's number format. */
function formatOnly(input: string): boolean {
  return CANONICAL_NUMBER.test(input);
}

/** The help line naming one parse, e.g. `D4: 1/2 became the date 2026-01-02`. */
export function parsedLine(row: WrittenRow): string {
  const date = /\(date (\d{4}-\d{2}-\d{2})\)$/.exec(row.now);
  if (date) return `${row.cell}: ${row.input} became the date ${date[1]}; --raw stores it as text`;
  if (formatOnly(row.input)) {
    return `${row.cell}: ${row.input} shows as ${row.now || "(empty)"} under the cell's number format`;
  }
  return `${row.cell}: ${row.input} became ${row.now || "(empty)"}; --raw stores it as text`;
}
