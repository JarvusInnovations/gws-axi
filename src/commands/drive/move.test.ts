import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseIdOnly, parseMoveFlags, wouldContainItself, type DriveReads } from "./move.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

/** A folder tree as child → parent. */
function tree(parents: Record<string, string>): DriveReads & { calls: number } {
  const reads = {
    calls: 0,
    async get(fileId: string) {
      reads.calls++;
      return { id: fileId, parents: parents[fileId] ? [parents[fileId]] : [] };
    },
  };
  return reads;
}

describe("drive move flags", () => {
  it("parses an id and --to", () => {
    expect(parseMoveFlags(["1A", "--to", "1F"])).toEqual({ fileId: "1A", to: "1F" });
  });
  it("requires one id and --to", () => {
    expect(code(() => parseMoveFlags(["--to", "1F"]))).toBe("VALIDATION_ERROR");
    expect(code(() => parseMoveFlags(["1A", "1B", "--to", "1F"]))).toBe("VALIDATION_ERROR");
    expect(code(() => parseMoveFlags(["1A"]))).toBe("VALIDATION_ERROR");
  });
  it("rejects unknown flags", () => {
    expect(code(() => parseMoveFlags(["1A", "--to", "1F", "--parent", "x"]))).toBe(
      "VALIDATION_ERROR",
    );
  });
  it("trash and untrash take exactly one id", () => {
    expect(parseIdOnly(["1A"], "drive trash")).toBe("1A");
    expect(code(() => parseIdOnly([], "drive trash"))).toBe("VALIDATION_ERROR");
    expect(code(() => parseIdOnly(["1A", "1B"], "drive untrash"))).toBe("VALIDATION_ERROR");
  });
});

describe("moving a folder into itself", () => {
  // root ← A ← B ← C
  const parents = { A: "root", B: "A", C: "B" };

  it("refuses the folder itself and anything beneath it", async () => {
    expect(await wouldContainItself(tree(parents), "A", "A")).toBe(true);
    expect(await wouldContainItself(tree(parents), "A", "C")).toBe(true);
  });

  it("allows a target outside the folder", async () => {
    expect(await wouldContainItself(tree(parents), "B", "A")).toBe(false);
    expect(await wouldContainItself(tree(parents), "C", "root")).toBe(false);
  });

  it("stops on a cyclic or very deep chain", async () => {
    const reads = tree({ X: "Y", Y: "X" });
    expect(await wouldContainItself(reads, "Z", "X")).toBe(false);
    expect(reads.calls).toBe(20);
  });
});
