import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  isNative,
  parseFlags,
  sortRevisionsNewestFirst,
} from "./revisions.js";

describe("drive revisions parseFlags", () => {
  it("parses a bare fileId with defaults", () => {
    const f = parseFlags(["1V09rp"]);
    expect(f.fileId).toBe("1V09rp");
    expect(f.full).toBe(false);
    expect(f.limit).toBe(100);
  });

  it("parses --full and --limit", () => {
    const f = parseFlags(["1V09rp", "--full", "--limit", "5"]);
    expect(f.full).toBe(true);
    expect(f.limit).toBe(5);
  });

  it("clamps a non-numeric --limit to the default", () => {
    const f = parseFlags(["1V09rp", "--limit", "abc"]);
    expect(f.limit).toBe(100);
  });

  it("throws VALIDATION_ERROR when fileId is missing", () => {
    try {
      parseFlags(["--full"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("isNative", () => {
  it("classifies Google-native mime types", () => {
    expect(isNative("application/vnd.google-apps.document")).toBe(true);
    expect(isNative("application/vnd.google-apps.spreadsheet")).toBe(true);
  });
  it("classifies uploaded/binary mime types as non-native", () => {
    expect(isNative("application/pdf")).toBe(false);
    expect(isNative("image/png")).toBe(false);
  });
});

describe("sortRevisionsNewestFirst", () => {
  it("orders by modifiedTime descending regardless of input order", () => {
    const sorted = sortRevisionsNewestFirst([
      { id: "1", modifiedTime: "2026-03-18T19:09:26Z" },
      { id: "1179", modifiedTime: "2026-06-10T18:22:20Z" },
      { id: "250", modifiedTime: "2026-04-06T17:15:24Z" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["1179", "250", "1"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { id: "a", modifiedTime: "2026-01-01T00:00:00Z" },
      { id: "b", modifiedTime: "2026-02-01T00:00:00Z" },
    ];
    sortRevisionsNewestFirst(input);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("treats missing timestamps as epoch (sorts last)", () => {
    const sorted = sortRevisionsNewestFirst([
      { id: "none" },
      { id: "dated", modifiedTime: "2026-01-01T00:00:00Z" },
    ]);
    expect(sorted[0].id).toBe("dated");
  });
});
