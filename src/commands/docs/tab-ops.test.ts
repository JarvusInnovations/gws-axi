import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import { parseUpdateFlags, docsTabsCommand } from "./tab-ops.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("docs tabs update flag parsing", () => {
  it("parses every property flag together", () => {
    const f = parseUpdateFlags([
      "1Doc",
      "t.1",
      "--title",
      "Final",
      "--emoji",
      "✅",
      "--first",
      "--under",
      "t.0",
    ]);
    expect(f).toEqual({
      documentId: "1Doc",
      tabId: "t.1",
      title: "Final",
      emoji: "✅",
      placement: { first: true, under: "t.0" },
    });
  });

  it("--no-emoji is an empty emoji; with --emoji it is refused", () => {
    expect(parseUpdateFlags(["1Doc", "t.1", "--no-emoji"]).emoji).toBe("");
    expect(codeOf(() => parseUpdateFlags(["1Doc", "t.1", "--no-emoji", "--emoji", "x"]))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("requires both ids, a non-empty title, and at least one property", () => {
    expect(codeOf(() => parseUpdateFlags(["1Doc", "--first"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseUpdateFlags(["1Doc", "t.1", "--title", " "]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseUpdateFlags(["1Doc", "t.1"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseUpdateFlags(["1Doc", "t.1", "extra", "--first"]))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses --under with --before, and --under with --top-level", () => {
    expect(
      codeOf(() => parseUpdateFlags(["1Doc", "t.1", "--under", "t.0", "--before", "t.2"])),
    ).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseUpdateFlags(["1Doc", "t.1", "--under", "t.0", "--top-level"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("docs tabs listing arguments", () => {
  it("treats a bare lowercase word as a guessed verb, not a document id", async () => {
    let err: AxiError | undefined;
    try {
      await docsTabsCommand("a@b.com", ["move"]);
    } catch (e) {
      err = e as AxiError;
    }
    expect(err?.code).toBe("VALIDATION_ERROR");
    expect(err?.message).toContain("move");
    expect(err?.suggestions?.join("\n")).toContain("update, delete");
  });

  it("requires a document id", async () => {
    let code = "none";
    try {
      await docsTabsCommand("a@b.com", []);
    } catch (e) {
      code = (e as AxiError).code;
    }
    expect(code).toBe("VALIDATION_ERROR");
  });
});
