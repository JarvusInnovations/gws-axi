import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseFlags } from "./download.js";

describe("docs download parseFlags", () => {
  it("parses a bare documentId with defaults", () => {
    const f = parseFlags(["1RxHZ"]);
    expect(f.documentId).toBe("1RxHZ");
    expect(f.out).toBeUndefined();
    expect(f.as).toBeUndefined();
    expect(f.revision).toBeUndefined();
  });

  it("parses --revision", () => {
    const f = parseFlags(["1RxHZ", "--revision", "250"]);
    expect(f.revision).toBe("250");
  });

  it("parses --revision with --as and --out together", () => {
    const f = parseFlags([
      "1RxHZ",
      "--revision",
      "250",
      "--as",
      "application/pdf",
      "--out",
      "./r.pdf",
    ]);
    expect(f.revision).toBe("250");
    expect(f.as).toBe("application/pdf");
    expect(f.out).toBe("./r.pdf");
  });

  it("throws VALIDATION_ERROR when documentId is missing", () => {
    try {
      parseFlags(["--revision", "250"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});
