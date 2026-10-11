import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { type SpanTableToken, spanTableExtension } from "./span-table.js";

const lexer = new Marked({ gfm: true });
lexer.use({ extensions: [spanTableExtension()] });

function table(markdown: string): SpanTableToken {
  const token = lexer.lexer(markdown).find((t) => t.type === "spanTable");
  if (!token) throw new Error("no spanTable token");
  return token as unknown as SpanTableToken;
}

/** Each row as `text[rows x cols]`, `·` for a covered position. */
function shape(t: SpanTableToken): string[][] {
  return t.rows.map((r) => r.map((c) => (c ? `${c.text}[${c.rowSpan}x${c.colSpan}]` : "·")));
}

describe("span tables: the tokenizer (specs/behaviors/markdown-to-doc.md § Merged cells)", () => {
  it("reads a plain GFM table as single cells", () => {
    const t = table("| a | b |\n| --- | :-: |\n| 1 | 2 |\n");
    expect(shape(t)).toEqual([
      ["a[1x1]", "b[1x1]"],
      ["1[1x1]", "2[1x1]"],
    ]);
    expect(t.headerRows).toBe(1);
    expect(t.columns).toBe(2);
    expect(t.problems).toEqual([]);
  });

  it("spans columns by the number of closing pipes", () => {
    const t = table("| a | b | c |\n|---|---|---|\n| wide |||\n| x || y |\n");
    expect(shape(t).slice(1)).toEqual([
      ["wide[1x3]", "·", "·"],
      ["x[1x2]", "·", "y[1x1]"],
    ]);
  });

  it("continues the cell above with a caret, appending its text after a space", () => {
    const t = table("| a | b |\n|---|---|\n| tall | 1 |\n| more ^| 2 |\n| ^ | 3 |\n");
    expect(shape(t).slice(1)).toEqual([
      ["tall more[3x1]", "1[1x1]"],
      ["·", "2[1x1]"],
      ["·", "3[1x1]"],
    ]);
  });

  it("continues a cell that spans columns when the widths match", () => {
    const t = table("| a | b | c |\n|---|---|---|\n| block || x |\n| ^|| y |\n");
    expect(shape(t).slice(1)).toEqual([
      ["block[2x2]", "·", "x[1x1]"],
      ["·", "·", "y[1x1]"],
    ]);
  });

  it("reads rows above the delimiter as header rows, with spans", () => {
    const t = table("| Group || c |\n| a | b | ^|\n|---|---|---|\n| 1 | 2 | 3 |\n");
    expect(t.headerRows).toBe(2);
    expect(shape(t)).toEqual([
      ["Group[1x2]", "·", "c[2x1]"],
      ["a[1x1]", "b[1x1]", "·"],
      ["1[1x1]", "2[1x1]", "3[1x1]"],
    ]);
  });

  it("reads \\| and a final \\^ as literal characters", () => {
    const t = table("| a | b |\n|---|---|\n| x \\| y | 2\\^ |\n");
    expect(shape(t)[1]).toEqual(["x | y[1x1]", "2^[1x1]"]);
    expect(t.problems).toEqual([]);
  });

  it("pads a short row and keeps a row made only of carets", () => {
    const t = table("| a | b |\n|---|---|\n| x |\n| y | z |\n| ^| ^|\n");
    expect(shape(t).slice(1)).toEqual([
      ["x[1x1]", "[1x1]"],
      ["y[2x1]", "z[2x1]"],
      ["·", "·"],
    ]);
  });

  it("reports a row wider than the header", () => {
    expect(table("| a | b |\n|---|---|\n| x | y || \n").problems).toEqual([
      "row 2, column 2: the row spans 3 columns; the table has 2",
    ]);
  });

  it("reports a caret with nothing to continue", () => {
    expect(table("| a ^| b |\n|---|---|\n| x | y |\n").problems[0]).toMatch(
      /^row 1, column 1: `\^` has nothing to continue — the first row has no cell above it/,
    );
    expect(table("| a | b |\n|---|---|\n| ^| y |\n").problems[0]).toMatch(
      /^row 2, column 1: .*a body cell can't continue a header cell/,
    );
    expect(
      table("| a | b | c |\n|---|---|---|\n| wide || c |\n| ^| y | z |\n").problems[0],
    ).toMatch(/^row 3, column 1: .*doesn't start in this column with the same width/);
  });

  it("reports widths in the delimiter row", () => {
    expect(table("| a | b |\n|--25%--|--75%--|\n| x | y |\n").problems).toEqual([
      "the delimiter row sets column widths; put `<!-- cols: 25% 75% -->` on the line above the table instead",
    ]);
  });
});

describe("span tables: what is not a table", () => {
  it("needs a pipe on every header line, so prose above a `---` stays prose", () => {
    const tokens = lexer.lexer("a line with a | pipe\nmore prose\n---\n");
    expect(tokens.some((t) => t.type === "spanTable")).toBe(false);
  });
});
