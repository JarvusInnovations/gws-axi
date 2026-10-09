import { describe, expect, it } from "vitest";
import type { docs_v1 } from "googleapis";
import { renderBodyAsMarkdown } from "./markdown.js";

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
