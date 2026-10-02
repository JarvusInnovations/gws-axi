import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseSkipArgs, planSkip } from "./skip.js";
import { extractSlideContent } from "./text.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

const deck = [
  { index: 1, page_id: "p1", title: "Intro", skipped: false },
  { index: 2, page_id: "p2", title: "Backup", skipped: true },
  { index: 3, page_id: "p3", title: "End", skipped: false },
];

describe("slides skip", () => {
  it("parses a deck and one or more page ids, deduplicated", () => {
    expect(parseSkipArgs(["D", "p1", "p3", "p1"], "skip")).toEqual({
      presentationId: "D",
      pageIds: ["p1", "p3"],
    });
    expect(code(() => parseSkipArgs(["D"], "skip"))).toBe("VALIDATION_ERROR");
    expect(code(() => parseSkipArgs([], "unskip"))).toBe("VALIDATION_ERROR");
    expect(code(() => parseSkipArgs(["D", "p1", "--force"], "skip"))).toBe("VALIDATION_ERROR");
  });

  it("writes only the slides not already in the requested state", () => {
    const plan = planSkip(
      deck.map((s) => ({ ...s })),
      ["p1", "p2"],
      true,
    );
    expect(plan.change.map((s) => s.page_id)).toEqual(["p1"]);
    expect(plan.named.map((s) => s.page_id)).toEqual(["p1", "p2"]);
    expect(planSkip(deck, ["p1", "p3"], false).change).toEqual([]);
  });

  it("reports unknown page ids", () => {
    expect(planSkip(deck, ["p9", "p1"], true).missing).toEqual(["p9"]);
  });

  it("reads isSkipped off the slide", () => {
    expect(
      extractSlideContent({ objectId: "x", slideProperties: { isSkipped: true } }, 0).skipped,
    ).toBe(true);
    expect(extractSlideContent({ objectId: "x" }, 0).skipped).toBe(false);
  });
});
