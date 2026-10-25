import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseAddTabFlags, placementIndex, rollBack } from "./add-tab.js";
import { parseCreateFlags } from "./create.js";
import type { SpreadsheetMeta } from "./shared.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const meta: SpreadsheetMeta = {
  id: "1AbC",
  title: "T",
  tabs: [
    { gid: 0, title: "A", index: 0, rows: 1, cols: 1, frozenRows: 0 },
    { gid: 5, title: "B", index: 1, rows: 1, cols: 1, frozenRows: 0 },
  ],
  otherTitles: ["Chart"],
  namedRanges: [],
};

describe("add-tab placement", () => {
  it("maps each flag to addSheet's index", () => {
    expect(placementIndex(meta, { kind: "first" })).toBe(0);
    expect(placementIndex(meta, { kind: "last" })).toBe(3);
    expect(placementIndex(meta, { kind: "before", anchor: "B" })).toBe(1);
    expect(placementIndex(meta, { kind: "after", anchor: "A" })).toBe(1);
    expect(placementIndex(meta, { kind: "after", anchor: "5" })).toBe(2);
  });
  it("refuses an anchor that names no tab", () => {
    expect(codeOf(() => placementIndex(meta, { kind: "before", anchor: "Z" }))).toBe(
      "TAB_NOT_FOUND",
    );
  });
  it("refuses conflicting placement flags and defaults to last", () => {
    expect(
      codeOf(() => parseAddTabFlags(["1AbC", "--title", "C", "--first", "--after", "A"])),
    ).toBe("VALIDATION_ERROR");
    expect(parseAddTabFlags(["1AbC", "--title", "C"]).placement).toEqual({ kind: "last" });
  });
  it("needs --title, and a block for --header", () => {
    expect(codeOf(() => parseAddTabFlags(["1AbC"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseAddTabFlags(["1AbC", "--title", "C", "--header"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("add-tab rollback", () => {
  const cause = new AxiError(
    "Your input contains more than the maximum of 50000 characters",
    "GOOGLE_API_ERROR_400",
    ["x"],
  );
  it("deletes the tab and says so, keeping the seed's error code", async () => {
    let deleted = false;
    const e = await rollBack(
      async () => {
        deleted = true;
      },
      { spreadsheetId: "1AbC", gid: 9, title: "C", account: "alice@example.com" },
      cause,
    );
    expect(deleted).toBe(true);
    expect(e.code).toBe("GOOGLE_API_ERROR_400");
    expect(e.message).toContain("deleted again");
  });
  it("is WRITE_INCOMPLETE, naming the tab, when the delete fails too", async () => {
    const e = await rollBack(
      async () => {
        throw new Error("boom");
      },
      { spreadsheetId: "1AbC", gid: 9, title: "C", account: "alice@example.com" },
      cause,
    );
    expect(e.code).toBe("WRITE_INCOMPLETE");
    expect(e.message).toContain("'C' (gid 9)");
  });
});

describe("create flags", () => {
  it("collects repeated --tab titles in order", () => {
    expect(parseCreateFlags(["--title", "T", "--tab", "A", "--tab", "B"]).tabs).toEqual(["A", "B"]);
  });
  it("compares tab titles ignoring case, as upstream does", () => {
    expect(
      codeOf(() => parseCreateFlags(["--title", "T", "--tab", "Costs", "--tab", "costs"])),
    ).toBe("VALIDATION_ERROR");
  });
  it("refuses duplicate tab titles, a missing --title and --header with no block", () => {
    expect(codeOf(() => parseCreateFlags(["--title", "T", "--tab", "A", "--tab", "A"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseCreateFlags(["--tab", "A"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseCreateFlags(["--title", "T", "--header"]))).toBe("VALIDATION_ERROR");
  });
  it("makes the block optional", () => {
    expect(parseCreateFlags(["--title", "T"]).localPath).toBeUndefined();
  });
});
