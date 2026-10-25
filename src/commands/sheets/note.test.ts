import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { noteArg, parseNoteFlags, planNote, undoCommand } from "./note.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as AxiError;
    return [e.message, ...(e.suggestions ?? [])].join("\n");
  }
  return "";
}

describe("parseNoteFlags", () => {
  it("takes one cell with --text", () => {
    expect(parseNoteFlags(["1AbC", "b$2", "--text", "estimate"])).toEqual({
      spreadsheetId: "1AbC",
      cell: "B2",
      cellTab: undefined,
      tab: undefined,
      text: "estimate",
    });
  });
  it("splits a tab-qualified cell and takes --clear", () => {
    const flags = parseNoteFlags(["1AbC", "'My Tab'!C3", "--clear", "--tab", "My Tab"]);
    expect(flags.cell).toBe("C3");
    expect(flags.cellTab).toBe("My Tab");
    expect(flags.tab).toBe("My Tab");
    expect(flags.text).toBeUndefined();
  });
  it("keeps newlines in the text", () => {
    expect(parseNoteFlags(["1AbC", "B2", "--text", "one\ntwo"]).text).toBe("one\ntwo");
  });
  it("refuses neither and both of --text / --clear", () => {
    expect(codeOf(() => parseNoteFlags(["1AbC", "B2"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseNoteFlags(["1AbC", "B2", "--text", "x", "--clear"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("refuses an empty --text and points at --clear", () => {
    const run = () => parseNoteFlags(["1AbC", "B2", "--text", ""]);
    expect(codeOf(run)).toBe("VALIDATION_ERROR");
    expect(messageOf(run)).toContain("--clear");
  });
  it("refuses a range, and a non-A1 cell as RANGE_INVALID", () => {
    expect(codeOf(() => parseNoteFlags(["1AbC", "B2:C3", "--text", "x"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseNoteFlags(["1AbC", "B:B", "--text", "x"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseNoteFlags(["1AbC", "Totals", "--text", "x"]))).toBe("RANGE_INVALID");
  });
  it("refuses a missing cell, an extra positional and an unknown flag", () => {
    expect(codeOf(() => parseNoteFlags(["1AbC", "--clear"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseNoteFlags(["1AbC", "B2", "two", "--clear"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseNoteFlags(["1AbC", "B2", "--note", "x"]))).toBe("VALIDATION_ERROR");
  });
});

describe("planNote", () => {
  it("sets a note on a cell with none, and replaces one", () => {
    expect(planNote("", "estimate")).toEqual({ action: "set", after: "estimate" });
    expect(planNote("estimate", "source: Q3")).toEqual({ action: "set", after: "source: Q3" });
  });
  it("clears an existing note", () => {
    expect(planNote("estimate", undefined)).toEqual({ action: "cleared", after: "" });
  });
  it("is unchanged for the same text, and for --clear with no note", () => {
    expect(planNote("estimate", "estimate").action).toBe("unchanged");
    expect(planNote("", undefined).action).toBe("unchanged");
  });
  it("compares exactly — case and whitespace count", () => {
    expect(planNote("estimate", "Estimate").action).toBe("set");
    expect(planNote("estimate", "estimate ").action).toBe("set");
  });
});

describe("undo", () => {
  it("restores the previous text, single-quoted", () => {
    expect(undoCommand("1AbC", "B2", "Costs", "it's an estimate", "alice@example.com")).toBe(
      "gws-axi sheets note 1AbC B2 --tab Costs --text 'it'\\''s an estimate' --account alice@example.com",
    );
  });
  it("clears when there was no note", () => {
    expect(undoCommand("1AbC", "B2", "My Tab", "", "alice@example.com")).toBe(
      "gws-axi sheets note 1AbC B2 --tab 'My Tab' --clear --account alice@example.com",
    );
  });
  it("keeps a multi-line note on one line with $'…'", () => {
    expect(noteArg("one\ntwo 'q' \\")).toBe("$'one\\ntwo \\'q\\' \\\\'");
    expect(noteArg("one\ntwo")).not.toContain("\n");
  });
});
