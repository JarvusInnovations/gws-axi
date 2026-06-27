import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseFlags, driveMkdirCommand } from "./mkdir.js";

describe("drive mkdir parseFlags", () => {
  it("parses a bare name with no parent", () => {
    const f = parseFlags(["Reports"]);
    expect(f.name).toBe("Reports");
    expect(f.parent).toBeUndefined();
  });

  it("parses a quoted multi-word name and --parent", () => {
    const f = parseFlags(["Q2 Reports", "--parent", "1AbC"]);
    expect(f.name).toBe("Q2 Reports");
    expect(f.parent).toBe("1AbC");
  });

  it("takes the first positional as the name, ignoring later ones", () => {
    const f = parseFlags(["first", "second"]);
    expect(f.name).toBe("first");
  });

  it("leaves name undefined when only flags are given", () => {
    const f = parseFlags(["--parent", "1AbC"]);
    expect(f.name).toBeUndefined();
    expect(f.parent).toBe("1AbC");
  });
});

describe("drive mkdir command validation", () => {
  it("throws VALIDATION_ERROR when the name is missing", async () => {
    await expect(driveMkdirCommand("a@b.com", ["--parent", "1AbC"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects with an AxiError (not a raw throw) on missing name", async () => {
    try {
      await driveMkdirCommand("a@b.com", []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});
