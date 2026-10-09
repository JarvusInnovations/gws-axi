import { describe, expect, it } from "vitest";
import type { AxiError } from "axi-sdk-js";
import type { docs_v1 } from "googleapis";
import { collectMatches } from "./find.js";
import { parseReplaceFlags } from "./replace-text.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const para = (start: number, ...runs: string[]): docs_v1.Schema$StructuralElement => {
  let at = start;
  const elements = runs.map((content) => {
    const el = { startIndex: at, textRun: { content } };
    at += content.length;
    return el;
  });
  return { startIndex: start, endIndex: at, paragraph: { elements } };
};

describe("collectMatches", () => {
  it("walks table cells and numbers paragraphs in walk order", () => {
    const elements: docs_v1.Schema$StructuralElement[] = [
      para(1, "Status: Generating\n"),
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [para(25, "Round\n")] },
                { content: [para(32, "Generating\n")] },
              ],
            },
          ],
        },
      },
      para(50, "after\n"),
    ];
    const hits = collectMatches(elements, "Generating", { matchCase: true });
    expect(hits.map((m) => [m.paragraph, m.start])).toEqual([
      [0, 9],
      [2, 32],
    ]);
  });

  it("matches across a style boundary once, and honors matchCase", () => {
    const elements = [para(1, "Gen", "erating", " now\n")];
    expect(collectMatches(elements, "Generating", { matchCase: true })).toHaveLength(1);
    expect(collectMatches(elements, "generating", { matchCase: true })).toHaveLength(0);
    expect(collectMatches(elements, "generating", { matchCase: false })).toHaveLength(1);
    expect(collectMatches(elements, "generating", { matchCase: false })[0].start).toBe(1);
  });

  it("stops at the limit", () => {
    const elements = [para(1, "a a a a\n")];
    expect(collectMatches(elements, "a", { matchCase: true, limit: 2 })).toHaveLength(2);
    expect(collectMatches(elements, "a", { matchCase: true })).toHaveLength(4);
  });
});

describe("docs replace-text flag parsing", () => {
  it("parses the full form", () => {
    expect(
      parseReplaceFlags([
        "1Doc",
        "--find",
        "a",
        "--replace",
        "b",
        "--tab",
        "t.1",
        "--all",
        "--ignore-case",
      ]),
    ).toEqual({
      documentId: "1Doc",
      find: "a",
      replace: "b",
      tab: "t.1",
      all: true,
      ignoreCase: true,
    });
  });

  it("allows an empty --replace but not an empty --find", () => {
    expect(parseReplaceFlags(["1Doc", "--find", "a", "--replace", ""]).replace).toBe("");
    expect(codeOf(() => parseReplaceFlags(["1Doc", "--find", "", "--replace", "b"]))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("requires the document id and both texts", () => {
    expect(codeOf(() => parseReplaceFlags(["--find", "a", "--replace", "b"]))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => parseReplaceFlags(["1Doc", "--find", "a"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseReplaceFlags(["1Doc", "--replace", "b"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseReplaceFlags(["1Doc", "x", "--find", "a", "--replace", "b"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
});
