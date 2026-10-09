import { describe, expect, it } from "vitest";
import { flattenTabSummaries } from "./tabs.js";

describe("flattenTabSummaries", () => {
  it("returns [] for a doc with no tabs reported", () => {
    expect(flattenTabSummaries(undefined)).toEqual([]);
    expect(flattenTabSummaries([])).toEqual([]);
  });

  it("flattens root tabs in order", () => {
    const tabs = [
      { tabProperties: { tabId: "t.0", title: "Tab 1" } },
      { tabProperties: { tabId: "t.a", title: "Tab Two" } },
    ];
    expect(flattenTabSummaries(tabs)).toEqual([
      { id: "t.0", title: "Tab 1" },
      { id: "t.a", title: "Tab Two" },
    ]);
  });

  it("counts nested child tabs — one root with a child is still multi-tab", () => {
    const tabs = [
      {
        tabProperties: { tabId: "t.0", title: "Root" },
        childTabs: [
          {
            tabProperties: { tabId: "t.c", title: "Child" },
            childTabs: [{ tabProperties: { tabId: "t.g", title: "Grandchild" } }],
          },
        ],
      },
    ];
    const flat = flattenTabSummaries(tabs);
    expect(flat.map((t) => t.id)).toEqual(["t.0", "t.c", "t.g"]);
    expect(flat.length).toBeGreaterThan(1);
  });

  it("tolerates missing tabProperties without dropping the tab from the count", () => {
    expect(flattenTabSummaries([{}, { tabProperties: {} }])).toEqual([
      { id: "", title: "" },
      { id: "", title: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Placement (specs/commands/docs-tabs.md § docs tabs update)

import { descendantIds, flattenTabInfos, resolvePlacement, type TabInfo } from "./tabs.js";
import type { AxiError } from "axi-sdk-js";

/** Root: A, B(child: B1, B2(child: B2a)), C, D */
const TREE: TabInfo[] = [
  { id: "A", title: "A", index: 0, parent: "", emoji: "" },
  { id: "B", title: "B", index: 1, parent: "", emoji: "📝" },
  { id: "B1", title: "B1", index: 0, parent: "B", emoji: "" },
  { id: "B2", title: "B2", index: 1, parent: "B", emoji: "" },
  { id: "B2a", title: "B2a", index: 0, parent: "B2", emoji: "" },
  { id: "C", title: "C", index: 2, parent: "", emoji: "" },
  { id: "D", title: "D", index: 3, parent: "", emoji: "" },
];
const tab = (id: string) => TREE.find((t) => t.id === id)!;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("flattenTabInfos", () => {
  it("carries index, parent and emoji depth-first in document order", () => {
    const flat = flattenTabInfos([
      { tabProperties: { tabId: "t.0", title: "Root", index: 0, iconEmoji: "📝" } },
      {
        tabProperties: { tabId: "t.p", title: "Parent", index: 1 },
        childTabs: [
          { tabProperties: { tabId: "t.c", title: "Child", index: 0, parentTabId: "t.p" } },
        ],
      },
    ]);
    expect(flat).toEqual([
      { id: "t.0", title: "Root", index: 0, parent: "", emoji: "📝" },
      { id: "t.p", title: "Parent", index: 1, parent: "", emoji: "" },
      { id: "t.c", title: "Child", index: 0, parent: "t.p", emoji: "" },
    ]);
  });
});

describe("descendantIds", () => {
  it("walks every level", () => {
    expect(descendantIds(TREE, "B")).toEqual(["B1", "B2", "B2a"]);
    expect(descendantIds(TREE, "C")).toEqual([]);
  });
});

describe("resolvePlacement — new tab (no moving tab)", () => {
  it("--first is index 0 at the top level; --last is the root count", () => {
    expect(resolvePlacement({ first: true }, TREE)).toEqual({ parent: "", index: 0 });
    expect(resolvePlacement({ last: true }, TREE)).toEqual({ parent: "", index: 4 });
  });

  it("--before/--after take the anchor's parent and index", () => {
    expect(resolvePlacement({ before: "C" }, TREE)).toEqual({ parent: "", index: 2 });
    expect(resolvePlacement({ after: "C" }, TREE)).toEqual({ parent: "", index: 3 });
    expect(resolvePlacement({ after: "B1" }, TREE)).toEqual({ parent: "B", index: 1 });
  });

  it("--under is the last child unless --first", () => {
    expect(resolvePlacement({ under: "B" }, TREE)).toEqual({ parent: "B", index: 2 });
    expect(resolvePlacement({ under: "B", first: true }, TREE)).toEqual({ parent: "B", index: 0 });
    expect(resolvePlacement({ under: "C" }, TREE)).toEqual({ parent: "C", index: 0 });
  });

  it("an unknown anchor is TAB_NOT_FOUND", () => {
    expect(codeOf(() => resolvePlacement({ before: "nope" }, TREE))).toBe("TAB_NOT_FOUND");
    expect(codeOf(() => resolvePlacement({ under: "nope" }, TREE))).toBe("TAB_NOT_FOUND");
  });
});

describe("resolvePlacement — moving an existing tab", () => {
  it("sends the upstream index with no direction adjustment", () => {
    // [A,B,C,D]: A --after C → index 3 (insert before D, then A's old slot goes) → [B,C,A,D]
    expect(resolvePlacement({ after: "C" }, TREE, tab("A"))).toEqual({ parent: "", index: 3 });
    // D --before B → index 1 → [A,D,B,C]
    expect(resolvePlacement({ before: "B" }, TREE, tab("D"))).toEqual({ parent: "", index: 1 });
  });

  it("--last counts the moving tab when it is already in that parent", () => {
    expect(resolvePlacement({ last: true }, TREE, tab("A"))).toEqual({ parent: "", index: 4 });
    // Into another parent: that parent's count, the mover not among them.
    expect(resolvePlacement({ under: "B" }, TREE, tab("A"))).toEqual({ parent: "B", index: 2 });
  });

  it("reports unchanged when the tab is already there", () => {
    expect(resolvePlacement({ first: true }, TREE, tab("A"))).toBe("unchanged");
    expect(resolvePlacement({ last: true }, TREE, tab("D"))).toBe("unchanged");
    expect(resolvePlacement({ before: "B" }, TREE, tab("A"))).toBe("unchanged");
    expect(resolvePlacement({ after: "A" }, TREE, tab("B"))).toBe("unchanged");
    expect(resolvePlacement({ last: true, under: "B" }, TREE, tab("B2"))).toBe("unchanged");
  });

  it("--first/--last keep the current parent; --top-level un-nests", () => {
    expect(resolvePlacement({ first: true }, TREE, tab("B2"))).toEqual({ parent: "B", index: 0 });
    expect(resolvePlacement({ topLevel: true }, TREE, tab("B2"))).toEqual({ parent: "", index: 4 });
    expect(resolvePlacement({ topLevel: true, first: true }, TREE, tab("B2"))).toEqual({
      parent: "",
      index: 0,
    });
    // --after a root tab un-nests too.
    expect(resolvePlacement({ after: "C" }, TREE, tab("B2a"))).toEqual({ parent: "", index: 3 });
  });

  it("refuses the tab itself or its own subtree as anchor or parent", () => {
    expect(codeOf(() => resolvePlacement({ under: "B2" }, TREE, tab("B")))).toBe("TAB_CYCLE");
    expect(codeOf(() => resolvePlacement({ under: "B2a" }, TREE, tab("B")))).toBe("TAB_CYCLE");
    expect(codeOf(() => resolvePlacement({ after: "B1" }, TREE, tab("B")))).toBe("TAB_CYCLE");
    expect(codeOf(() => resolvePlacement({ before: "B" }, TREE, tab("B")))).toBe("TAB_CYCLE");
    // A sibling's subtree is fine.
    expect(resolvePlacement({ under: "B2" }, TREE, tab("C"))).toEqual({ parent: "B2", index: 1 });
  });
});
