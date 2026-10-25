import { AxiError } from "axi-sdk-js";
import { sheetsClient } from "../../google/client.js";
import { joinBlocks, renderHelp, renderObject } from "../../output/index.js";
import { type FlagSpec, parseArgs } from "../../util/flags.js";
import {
  type CellLike,
  type TabInfo,
  cellA1,
  displayTitle,
  fetchMeta,
  gridCells,
  parseA1,
  quoteTitle,
  shellArg,
  splitQualifiedRange,
  translateWriteError,
} from "./shared.js";
import { fetchGrid, spreadsheetBlock, tabFromFlags } from "./write.js";

/**
 * `sheets note` (specs/commands/sheets-note.md): set, replace or clear the
 * note on one cell. One `updateCells` under the `note` mask — the value and
 * format are not touched — and nothing is sent when the note already reads
 * that.
 */

export const NOTE_HELP = `usage: gws-axi sheets note <spreadsheetId> <A1> (--text <note> | --clear) [--tab <name|gid>] [flags]
args[2]:
  <spreadsheetId>      The spreadsheet ID (the portion of the URL after /d/)
  <A1>                 One cell, optionally tab-qualified (Costs!B2). Not a range
flags[4]:
  --text <note>        The note's full text; replaces any existing note. Newlines
                       are kept. Empty is refused — use --clear
  --clear              Remove the note
  --tab <name|gid>     The tab, by title or numeric gid. Required on a multi-tab
                       spreadsheet unless the cell names it
  --account <email>    REQUIRED when 2+ accounts are authenticated
examples:
  gws-axi sheets note 1AbC... B2 --tab Costs --text 'source: Q3 invoice' --account you@example.com
  gws-axi sheets note 1AbC... 'Costs!B2' --clear --account you@example.com
output:
  action (set | cleared | unchanged), the spreadsheet{id,title,tab,gid,
  web_view_link}, the cell and the value it shows, note{before,after}, and
  an undo line that restores the previous note.
notes:
  Touches the note and nothing else — the value, its format and the other
  cells stay as they were. Idempotent: the same text again (or --clear on a
  cell with no note) is \`unchanged\` and sends nothing. Notes are read back by
  \`gws-axi sheets cell\` (note) and \`gws-axi sheets read\` (notes[]). Comments
  are a different thing: \`gws-axi sheets comments\`.
`;

export const NOTE_FLAGS: FlagSpec = { value: ["--text", "--tab"], boolean: ["--clear"] };

const USAGE =
  "gws-axi sheets note <spreadsheetId> <A1> (--text <note> | --clear) [--tab <name|gid>]";

export interface NoteFlags {
  spreadsheetId: string;
  /** The cell, unqualified and normalized (`b$2` → `B2`). */
  cell: string;
  /** The tab the cell argument names, if it is qualified. */
  cellTab?: string;
  tab?: string;
  /** The new note; `undefined` for --clear. */
  text?: string;
}

export function parseNoteFlags(args: string[]): NoteFlags {
  const parsed = parseArgs(args, NOTE_FLAGS, "sheets note");
  const [spreadsheetId, ref, extra] = parsed.positionals;
  if (!spreadsheetId || !ref) {
    throw new AxiError("Missing spreadsheetId or cell argument", "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
    ]);
  }
  if (extra !== undefined) {
    throw new AxiError(`Unexpected argument: ${extra}`, "VALIDATION_ERROR", [
      `Usage: ${USAGE}`,
      "Quote a note that contains spaces: --text 'two words'",
    ]);
  }
  const { tabTitle, a1 } = splitQualifiedRange(ref);
  const parsedRef = parseA1(a1);
  if (!parsedRef) {
    throw new AxiError(`'${ref}' is not an A1 cell`, "RANGE_INVALID", [
      "Name one cell, e.g. B2 or Costs!B2",
      "Named ranges are not accepted here",
    ]);
  }
  if (parsedRef.kind !== "cell") {
    throw new AxiError(
      `'${ref}' is a range — sheets note sets one cell's note`,
      "VALIDATION_ERROR",
      ["Name one cell, e.g. B2; run the command once per cell for several notes"],
    );
  }
  const text = parsed.values["--text"];
  const clear = parsed.booleans.has("--clear");
  if (text !== undefined && clear) {
    throw new AxiError("--text and --clear can't be combined", "VALIDATION_ERROR", [
      "Pass --text <note> to set the note, or --clear to remove it",
    ]);
  }
  if (text === undefined && !clear) {
    throw new AxiError("Pass --text <note> or --clear", "VALIDATION_ERROR", [`Usage: ${USAGE}`]);
  }
  if (text === "") {
    throw new AxiError("--text is empty — an empty note is refused", "VALIDATION_ERROR", [
      "Pass --clear to remove the note",
      "Nothing was written",
    ]);
  }
  return {
    spreadsheetId,
    cell: cellA1(parsedRef.r0 as number, parsedRef.c0 as number),
    cellTab: tabTitle,
    tab: parsed.values["--tab"],
    text,
  };
}

export type NoteAction = "set" | "cleared" | "unchanged";

/** What a write would do to a cell whose note is `before`. */
export function planNote(
  before: string,
  text: string | undefined,
): { action: NoteAction; after: string } {
  const after = text ?? "";
  if (after === before) return { action: "unchanged", after };
  return { action: text === undefined ? "cleared" : "set", after };
}

/**
 * A note as one shell argument on one line: single-quoted, or `$'…'` when it
 * spans lines (a help line can't hold a raw newline).
 */
export function noteArg(note: string): string {
  if (!/[\n\r\t]/.test(note)) return `'${note.replace(/'/g, `'\\''`)}'`;
  const escaped = note
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `$'${escaped}'`;
}

/** The command that puts `note` back: `--text` with it, or `--clear` when it was empty. */
export function undoCommand(
  spreadsheetId: string,
  cell: string,
  tab: string,
  note: string,
  account: string,
): string {
  const how = note === "" ? "--clear" : `--text ${noteArg(note)}`;
  return `gws-axi sheets note ${spreadsheetId} ${cell} --tab ${shellArg(tab)} ${how} --account ${account}`;
}

interface NoteCell extends CellLike {
  note?: string | null;
}

export async function sheetsNoteCommand(account: string, args: string[]): Promise<string> {
  const flags = parseNoteFlags(args);
  const how = flags.text === undefined ? "--clear" : `--text ${noteArg(flags.text)}`;
  const api = await sheetsClient(account);
  const meta = await fetchMeta(api, account, flags.spreadsheetId);
  const tab: TabInfo = tabFromFlags(
    meta,
    flags.tab,
    flags.cellTab,
    (t) =>
      `gws-axi sheets note ${meta.id} ${flags.cell} --tab ${shellArg(t)} ${how} --account ${account}`,
  );

  const label = `${displayTitle(tab.title)}!${flags.cell}`;
  const ref = parseA1(flags.cell);
  const row0 = ref?.r0 as number;
  const col0 = ref?.c0 as number;
  if (row0 >= tab.rows || col0 >= tab.cols) {
    throw new AxiError(
      `${label} is outside the tab, which is ${tab.rows} rows x ${tab.cols} columns`,
      "RANGE_INVALID",
      [
        `Run \`gws-axi sheets read ${meta.id} --tab ${shellArg(tab.title)}\` to see the tab`,
        "Nothing was written",
      ],
    );
  }

  const range = `${quoteTitle(tab.title)}!${flags.cell}`;
  const data = await fetchGrid(
    api,
    account,
    meta.id,
    [range],
    "sheets(data(startRow,startColumn,rowData(values(note,formattedValue))))",
  );
  const cell = gridCells(data).get(flags.cell)?.cell as NoteCell | undefined;
  const before = cell?.note ?? "";
  const { action, after } = planNote(before, flags.text);

  if (action !== "unchanged") {
    try {
      await api.spreadsheets.batchUpdate({
        spreadsheetId: meta.id,
        requestBody: {
          requests: [
            {
              updateCells: {
                start: { sheetId: tab.gid, rowIndex: row0, columnIndex: col0 },
                // --clear: the cell without a note, under the note mask (observed to clear).
                rows: [{ values: [flags.text === undefined ? {} : { note: flags.text }] }],
                fields: "note",
              },
            },
          ],
        },
      });
    } catch (err) {
      throw translateWriteError(err, {
        account,
        operation: "sheets.spreadsheets.batchUpdate(updateCells)",
        spreadsheetId: meta.id,
        range: label,
      });
    }
  }

  const tabArg = shellArg(tab.title);
  const help: string[] = [];
  if (action === "unchanged") {
    help.push(
      flags.text === undefined
        ? "Nothing was written: the cell has no note"
        : "Nothing was written: the note already reads that",
    );
  }
  help.push(
    `Run \`gws-axi sheets cell ${meta.id} ${flags.cell} --tab ${tabArg}\` to see the cell with its note`,
  );
  if (action !== "unchanged") {
    help.push(`Run \`${undoCommand(meta.id, flags.cell, tab.title, before, account)}\` to undo`);
  }

  return joinBlocks(
    renderObject({ account, action }),
    renderObject({ spreadsheet: spreadsheetBlock(meta, tab) }),
    renderObject({ cell: label, value: cell?.formattedValue ?? "", note: { before, after } }),
    renderHelp(help),
  );
}
