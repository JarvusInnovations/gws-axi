import { describe, expect, it } from "vitest";
import type { docs_v1 } from "googleapis";
import { renderBodyAsMarkdown, tableGrid } from "./markdown.js";
import {
  type CellParagraph,
  type TableBlock,
  columnWidths,
  fitWidth,
  parseMarkdown,
} from "./md-to-doc.js";

type Element = docs_v1.Schema$StructuralElement;

function para(
  runs: Array<string | [string, docs_v1.Schema$TextStyle]>,
  style: docs_v1.Schema$ParagraphStyle = {},
  bullet?: docs_v1.Schema$Bullet,
): Element {
  return {
    paragraph: {
      elements: runs.map((r) =>
        typeof r === "string"
          ? { textRun: { content: r, textStyle: {} } }
          : { textRun: { content: r[0], textStyle: r[1] } },
      ),
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", ...style },
      bullet,
    },
  };
}

const mono = { weightedFontFamily: { fontFamily: "Roboto Mono" } };
const pt = (magnitude: number) => ({ magnitude, unit: "PT" });

function render(content: Element[], lists?: Record<string, docs_v1.Schema$List>): string {
  return renderBodyAsMarkdown({ content: [{ sectionBreak: {} }, ...content] }, lists).markdown;
}

describe("docs read markdown renderer", () => {
  it("does not render the body's leading section break", () => {
    expect(render([para(["hello\n"])])).toBe("hello");
  });

  it("renders consecutive monospace paragraphs as one fenced block", () => {
    const out = render([
      para(["before\n"]),
      para([["const x = 1;\n", mono]]),
      para([["  y();\n", mono]]),
      para(["after\n"]),
    ]);
    expect(out).toBe("before\n\n```\nconst x = 1;\n  y();\n```\n\nafter");
  });

  it("keeps inline code inline when the paragraph has other text", () => {
    expect(render([para(["see ", ["x\n", mono]])])).toBe("see `x`");
  });

  it("renders a paragraph indented on both edges as a blockquote", () => {
    const out = render([
      para(["quoted\n"], { indentStart: pt(30), indentEnd: pt(30), indentFirstLine: pt(30) }),
    ]);
    expect(out).toBe("> quoted");
  });

  it("does not treat a start-only indent as a quote", () => {
    expect(render([para(["indented\n"], { indentStart: pt(36) })])).toBe("indented");
  });

  it("renders a checkbox list as open tasks", () => {
    const lists = {
      "kix.cb": {
        listProperties: {
          nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED", glyphFormat: "%0" }],
        },
      },
      "kix.b": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
    };
    const out = render(
      [para(["task\n"], {}, { listId: "kix.cb" }), para(["bullet\n"], {}, { listId: "kix.b" })],
      lists,
    );
    // Two lists back to back are separated, so they read back as two lists.
    expect(out).toBe("- [ ] task\n\n- bullet");
  });

  it("renders a vertical tab as a hard line break", () => {
    expect(render([para(["one\u000btwo\n"])])).toBe("one  \ntwo");
  });

  it("renders an empty paragraph with a bottom border as a rule", () => {
    const out = render([
      para(["a\n"]),
      para(["\n"], { borderBottom: { width: pt(1) } }),
      para(["b\n"]),
    ]);
    expect(out).toBe("a\n\n---\n\nb");
  });

  it("still renders a later section break as a rule", () => {
    expect(render([para(["a\n"]), { sectionBreak: {} }, para(["b\n"])])).toBe("a\n\n---\n\nb");
  });
});

describe("docs read: images and tasks", () => {
  it("renders an image's alt text when it has one", () => {
    const body = {
      content: [
        { sectionBreak: {} },
        {
          paragraph: {
            elements: [
              { inlineObjectElement: { inlineObjectId: "kix.a" } },
              { inlineObjectElement: { inlineObjectId: "kix.b" } },
              { textRun: { content: "\n" } },
            ],
          },
        },
      ],
    };
    const objects = {
      "kix.a": { inlineObjectProperties: { embeddedObject: { description: "a chart" } } },
      "kix.b": { inlineObjectProperties: { embeddedObject: {} } },
    };
    const out = renderBodyAsMarkdown(body, {}, {}, objects);
    expect(out.markdown).toBe("[image: a chart][image]");
    expect(out.image_count).toBe(2);
  });

  it("counts checklist items", () => {
    const lists = {
      "kix.cb": {
        listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] },
      },
    };
    const out = renderBodyAsMarkdown(
      {
        content: [
          { sectionBreak: {} },
          para(["one\n"], {}, { listId: "kix.cb" }),
          para(["two\n"], {}, { listId: "kix.cb" }),
        ],
      },
      lists,
    );
    expect(out.task_count).toBe(2);
  });
});

describe("docs read markdown renderer: multi-line table cells (#106)", () => {
  const cell = (...content: Element[]): docs_v1.Schema$TableCell => ({ content });
  const lists = {
    "kix.b": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
    "kix.t": { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
  };

  it("joins cell paragraphs and hard breaks with <br>, and marks bulleted cell paragraphs", () => {
    const table: Element = {
      table: {
        tableRows: [
          {
            tableCells: [
              cell(para([["Label\n", { bold: true }]])),
              cell(para([["Value\n", { bold: true }]])),
            ],
          },
          {
            tableCells: [
              cell(para([["Inputs\n", { bold: true }]])),
              cell(
                para(["intro\u000bmore\n"]),
                para(
                  [["Brief\n", { link: { url: "https://h/b" } }]],
                  {},
                  { listId: "kix.b", nestingLevel: 0 },
                ),
                para(["Transcript\n"], {}, { listId: "kix.b", nestingLevel: 0 }),
                para(["open\n"], {}, { listId: "kix.t", nestingLevel: 0 }),
              ),
            ],
          },
        ],
      },
    };
    expect(render([table], lists)).toBe(
      "| Label | Value |\n| --- | --- |\n| **Inputs** | intro<br>more<br>- [Brief](https://h/b)<br>- Transcript<br>- [ ] open |",
    );
  });
});

describe("docs read markdown renderer: column-width hints (#107)", () => {
  const twoByOne = (cols: docs_v1.Schema$TableColumnProperties[]): Element => ({
    table: {
      tableStyle: { tableColumnProperties: cols },
      tableRows: [{ tableCells: [{ content: [para(["a\n"])] }, { content: [para(["b\n"])] }] }],
    },
  });
  const fixed = (pt: number): docs_v1.Schema$TableColumnProperties => ({
    widthType: "FIXED_WIDTH",
    width: { magnitude: pt, unit: "PT" },
  });

  it("emits percentages for fixed, unequal columns and nothing otherwise", () => {
    expect(render([twoByOne([fixed(117), fixed(351)])])).toBe(
      "<!-- cols: 25% 75% -->\n| a | b |\n| --- | --- |",
    );
    expect(render([twoByOne([fixed(156), fixed(156), fixed(156)].slice(0, 2))])).toBe(
      "| a | b |\n| --- | --- |",
    );
    expect(
      render([
        twoByOne([{ widthType: "EVENLY_DISTRIBUTED" }, { widthType: "EVENLY_DISTRIBUTED" }]),
      ]),
    ).toBe("| a | b |\n| --- | --- |");
    // Rounding remainder lands on the last column so the hint totals 100.
    expect(render([twoByOne([fixed(100), fixed(200)])])).toBe(
      "<!-- cols: 33% 67% -->\n| a | b |\n| --- | --- |",
    );
  });
});

describe("docs read markdown renderer: merged cells", () => {
  /** A Docs table as the API returns it: covered cells present and empty, spans only on heads. */
  type Spec = string | { text: string; rows?: number; cols?: number } | null;
  const docTable = (rows: Spec[][], headerRows = 1): Element => ({
    table: {
      tableRows: rows.map((row, r) => ({
        tableRowStyle: r < headerRows ? { tableHeader: true } : {},
        tableCells: row.map((s) => {
          const text = s === null ? "" : typeof s === "string" ? s : s.text;
          const spans =
            s && typeof s === "object" ? { rowSpan: s.rows ?? 1, columnSpan: s.cols ?? 1 } : {};
          return { content: [para([`${text}\n`])], tableCellStyle: spans };
        }),
      })),
    },
  });

  it("writes heads with their pipes and covered rows as a bare caret", () => {
    const table = docTable([
      ["a", "b", "c"],
      [{ text: "wide", cols: 3 }, null, null],
      [{ text: "tall", rows: 2 }, "1", "2"],
      [null, "3", "4"],
    ]);
    expect(render([table])).toBe(
      "| a | b | c |\n| --- | --- | --- |\n| wide |||\n| tall | 1 | 2 |\n| ^| 3 | 4 |",
    );
  });

  it("puts every pinned header row above the delimiter, grown over a header row span", () => {
    const pinned = docTable(
      [
        [{ text: "Group", cols: 2 }, null, "c"],
        ["a", "b", "d"],
        ["1", "2", "3"],
      ],
      2,
    );
    expect(render([pinned])).toBe(
      "| Group || c |\n| a | b | d |\n| --- | --- | --- |\n| 1 | 2 | 3 |",
    );
    const grown = docTable(
      [
        [{ text: "h", rows: 2 }, "x"],
        [null, "y"],
        ["1", "2"],
      ],
      1,
    );
    expect(render([grown])).toBe("| h | x |\n| ^| y |\n| --- | --- |\n| 1 | 2 |");
  });

  it("escapes a literal pipe and a literal trailing caret", () => {
    expect(render([docTable([["a|b", "2^"]])])).toBe("| a\\|b | 2\\^ |\n| --- | --- |");
  });

  it("maps every grid position to the head that covers it", () => {
    const t = docTable([
      [{ text: "x", rows: 2, cols: 2 }, null, "c"],
      [null, null, "d"],
    ]).table!;
    expect(tableGrid(t)[1][1]).toEqual({ headRow: 0, headCol: 0, rowSpan: 2, colSpan: 2 });
    expect(tableGrid(t)[1][2]).toEqual({ headRow: 1, headCol: 2, rowSpan: 1, colSpan: 1 });
  });

  it("round-trips a table with both span kinds through the converter", () => {
    const md =
      "| Field | Value || Notes |\n| a | b | c | ^|\n| --- | --- | --- | --- |\n| Caption across ||||\n| State | x \\| y | z | n |\n| ^| q | r^ ... | s |\n| ^| t | u | v\\^ |";
    const block = parseMarkdown(md).blocks[0];
    if (block.kind !== "table") throw new Error("no table");
    // What Docs holds after the write: heads carry spans, covered cells are empty.
    const table: Element = {
      table: {
        tableRows: block.rows.map((row, r) => ({
          tableRowStyle: r < block.headerRows ? { tableHeader: true } : {},
          tableCells: row.map((cell) => ({
            content: [
              para([`${cell ? cell.paragraphs[0].inline.runs.map((x) => x.text).join("") : ""}\n`]),
            ],
            tableCellStyle: { rowSpan: cell?.rowSpan ?? 1, columnSpan: cell?.colSpan ?? 1 },
          })),
        })),
      },
    };
    expect(render([table])).toBe(md);
  });
});

describe("docs read markdown renderer: fit columns read back as fit", () => {
  /** Write `md` (one table) the way the converter would, as the Doc would hold it, with `widths` overriding. */
  const written = (
    md: string,
    bodyFontPt = 11,
    override?: (w: number[]) => number[],
    readFontPt = bodyFontPt,
  ) => {
    const block = parseMarkdown(md).blocks.find((b) => b.kind === "table") as TableBlock;
    const widths = columnWidths(block, 468, bodyFontPt);
    const table: Element = {
      table: {
        tableStyle: {
          tableColumnProperties: (override ? override(widths) : widths).map((w) => ({
            widthType: "FIXED_WIDTH",
            width: { magnitude: w, unit: "PT" },
          })),
        },
        tableRows: block.rows.map((row, r) => ({
          tableRowStyle: r < block.headerRows ? { tableHeader: true } : {},
          tableCells: row.map((cell) => ({
            content: (
              cell?.paragraphs ?? [
                { inline: { runs: [], images: [], footnotes: [] } } as CellParagraph,
              ]
            ).map((p) =>
              para(
                p.inline.runs.length
                  ? [
                      ...p.inline.runs.map(
                        (x) =>
                          [x.text, x.style.bold ? { bold: true } : {}] as [
                            string,
                            docs_v1.Schema$TextStyle,
                          ],
                      ),
                      "\n",
                    ]
                  : ["\n"],
                {},
                p.list ? { listId: "kix.b", nestingLevel: 0 } : undefined,
              ),
            ),
          })),
        })),
      },
    };
    const lists = { "kix.b": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } } };
    return renderBodyAsMarkdown({ content: [{ sectionBreak: {} }, table] }, lists, null, null, {
      bodyFontPt: readFontPt,
    }).markdown;
  };
  const hintOf = (md: string) => /<!-- cols: [^>]*-->/.exec(md)?.[0];
  const TABLE = "| Stage | Generating |\n| --- | --- |\n| Generated | v2 |\n| Workflow | edits |";

  it("reads a fitted label column back as `fit 1`, and the table round-trips", () => {
    const md = `<!-- cols: fit 1 -->\n${TABLE}`;
    expect(written(md)).toBe(md);
  });

  it("writes `fit fit` for an all-fit table and percentages of the rest when they differ", () => {
    expect(hintOf(written(`<!-- cols: fit fit -->\n${TABLE}`))).toBe("<!-- cols: fit fit -->");
    const three = "| k | a | b |\n| --- | --- | --- |\n| Generated | x | y |";
    expect(hintOf(written(`<!-- cols: fit 3 7 -->\n${three}`))).toBe("<!-- cols: fit 30% 70% -->");
    expect(hintOf(written(`<!-- cols: fit 1 1 -->\n${three}`))).toBe("<!-- cols: fit 1 1 -->");
  });

  it("falls back to percentages when the column no longer matches its content", () => {
    const md = `<!-- cols: fit 1 -->\n${TABLE}`;
    expect(hintOf(written(md, 11, ([a, b]) => [a + 2, b - 2]))).toMatch(
      /^<!-- cols: \d+% \d+% -->$/,
    );
  });

  it("measures at the tab's body size, with header bold and list indents as the writer does", () => {
    const md =
      "<!-- cols: fit 1 -->\n| Label | Value |\n| --- | --- |\n| - one item<br>- two | x |\n| **Bold label** | y |";
    expect(written(md, 12)).toBe(md);
    // Written at 12pt, read as if the tab were 11pt: not that size's fit, so a percentage.
    expect(hintOf(written(md, 12, undefined, 11))).toMatch(/^<!-- cols: \d+% \d+% -->$/);
  });

  it("fitWidth is the width columnWidths gives a fit column", () => {
    const block = parseMarkdown(
      `<!-- cols: fit 1 fit -->\n| a | b | c |\n| --- | --- | --- |\n| Generated | x | Workflow |`,
    ).blocks[0] as TableBlock;
    const widths = columnWidths(block, 468, 11);
    expect(fitWidth(block, 0, 11)).toBe(widths[0]);
    expect(fitWidth(block, 2, 11)).toBe(widths[2]);
  });
});

describe("docs read markdown renderer: page breaks", () => {
  const pageBreak = (text?: string): Element => ({
    paragraph: {
      elements: [
        ...(text ? [{ textRun: { content: text, textStyle: {} } }] : []),
        { pageBreak: {} },
        { textRun: { content: "\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    },
  });

  it("renders a page break as two rules, after any text in its paragraph", () => {
    expect(render([para(["before\n"]), pageBreak(), para(["after\n"])])).toBe(
      "before\n\n---\n\n---\n\nafter",
    );
    expect(render([pageBreak("tail"), para(["after\n"])])).toBe("tail\n\n---\n\n---\n\nafter");
  });

  it("keeps a page break that sits directly above a table", () => {
    const table: Element = {
      table: { tableRows: [{ tableCells: [{ content: [para(["x\n"])] }] }] },
    };
    expect(render([para(["a\n"]), pageBreak(), table])).toBe("a\n\n---\n\n---\n\n| x |\n| --- |");
  });

  it("round-trips through the parser as one page break", () => {
    const md = render([para(["a\n"]), pageBreak(), para(["b\n"])]);
    expect(
      parseMarkdown(md).blocks.map((b) => (b.kind === "paragraph" && b.pageBreak ? "break" : "x")),
    ).toEqual(["x", "break", "x"]);
  });
});
