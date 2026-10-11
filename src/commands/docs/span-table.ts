import type { TokenizerAndRendererExtension, TokenizerThis } from "marked";

/**
 * Tables with merged cells, for the Markdown → Doc converter
 * (specs/behaviors/markdown-to-doc.md § Merged cells).
 *
 * A port of the block tokenizer from marked-extended-tables 2.0.1
 * (https://github.com/calculuschild/marked-extended-tables), which reads
 * MultiMarkdown's column spans (`| wide |||`), a caret for row spans
 * (`| ^|`), and header rows above the delimiter. Ported rather than depended
 * on because its peer range stops short of the marked we use. Changes: it
 * builds a grid of cells (a covered position is `null`) instead of HTML;
 * every source row is kept; `\^` ends a cell with a literal caret; and what
 * the original silently tolerates — a caret with nothing to continue, a row
 * wider than the header, widths in the delimiter row — is reported in
 * `problems` for the converter to refuse.
 *
 * marked-extended-tables: Copyright (c) 2021 calculuschild. MIT License.
 */

export interface SpanCell {
  /** The cell's Markdown, trimmed, with `\|` and a final `\^` unescaped. */
  text: string;
  rowSpan: number;
  colSpan: number;
}

export type SpanTableToken = {
  type: "spanTable";
  raw: string;
  /** Rows above the delimiter row. */
  headerRows: number;
  columns: number;
  /** Grid-shaped: `columns` entries per row; a position covered by a merge is `null`. */
  rows: Array<Array<SpanCell | null>>;
  /** Why this table can't be written, as `row R, column C: …`; empty when it can. */
  problems: string[];
};

const BLOCK_INTERRUPT =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details" +
  "|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head" +
  "|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup" +
  "|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const ALIGN_CELL = String.raw`:?-+(?: *(?:100|[1-9][0-9]?%) *-+)?:?`;

/** The original's table rule: header line(s), the delimiter row, then rows up to a blank line or another block. */
const TABLE = new RegExp(
  String.raw`^ *([^\n ].*\|.*\n(?: *[^\s].*\n)*?)` +
    String.raw` {0,3}(?:\| *)?(${ALIGN_CELL} *(?:\| *${ALIGN_CELL} *)*)(?:\| *)?` +
    String.raw`(?:\n((?:(?! *\n| {0,3}((?:- *){3,}|(?:_ *){3,}|(?:\* *){3,})` +
    String.raw`(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {4}[^\n]| {0,3}(?:\`{3,}` +
    String.raw`(?=[^\`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |` +
    String.raw`<\/?(?:${BLOCK_INTERRUPT})(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)).*(?:\n|$))*)\n*|$)`,
);

const WIDTH = /(?:100|[1-9][0-9]?)%/;

interface RawCell {
  text: string;
  colSpan: number;
  /** The cell ended in an unescaped `^`: it continues the cell above. */
  continues: boolean;
}

/** One table line → cells: a cell runs to its closing pipe(s), and the pipe count is its column span. */
function splitCells(line: string): RawCell[] {
  const parts = [...line.trim().matchAll(/(?:[^|\\]|\\.?)+(?:\|+|$)/g)].map((m) => m[0]);
  if (!parts[0]?.trim()) parts.shift();
  if (!parts[parts.length - 1]?.trim()) parts.pop();
  return parts.map((part) => {
    const body = part.replace(/\|+$/, "");
    const colSpan = Math.max(part.length - body.length, 1);
    // A caret ending the cell, unescaped. (The original also required it to
    // touch the pipe; `\^` is the literal here, so a space before the pipe is fine.)
    const trimmed = body.trim();
    const continues = /(?:^|[^\\])\^$/.test(trimmed);
    let text = (continues ? trimmed.slice(0, -1) : trimmed).trim();
    text = text.replace(/\\\^$/, "^").replace(/\\\|/g, "|");
    return { text, colSpan, continues };
  });
}

/** Parse one table's lines into the grid, recording what can't be written. */
export function buildSpanTable(
  headerLines: string[],
  bodyLines: string[],
  columns: number,
): Pick<SpanTableToken, "rows" | "problems"> {
  const rows: Array<Array<SpanCell | null>> = [];
  const problems: string[] = [];
  /** For each grid position, the head cell covering it and where that head sits. */
  const owner: Array<Array<{ cell: SpanCell; row: number; col: number } | undefined>> = [];
  const lines = [...headerLines, ...bodyLines];
  lines.forEach((line, r) => {
    const row: Array<SpanCell | null> = [];
    owner[r] = [];
    let col = 0;
    for (const raw of splitCells(line)) {
      const where = `row ${r + 1}, column ${col + 1}`;
      if (col + raw.colSpan > columns) {
        problems.push(
          `${where}: the row spans ${col + raw.colSpan} columns; the table has ${columns}`,
        );
        break;
      }
      // A body row can't continue a header row, and the first row has nothing above it.
      const above = r > 0 && r !== headerLines.length ? owner[r - 1][col] : undefined;
      if (raw.continues) {
        const head = above?.cell;
        if (
          !above ||
          !head ||
          above.col !== col ||
          head.colSpan !== raw.colSpan ||
          above.row + head.rowSpan !== r
        ) {
          const reason =
            r === 0
              ? "the first row has no cell above it"
              : r === headerLines.length
                ? "a body cell can't continue a header cell"
                : `the cell above doesn't start in this column with the same width (${raw.colSpan} column${raw.colSpan === 1 ? "" : "s"})`;
          problems.push(
            `${where}: \`^\` has nothing to continue — ${reason}. Write \`\\^\` for a literal caret`,
          );
        } else {
          head.rowSpan += 1;
          if (raw.text) head.text = head.text ? `${head.text} ${raw.text}` : raw.text;
          for (let c = col; c < col + raw.colSpan; c++) {
            row.push(null);
            owner[r][c] = above;
          }
          col += raw.colSpan;
          continue;
        }
      }
      const cell: SpanCell = { text: raw.text, rowSpan: 1, colSpan: raw.colSpan };
      const placed = { cell, row: r, col };
      row.push(cell);
      for (let c = col + 1; c < col + raw.colSpan; c++) row.push(null);
      for (let c = col; c < col + raw.colSpan; c++) owner[r][c] = placed;
      col += raw.colSpan;
    }
    // A short row is padded with empty cells, as in any GFM table.
    while (row.length < columns) {
      const cell: SpanCell = { text: "", rowSpan: 1, colSpan: 1 };
      owner[r][row.length] = { cell, row: r, col: row.length };
      row.push(cell);
    }
    rows.push(row);
  });
  return { rows, problems };
}

/** The marked extension: a block tokenizer emitting `spanTable` tokens. Register it on a private `Marked` instance. */
export function spanTableExtension(): TokenizerAndRendererExtension {
  return {
    name: "spanTable",
    level: "block",
    start(src: string) {
      return src.match(/\n *([^\n ].*\|.*)\n/m)?.index;
    },
    tokenizer(this: TokenizerThis, src: string): SpanTableToken | undefined {
      const cap = TABLE.exec(src);
      if (!cap) return undefined;
      const headerLines = cap[1].replace(/\n$/, "").split("\n");
      const delimiter = cap[2];
      const align = delimiter.replace(/^ *|\| *$/g, "").split(/ *\| */);
      const columns = splitCells(headerLines[0]).reduce((n, c) => n + c.colSpan, 0);
      if (columns !== align.length) return undefined;
      const bodyLines = cap[3]?.trim() ? cap[3].replace(/\n[ \t]*$/, "").split("\n") : [];
      const { rows, problems } = buildSpanTable(headerLines, bodyLines, columns);
      if (WIDTH.test(delimiter)) {
        problems.push(
          "the delimiter row sets column widths; put `<!-- cols: 25% 75% -->` on the line above the table instead",
        );
      }
      return {
        type: "spanTable",
        raw: cap[0],
        headerRows: headerLines.length,
        columns,
        rows,
        problems,
      };
    },
    renderer() {
      return false;
    },
  };
}
