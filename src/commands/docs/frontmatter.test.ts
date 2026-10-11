import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import { frontmatterTableMarkdown, selectRows, splitFrontmatter } from "./frontmatter.js";
import { prepareSource } from "./write.js";
import { parseWriteFlags } from "./write.js";
import { phase1Requests, phase2Requests } from "./md-to-doc.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const SAMPLE = `---
type: field-guide
title: "Save the Academy: Field Guide"
version: 1.0
from:
  version: v1
  note: |
    two
    lines
tags: [a, b]
authors:
  - name: Ada
    role: editor
empty:
pipe: a|b
---
# Body
`;

describe("splitFrontmatter (specs/behaviors/markdown-to-doc.md § Frontmatter)", () => {
  it("splits a leading YAML mapping, counting top-level keys and flattening leaves", () => {
    const fm = splitFrontmatter(SAMPLE)!;
    expect(fm.body).toBe("# Body\n");
    expect(fm.keys).toBe(8);
    expect(fm.rows).toEqual([
      { label: "type", value: "field-guide" },
      { label: "title", value: "Save the Academy: Field Guide" },
      { label: "version", value: "1.0" },
      { label: "from.version", value: "v1" },
      { label: "from.note", value: "two<br>lines" },
      { label: "tags", value: "a<br>b" },
      { label: "authors", value: "name: Ada, role: editor" },
      { label: "empty", value: "" },
      { label: "pipe", value: "a\\|b" },
    ]);
  });

  it("accepts `...` as the closing line and a byte-order mark", () => {
    expect(splitFrontmatter("﻿---\na: 1\n...\nbody")?.body).toBe("body");
  });

  it("leaves anything that isn't a leading mapping to the Markdown", () => {
    expect(splitFrontmatter("---\nan intro sentence\n---\nbody")).toBeUndefined();
    expect(splitFrontmatter("---\n- a\n- b\n---\nbody")).toBeUndefined();
    expect(splitFrontmatter("---\n# only a comment\n---\nbody")).toBeUndefined();
    expect(splitFrontmatter("---\n---\nbody")).toBeUndefined();
    expect(splitFrontmatter("---\na: 1\nno closing line")).toBeUndefined();
    expect(splitFrontmatter("intro\n\n---\na: 1\n---\n")).toBeUndefined();
  });

  it("refuses a block that isn't valid YAML", () => {
    expect(codeOf(() => splitFrontmatter("---\na: b: c\n---\nbody"))).toBe("VALIDATION_ERROR");
  });
});

describe("frontmatter rows and table", () => {
  const rows = splitFrontmatter(SAMPLE)!.rows;

  it("selects keys in the given order, a mapping key taking every leaf under it", () => {
    expect(selectRows(rows, ["title", "from"]).map((r) => r.label)).toEqual([
      "title",
      "from.version",
      "from.note",
    ]);
    expect(codeOf(() => selectRows(rows, ["title", "nope"]))).toBe("VALIDATION_ERROR");
  });

  it("writes a fitted label/value table with bold labels", () => {
    expect(frontmatterTableMarkdown(selectRows(rows, ["type", "pipe"]))).toBe(
      "<!-- cols: fit 1 -->\n| **type** | field-guide |\n| --- | --- |\n| **pipe** | a\\|b |",
    );
  });
});

describe("prepareSource and the writers' flags", () => {
  it("strips by default and says how many keys", () => {
    const p = prepareSource(SAMPLE, "strip");
    expect(p.frontmatter).toBe("stripped (8 keys)");
    expect(p.parsed.blocks).toHaveLength(1);
  });

  it("keeps it as text when asked, and says nothing when there is none", () => {
    expect(prepareSource(SAMPLE, "keep").frontmatter).toBe("kept as text");
    expect(prepareSource(SAMPLE, "keep").parsed.blocks.length).toBeGreaterThan(1);
    expect(prepareSource("# Just a body", "strip").frontmatter).toBeUndefined();
  });

  it("writes a table with no header row: not pinned, labels bold by their own Markdown", () => {
    const p = prepareSource(SAMPLE, "table", ["type", "title"]);
    expect(p.frontmatter).toBe("table (2 rows)");
    const table = p.parsed.blocks[0];
    expect(table.kind === "table" && table.headerRows).toBe(0);
    const phase1 = phase1Requests(p.parsed.blocks, {
      tabId: "t",
      base: 1,
      emptyTab: true,
      atTop: true,
    });
    const requests = phase2Requests(phase1, {
      tabId: "t",
      tableStarts: [2],
      tableCells: [
        [
          [10, 20],
          [30, 40],
        ],
      ],
      footnoteIds: [],
    });
    expect(requests.some((r) => r.pinTableHeaderRows)).toBe(false);
    const bold = requests
      .filter((r) => r.updateTextStyle?.textStyle?.bold)
      .map((r) => r.updateTextStyle!.range!.startIndex);
    expect(bold.sort()).toEqual([10, 30]);
  });

  it("treats an empty body after stripping as empty", () => {
    expect(prepareSource("---\na: 1\n---\n", "strip").empty).toBe(true);
  });

  it("validates --frontmatter and --frontmatter-keys", () => {
    expect(parseWriteFlags(["1Doc", "--content", "x"], "write").frontmatter).toBe("strip");
    expect(
      parseWriteFlags(
        ["1Doc", "--content", "x", "--frontmatter", "table", "--frontmatter-keys", "a, b.c"],
        "write",
      ).frontmatterKeys,
    ).toEqual(["a", "b.c"]);
    expect(
      codeOf(() => parseWriteFlags(["1Doc", "--content", "x", "--frontmatter", "drop"], "write")),
    ).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() =>
        parseWriteFlags(["1Doc", "--content", "x", "--frontmatter-keys", "a"], "append"),
      ),
    ).toBe("VALIDATION_ERROR");
  });
});
