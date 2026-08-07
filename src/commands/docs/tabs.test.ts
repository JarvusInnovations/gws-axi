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
