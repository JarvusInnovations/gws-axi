import { describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

/** The dispatcher re-renders a TAB_REQUIRED listing with each tab's row1. */

const get = vi.fn();
vi.mock("../google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../google/client.js")>()),
  sheetsClient: async () => ({ spreadsheets: { get } }),
}));

const { withRow1 } = await import("./sheets.js");
const { requireTab } = await import("./sheets/shared.js");

const tab = (gid: number, title: string) => ({
  gid,
  title,
  index: gid,
  rows: 10,
  cols: 4,
  frozenRows: 0,
});
const meta = {
  id: "1AbC",
  title: "T",
  tabs: [tab(0, "Costs"), tab(7, "Notes")],
  otherTitles: [],
  namedRanges: [],
};

function tabRequired(): unknown {
  try {
    requireTab(meta, undefined, (t) => `gws-axi sheets query 1AbC 'select A' --tab ${t}`, {
      read: true,
    });
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("withRow1", () => {
  it("re-renders the listing with row1 and keeps the other suggestions", async () => {
    get.mockResolvedValueOnce({
      data: {
        sheets: [
          {
            properties: { sheetId: 0 },
            data: [{ rowData: [{ values: [{ formattedValue: "Item" }] }] }],
          },
          {
            properties: { sheetId: 7 },
            data: [{ rowData: [{ values: [{ formattedValue: "Note" }] }] }],
          },
        ],
      },
    });
    const out = (await withRow1(tabRequired(), "alice@example.com")) as AxiError;
    expect(out.code).toBe("TAB_REQUIRED");
    expect(out.suggestions[0]).toContain("sheets[2]{gid,title,index,rows,cols,row1}:");
    expect(out.suggestions[0]).toContain("0,Costs,0,10,4,Item");
    expect(out.suggestions[1]).toContain("--tab Costs");
  });

  it("returns the original error when the fetch fails, and passes other errors through", async () => {
    get.mockRejectedValueOnce(new Error("boom"));
    const original = tabRequired() as AxiError;
    expect(await withRow1(original, "alice@example.com")).toBe(original);
    const other = new AxiError("x", "TAB_NOT_FOUND", []);
    expect(await withRow1(other, "alice@example.com")).toBe(other);
  });
});
