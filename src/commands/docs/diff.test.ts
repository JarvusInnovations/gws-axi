import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { computeDiff, parseFlags } from "./diff.js";

describe("docs diff parseFlags", () => {
  it("parses fileId + two revisions", () => {
    const f = parseFlags(["1Kc9mv", "841", "865"]);
    expect(f.fileId).toBe("1Kc9mv");
    expect(f.revA).toBe("841");
    expect(f.revB).toBe("865");
    expect(f.full).toBe(false);
    expect(f.out).toBeUndefined();
  });

  it("leaves revB undefined when only one revision is given (defaults to head later)", () => {
    const f = parseFlags(["1Kc9mv", "841"]);
    expect(f.revA).toBe("841");
    expect(f.revB).toBeUndefined();
  });

  it("parses --full and --out (--out implies --full)", () => {
    const f = parseFlags(["1Kc9mv", "841", "865", "--out", "./c.diff"]);
    expect(f.out).toBe("./c.diff");
    expect(f.full).toBe(true);
  });

  it("preserves argument order — does not reorder revisions", () => {
    const f = parseFlags(["1Kc9mv", "865", "841"]);
    expect(f.revA).toBe("865");
    expect(f.revB).toBe("841");
  });

  it("throws VALIDATION_ERROR with no revision", () => {
    try {
      parseFlags(["1Kc9mv"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("throws VALIDATION_ERROR with no fileId", () => {
    try {
      parseFlags(["--full"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("docs diff computeDiff", () => {
  it("counts added and removed lines", () => {
    const a = "one\ntwo\nthree\n";
    const b = "one\ntwo\nthree\nfour\nfive\n";
    const r = computeDiff("rA", "rB", a, b);
    expect(r.changed).toBe(true);
    expect(r.linesAdded).toBe(2);
    expect(r.linesRemoved).toBe(0);
    expect(r.unified).toContain("rA");
    expect(r.unified).toContain("rB");
  });

  it("counts a replacement as both removed and added", () => {
    const a = "alpha\nbeta\ngamma\n";
    const b = "alpha\nBETA\ngamma\n";
    const r = computeDiff("rA", "rB", a, b);
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(1);
  });

  it("reports changed=false for identical text", () => {
    const same = "no change here\n";
    const r = computeDiff("rA", "rB", same, same);
    expect(r.changed).toBe(false);
    expect(r.linesAdded).toBe(0);
    expect(r.linesRemoved).toBe(0);
  });

  it("respects argument order (reverse is the inverse diff)", () => {
    const a = "one\ntwo\n";
    const b = "one\ntwo\nthree\n";
    const forward = computeDiff("rA", "rB", a, b);
    const reverse = computeDiff("rB", "rA", b, a);
    expect(forward.linesAdded).toBe(1);
    expect(forward.linesRemoved).toBe(0);
    expect(reverse.linesAdded).toBe(0);
    expect(reverse.linesRemoved).toBe(1);
  });
});
