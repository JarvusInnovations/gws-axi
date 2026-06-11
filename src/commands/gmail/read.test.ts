import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseFlags } from "./read.js";

describe("gmail read parseFlags", () => {
  it("parses a bare id with defaults", () => {
    const f = parseFlags(["19eb74eab3cffbdc"]);
    expect(f.id).toBe("19eb74eab3cffbdc");
    expect(f.headers).toBe(false);
    expect(f.raw).toBe(false);
    expect(f.full).toBe(false);
    expect(f.messageOnly).toBe(false);
    expect(f.out).toBeUndefined();
  });

  it("parses --headers", () => {
    const f = parseFlags(["abc", "--headers"]);
    expect(f.headers).toBe(true);
    expect(f.raw).toBe(false);
  });

  it("parses --raw", () => {
    const f = parseFlags(["abc", "--raw"]);
    expect(f.raw).toBe(true);
    expect(f.headers).toBe(false);
  });

  it("--out implies --full", () => {
    const f = parseFlags(["abc", "--out", "./t.md"]);
    expect(f.out).toBe("./t.md");
    expect(f.full).toBe(true);
  });

  it("--raw with --out keeps both (raw source to file)", () => {
    const f = parseFlags(["abc", "--raw", "--out", "./m.eml"]);
    expect(f.raw).toBe(true);
    expect(f.out).toBe("./m.eml");
  });

  it("rejects --raw and --headers together with VALIDATION_ERROR", () => {
    expect(() => parseFlags(["abc", "--raw", "--headers"])).toThrowError(
      AxiError,
    );
    try {
      parseFlags(["abc", "--raw", "--headers"]);
    } catch (err) {
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("throws VALIDATION_ERROR when id is missing", () => {
    try {
      parseFlags(["--headers"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});
