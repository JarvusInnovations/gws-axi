import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import {
  MONO_FONT,
  QUOTE_INDENT_PT,
  locateTables,
  parseMarkdown,
  phase1Requests,
  phase2Requests,
  type Placement,
} from "./md-to-doc.js";

const TAB = "t.x";
const top: Placement = { tabId: TAB, base: 1, emptyTab: true, atTop: true };

function run(markdown: string, placement: Placement = top) {
  const parsed = parseMarkdown(markdown);
  const phase1 = phase1Requests(parsed.blocks, placement);
  return { parsed, phase1, requests: phase1.requests };
}

/** The inserted body text. */
function inserted(requests: docs_v1.Schema$Request[]): string {
  return requests[0]?.insertText?.text ?? "";
}

function paragraphStyles(requests: docs_v1.Schema$Request[]) {
  return requests
    .filter((r) => r.updateParagraphStyle)
    .map((r) => r.updateParagraphStyle!)
    .slice(1); // skip the reset
}

function textStyles(requests: docs_v1.Schema$Request[]) {
  return requests
    .filter((r) => r.updateTextStyle)
    .map((r) => r.updateTextStyle!)
    .slice(1); // skip the reset
}

/** The text a range covers in the inserted body (body starts at `base`). */
function covered(
  requests: docs_v1.Schema$Request[],
  range: docs_v1.Schema$Range,
  base = 1,
): string {
  const body = inserted(requests).replace(/^\n/, "");
  return body.slice((range.startIndex ?? 0) - base, (range.endIndex ?? 0) - base);
}

describe("markdown-to-doc: text and paragraph styles", () => {
  it("inserts the whole body once and resets inherited styles first", () => {
    const { requests } = run("# Title\n\nHello **world**.");
    expect(inserted(requests)).toBe("Title\nHello world.");
    expect(requests[0].insertText?.location).toEqual({ index: 1, tabId: TAB });
    expect(requests[1].updateParagraphStyle?.paragraphStyle).toEqual({
      namedStyleType: "NORMAL_TEXT",
    });
    // Through the final newline, which the last paragraph owns.
    expect(requests[1].updateParagraphStyle?.range).toEqual({
      startIndex: 1,
      endIndex: 20,
      tabId: TAB,
    });
    expect(requests[2].updateTextStyle?.fields).toContain("link");
    expect(requests[3].deleteParagraphBullets?.range).toEqual({
      startIndex: 1,
      endIndex: 20,
      tabId: TAB,
    });
  });

  it("maps headings to named styles and removes the gap above the first one", () => {
    const { requests } = run("# One\n\n### Three\n\ntext");
    const styles = paragraphStyles(requests);
    expect(styles[0].paragraphStyle).toEqual({
      namedStyleType: "HEADING_1",
      spaceAbove: { magnitude: 0, unit: "PT" },
    });
    expect(styles[0].fields).toBe("namedStyleType,spaceAbove");
    expect(covered(requests, styles[0].range!)).toBe("One");
    expect(styles[1].paragraphStyle).toEqual({ namedStyleType: "HEADING_3" });
    expect(covered(requests, styles[1].range!)).toBe("Three");
  });

  it("keeps the gap when not writing at the top of a tab", () => {
    const { requests } = run("# One", { tabId: TAB, base: 40, emptyTab: false, atTop: false });
    expect(inserted(requests)).toBe("\nOne");
    expect(requests[0].insertText?.location?.index).toBe(39);
    expect(paragraphStyles(requests)[0].fields).toBe("namedStyleType");
    expect(covered(requests, paragraphStyles(requests)[0].range!, 40)).toBe("One");
  });

  it("styles inline runs over exactly their text", () => {
    const { requests } = run("a **b** *c* ~~d~~ `e` [f](https://x.y) <u>g</u> h");
    const styles = textStyles(requests);
    const got = styles.map((s) => [covered(requests, s.range!), s.textStyle, s.fields]);
    expect(got).toEqual([
      ["b", { bold: true }, "bold"],
      ["c", { italic: true }, "italic"],
      ["d", { strikethrough: true }, "strikethrough"],
      ["e", { weightedFontFamily: { fontFamily: MONO_FONT } }, "weightedFontFamily"],
      ["f", { link: { url: "https://x.y" } }, "link"],
      ["g", { underline: true }, "underline"],
    ]);
  });

  it("joins soft breaks with a space and encodes hard breaks as a vertical tab", () => {
    const { requests } = run("one\ntwo  \nthree\\\nfour");
    expect(inserted(requests)).toBe("one two\u000bthree\u000bfour");
  });

  it("indents a blockquote on three sides", () => {
    const { requests } = run("> quoted\n> text");
    const [q] = paragraphStyles(requests);
    expect(q.paragraphStyle?.indentStart).toEqual({ magnitude: QUOTE_INDENT_PT, unit: "PT" });
    expect(q.paragraphStyle?.indentEnd).toEqual({ magnitude: QUOTE_INDENT_PT, unit: "PT" });
    expect(q.fields).toContain("indentFirstLine");
    expect(covered(requests, q.range!)).toBe("quoted text");
  });

  it("writes a code block one line per paragraph, whole lines monospace, and drops the language", () => {
    const { requests, parsed } = run("```js\nconst x = 1;\n  y();\n```");
    expect(inserted(requests)).toBe("const x = 1;\n  y();");
    const mono = textStyles(requests).filter((s) => s.textStyle?.weightedFontFamily);
    expect(mono.map((s) => s.range)).toEqual([
      { startIndex: 1, endIndex: 14, tabId: TAB },
      { startIndex: 14, endIndex: 21, tabId: TAB },
    ]);
    expect(parsed.lossy).toEqual([{ construct: "code_language", count: 1, handling: "dropped" }]);
  });

  it("writes a rule as an empty paragraph with a bottom border", () => {
    const { requests } = run("above\n\n---\n\nbelow");
    expect(inserted(requests)).toBe("above\n\nbelow");
    const rule = paragraphStyles(requests).find((s) => s.fields === "borderBottom")!;
    expect(rule.paragraphStyle?.borderBottom?.width).toEqual({ magnitude: 1, unit: "PT" });
    expect(rule.range).toEqual({ startIndex: 7, endIndex: 8, tabId: TAB });
  });

  it("writes inline and block HTML as text and says so", () => {
    const { requests, parsed } = run("a <b>bold</b> c\n\n<div>block</div>");
    expect(inserted(requests)).toBe("a <b>bold</b> c\n<div>block</div>");
    expect(parsed.lossy.map((l) => l.construct).sort()).toEqual(["html_block", "inline_html"]);
  });
});

describe("markdown-to-doc: lists", () => {
  it("prefixes nesting with tabs and bullets the whole list last", () => {
    const { requests } = run("- a\n  - b\n    - c\n- d\n\npara");
    expect(inserted(requests)).toBe("a\n\tb\n\t\tc\nd\npara");
    const bullets = requests
      .filter((r) => r.createParagraphBullets)
      .map((r) => r.createParagraphBullets!);
    expect(bullets).toEqual([
      {
        range: { startIndex: 1, endIndex: 12, tabId: TAB },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    ]);
    expect(requests.at(-1)?.createParagraphBullets).toBeDefined();
  });

  it("picks the preset from the list kind and reports checked tasks", () => {
    const { requests, parsed } = run("1. one\n2. two\n\n- [ ] open\n- [x] done\n- [x] also");
    const presets = requests
      .filter((r) => r.createParagraphBullets)
      .map((r) => r.createParagraphBullets!.bulletPreset);
    // Emitted in descending index order: the checkbox list comes first.
    expect(presets).toEqual(["BULLET_CHECKBOX", "NUMBERED_DECIMAL_NESTED"]);
    expect(inserted(requests)).toBe("one\ntwo\nopen\ndone\nalso");
    expect(parsed.lossy).toEqual([
      { construct: "checked_task", count: 2, handling: "written unchecked" },
    ]);
  });

  it("styles runs inside a nested item after the tab prefix", () => {
    const { requests } = run("- a\n  - **b**");
    const [bold] = textStyles(requests);
    expect(covered(requests, bold.range!)).toBe("b");
  });

  it("uses the outer kind for a nested list of another kind and discloses it", () => {
    const { requests, parsed } = run("1. one\n   - inner\n2. two");
    const presets = requests
      .filter((r) => r.createParagraphBullets)
      .map((r) => r.createParagraphBullets!.bulletPreset);
    expect(presets).toEqual(["NUMBERED_DECIMAL_NESTED"]);
    expect(parsed.lossy[0].construct).toBe("nested_list_kind");
  });
});

describe("markdown-to-doc: index-shifting requests", () => {
  it("emits images, footnotes, tables, and bullets after styles, in descending index order", () => {
    const md =
      "- item ![alt](https://h/i.png)\n\npara[^1] text\n\n| h |\n| - |\n| c |\n\nend\n\n[^1]: note";
    const { requests, phase1, parsed } = run(md);
    expect(inserted(requests)).toBe("item \npara text\nend");
    const shifting = requests.filter(
      (r) => r.insertInlineImage || r.createFootnote || r.insertTable || r.createParagraphBullets,
    );
    const positions = shifting.map(
      (r) =>
        r.insertInlineImage?.location?.index ??
        r.createFootnote?.location?.index ??
        r.insertTable?.location?.index ??
        r.createParagraphBullets?.range?.startIndex,
    );
    // table before "end" (17), footnote after "para" (11), image after "item " (6), bullets at 1
    expect(positions).toEqual([17, 11, 6, 1]);
    expect(requests.indexOf(shifting[0])).toBeGreaterThan(
      requests.findIndex((r) => r.updateTextStyle),
    );
    expect(phase1.footnoteRequestIndices).toEqual([requests.findIndex((r) => r.createFootnote)]);
    expect(phase1.tables).toHaveLength(1);
    expect(parsed.lossy).toEqual([{ construct: "image_alt", count: 1, handling: "dropped" }]);
  });

  it("gives a trailing table an empty paragraph to precede and resets the paragraph the insert creates", () => {
    const { requests } = run("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(inserted(requests)).toBe("intro\n");
    const i = requests.findIndex((r) => r.insertTable);
    expect(requests[i].insertTable).toEqual({
      rows: 2,
      columns: 2,
      location: { index: 7, tabId: TAB },
    });
    expect(requests[i + 1].updateParagraphStyle?.range).toEqual({
      startIndex: 7,
      endIndex: 8,
      tabId: TAB,
    });
    expect(requests[i + 2].deleteParagraphBullets?.range).toEqual({
      startIndex: 7,
      endIndex: 8,
      tabId: TAB,
    });
  });

  it("refuses a non-http image before producing anything", () => {
    expect(() => parseMarkdown("![x](./local.png)")).toThrowError(AxiError);
    try {
      parseMarkdown("![x](data:image/png;base64,AAAA)");
    } catch (err) {
      expect((err as AxiError).code).toBe("IMAGE_NOT_FETCHABLE");
    }
  });
});

describe("markdown-to-doc: phase 2", () => {
  it("fills cells last-first with a bold header and pins the header row", () => {
    const { phase1 } = run("| h1 | h2 |\n| - | - |\n| **a** | b |");
    const content: docs_v1.Schema$StructuralElement[] = [
      { startIndex: 1, endIndex: 2, paragraph: {} },
      {
        startIndex: 2,
        endIndex: 20,
        table: {
          tableRows: [
            { tableCells: [{ content: [{ startIndex: 5 }] }, { content: [{ startIndex: 7 }] }] },
            { tableCells: [{ content: [{ startIndex: 10 }] }, { content: [{ startIndex: 12 }] }] },
          ],
        },
      },
    ];
    const located = locateTables(content, 1);
    expect(located.tableStarts).toEqual([2]);
    const requests = phase2Requests(phase1, { tabId: TAB, ...located, footnoteIds: [] });
    const inserts = requests
      .filter((r) => r.insertText)
      .map((r) => [r.insertText!.location!.index, r.insertText!.text]);
    expect(inserts).toEqual([
      [12, "b"],
      [10, "a"],
      [7, "h2"],
      [5, "h1"],
    ]);
    const bold = requests
      .filter((r) => r.updateTextStyle)
      .map((r) => r.updateTextStyle!.range!.startIndex);
    expect(bold).toEqual([10, 7, 5]);
    expect(requests.at(-1)?.pinTableHeaderRows).toEqual({
      tableStartLocation: { index: 2, tabId: TAB },
      pinnedHeaderRowsCount: 1,
    });
  });

  it("writes footnote text into its segment", () => {
    const { phase1 } = run("see[^a]\n\n[^a]: the *note*");
    const requests = phase2Requests(phase1, {
      tabId: TAB,
      tableCells: [],
      tableStarts: [],
      footnoteIds: ["kix.fn"],
    });
    expect(requests[0].insertText).toEqual({
      location: { index: 0, segmentId: "kix.fn", tabId: TAB },
      text: "the note",
    });
    expect(requests[1].updateTextStyle?.range).toEqual({
      startIndex: 4,
      endIndex: 8,
      tabId: TAB,
      segmentId: "kix.fn",
    });
  });

  it("ignores tables that were already in the tab", () => {
    const located = locateTables(
      [
        { startIndex: 3, table: {} },
        { startIndex: 50, table: { tableRows: [] } },
      ],
      40,
    );
    expect(located.tableStarts).toEqual([50]);
  });
});

describe("markdown-to-doc: empty input", () => {
  it("produces no requests for an empty body", () => {
    const { requests, phase1 } = run("");
    expect(requests).toEqual([]);
    expect(phase1.blocks).toBe(0);
  });
});
