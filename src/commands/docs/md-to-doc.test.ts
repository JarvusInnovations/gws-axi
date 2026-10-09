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
      .filter((r) => r.updateTextStyle?.fields === "bold")
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

describe("markdown-to-doc: tables leave no stray paragraphs (#104, #105, #109)", () => {
  it("a table-only body inserts no text; the tab's own paragraph is the one the table splits", () => {
    const { requests, phase1 } = run("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(requests.some((r) => r.insertText)).toBe(false);
    expect(phase1.tables).toHaveLength(1);
    expect(requests.find((r) => r.insertTable)?.insertTable?.location?.index).toBe(1);
  });

  it("removes the paragraph above a table by deleting the preceding newline", () => {
    const { requests } = run("# Title\n\n| a |\n| - |\n| 1 |\n\nafter");
    // "Title\n" = [1,7); "after" starts at 7, the table goes before it.
    const i = requests.findIndex((r) => r.insertTable);
    expect(requests[i].insertTable?.location?.index).toBe(7);
    const del = requests.slice(i + 1, i + 4).find((r) => r.deleteContentRange);
    expect(del?.deleteContentRange?.range).toEqual({ startIndex: 6, endIndex: 7, tabId: TAB });
  });

  it("shrinks, rather than deletes, the paragraph above a table that opens the tab", () => {
    const { requests } = run("| a |\n| - |\n| 1 |\n\nafter");
    const i = requests.findIndex((r) => r.insertTable);
    expect(requests[i].insertTable?.location?.index).toBe(1);
    const after = requests.slice(i + 1);
    expect(after.some((r) => r.deleteContentRange)).toBe(false);
    expect(after.some((r) => r.updateTextStyle?.textStyle?.fontSize?.magnitude === 1)).toBe(true);
  });

  it("gives the paragraph under a table the tab's gap, not the top-of-tab zero; a heading keeps its own", () => {
    const { requests } = run("| a |\n| - |\n| 1 |\n\nafter", { ...top, tableGapPt: 8 });
    // Paragraph styles come before the index-shifting inserts; the stray's
    // own shrink (also 0pt at index 1) comes after the table insert.
    const beforeShifts = requests.slice(
      0,
      requests.findIndex((r) => r.insertTable),
    );
    const styles = beforeShifts
      .filter((r) => r.updateParagraphStyle?.paragraphStyle?.spaceAbove)
      .map((r) => [
        r.updateParagraphStyle!.range!.startIndex,
        r.updateParagraphStyle!.paragraphStyle!.spaceAbove!.magnitude,
      ]);
    // "after" is at 1 (the table shifts it later); it gets 8pt, never the 0pt top rule.
    expect(styles).toEqual([[1, 8]]);

    const heading = run("intro\n\n| a |\n| - |\n| 1 |\n\n## After");
    const h = heading.requests
      .slice(
        0,
        heading.requests.findIndex((r) => r.insertTable),
      )
      .filter((r) => r.updateParagraphStyle?.range?.startIndex === 7);
    expect(h.some((r) => r.updateParagraphStyle!.fields!.includes("spaceAbove"))).toBe(false);
  });

  it("phase 2 resets every cell before styling it, header bold included", () => {
    const { phase1 } = run("| h |\n| - |\n| **a** |\n| |");
    const content: docs_v1.Schema$StructuralElement[] = [
      { startIndex: 1, endIndex: 2, paragraph: {} },
      {
        startIndex: 2,
        endIndex: 20,
        table: {
          tableRows: [
            { tableCells: [{ content: [{ startIndex: 5 }] }] },
            { tableCells: [{ content: [{ startIndex: 8 }] }] },
            { tableCells: [{ content: [{ startIndex: 11 }] }] },
          ],
        },
      },
    ];
    const requests = phase2Requests(phase1, {
      tabId: TAB,
      ...locateTables(content, 1),
      footnoteIds: [],
    });
    const kinds = requests.map((r) =>
      r.insertText
        ? `insert@${r.insertText.location!.index}`
        : r.updateParagraphStyle
          ? `para@${r.updateParagraphStyle.range!.startIndex}`
          : r.updateTextStyle
            ? `${r.updateTextStyle.fields === "bold" ? "bold" : "reset"}@${r.updateTextStyle.range!.startIndex}`
            : "pin",
    );
    expect(kinds).toEqual([
      "para@11", // the empty cell: paragraph reset only
      "insert@8",
      "para@8",
      "reset@8",
      "bold@8",
      "insert@5",
      "para@5",
      "reset@5",
      "bold@5",
      "pin",
    ]);
  });
});

describe("markdown-to-doc: multi-line table cells (#106)", () => {
  const cellOf = (md: string, row = 1, col = 1) => {
    const { parsed } = run(md);
    const table = parsed.blocks.find((b) => b.kind === "table");
    if (!table || table.kind !== "table") throw new Error("no table");
    return { cell: table.rows[row][col], lossy: parsed.lossy };
  };
  const texts = (cell: { paragraphs: Array<{ inline: { runs: Array<{ text: string }> } }> }) =>
    cell.paragraphs.map((p) => p.inline.runs.map((r) => r.text).join(""));

  it("joins plain lines with a hard break in one paragraph, for every <br> spelling", () => {
    const { cell } = cellOf("| k | v |\n| - | - |\n| a | one<br>two<br/>three<br />four |");
    expect(texts(cell)).toEqual(["one\u000btwo\u000bthree\u000bfour"]);
    expect(cell.paragraphs[0].list).toBeUndefined();
  });

  it("makes a bulleted paragraph per item line and keeps inline styles", () => {
    const { cell, lossy } = cellOf(
      "| k | v |\n| - | - |\n| a | - [Brief](https://h/b)<br>- **Transcript**<br>- NEW: x |",
    );
    expect(texts(cell)).toEqual(["Brief", "Transcript", "NEW: x"]);
    expect(cell.paragraphs.map((p) => p.list)).toEqual(["bullet", "bullet", "bullet"]);
    expect(cell.paragraphs[0].inline.runs[0].style.link).toBe("https://h/b");
    expect(cell.paragraphs[1].inline.runs[0].style.bold).toBe(true);
    expect(lossy).toEqual([]);
  });

  it("mixes plain lines and items, and tells the three list kinds apart", () => {
    const { cell } = cellOf(
      "| k | v |\n| - | - |\n| a | intro<br>1. one<br>2) two<br>- [ ] task<br>outro |",
    );
    expect(texts(cell)).toEqual(["intro", "one", "two", "task", "outro"]);
    expect(cell.paragraphs.map((p) => p.list)).toEqual([
      undefined,
      "number",
      "number",
      "checkbox",
      undefined,
    ]);
  });

  it("flattens an indented item and discloses it; a checked task is disclosed too", () => {
    const { cell, lossy } = cellOf(
      "| k | v |\n| - | - |\n| a | - top<br>  - nested<br>- [x] done |",
    );
    expect(cell.paragraphs.map((p) => p.list)).toEqual(["bullet", "bullet", "checkbox"]);
    expect(lossy.map((l) => l.construct).sort()).toEqual([
      "checked_task",
      "table_cell_nested_list",
    ]);
  });

  it("phase 2 inserts the lines as one text and bullets each run of items", () => {
    const { phase1 } = run("| k | v |\n| - | - |\n| a | intro<br>- one<br>- two |");
    const content: docs_v1.Schema$StructuralElement[] = [
      { startIndex: 1, endIndex: 2, paragraph: {} },
      {
        startIndex: 2,
        endIndex: 40,
        table: {
          tableRows: [
            { tableCells: [{ content: [{ startIndex: 5 }] }, { content: [{ startIndex: 7 }] }] },
            { tableCells: [{ content: [{ startIndex: 10 }] }, { content: [{ startIndex: 12 }] }] },
          ],
        },
      },
    ];
    const requests = phase2Requests(phase1, {
      tabId: TAB,
      ...locateTables(content, 1),
      footnoteIds: [],
    });
    const first = requests[0].insertText!;
    expect(first).toEqual({ location: { index: 12, tabId: TAB }, text: "intro\none\ntwo" });
    const bullets = requests
      .filter((r) => r.createParagraphBullets)
      .map((r) => r.createParagraphBullets!);
    // "intro\n" is 6 chars: items span [18, 26) — "one\n" + "two" + the cell's own newline.
    expect(bullets).toEqual([
      {
        range: { startIndex: 18, endIndex: 26, tabId: TAB },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    ]);
    // The bullets request comes after that cell's styles and before the next cell's insert.
    const bulletAt = requests.findIndex((r) => r.createParagraphBullets);
    const nextInsert = requests.findIndex((r, i) => i > 0 && r.insertText);
    expect(bulletAt).toBeLessThan(nextInsert);
  });
});
