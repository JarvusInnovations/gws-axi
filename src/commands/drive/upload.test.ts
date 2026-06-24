import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseFlags, validateFlags } from "./upload.js";

describe("drive upload parseFlags", () => {
  it("parses a bare local path with defaults", () => {
    const f = parseFlags(["./report.pdf"]);
    expect(f.localPath).toBe("./report.pdf");
    expect(f.parent).toBeUndefined();
    expect(f.name).toBeUndefined();
    expect(f.mime).toBeUndefined();
    expect(f.convert).toBe(false);
    expect(f.update).toBeUndefined();
  });

  it("parses all flags", () => {
    const f = parseFlags([
      "./report.pdf",
      "--parent",
      "1AbC",
      "--name",
      "Q2 Report.pdf",
      "--mime",
      "application/pdf",
      "--convert",
    ]);
    expect(f.localPath).toBe("./report.pdf");
    expect(f.parent).toBe("1AbC");
    expect(f.name).toBe("Q2 Report.pdf");
    expect(f.mime).toBe("application/pdf");
    expect(f.convert).toBe(true);
  });

  it("parses --update with a file id", () => {
    const f = parseFlags(["./report.pdf", "--update", "1XyZ"]);
    expect(f.update).toBe("1XyZ");
  });

  it("takes the first positional as the local path, ignoring later ones", () => {
    const f = parseFlags(["./a.pdf", "./b.pdf"]);
    expect(f.localPath).toBe("./a.pdf");
  });

  it("parses `-` as stdin (not a local path)", () => {
    const f = parseFlags(["-", "--name", "notes.md"]);
    expect(f.stdin).toBe(true);
    expect(f.localPath).toBeUndefined();
    expect(f.name).toBe("notes.md");
  });

  it("parses --content", () => {
    const f = parseFlags(["--content", "# Hi", "--name", "notes.md"]);
    expect(f.content).toBe("# Hi");
    expect(f.localPath).toBeUndefined();
    expect(f.stdin).toBe(false);
  });
});

describe("drive upload validateFlags", () => {
  const base = {
    localPath: "./report.pdf",
    stdin: false,
    content: undefined,
    parent: undefined,
    name: undefined,
    mime: undefined,
    convert: false,
    update: undefined,
  };

  it("accepts a valid create invocation", () => {
    expect(() => validateFlags({ ...base, parent: "1AbC" })).not.toThrow();
  });

  it("accepts a valid update invocation", () => {
    expect(() => validateFlags({ ...base, update: "1XyZ" })).not.toThrow();
  });

  it("throws VALIDATION_ERROR when no content source is given", () => {
    try {
      validateFlags({ ...base, localPath: undefined });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects more than one content source", () => {
    try {
      validateFlags({ ...base, localPath: "./a.md", content: "# Hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("accepts stdin/--content with a --name", () => {
    expect(() =>
      validateFlags({
        ...base,
        localPath: undefined,
        stdin: true,
        name: "notes.md",
      }),
    ).not.toThrow();
    expect(() =>
      validateFlags({
        ...base,
        localPath: undefined,
        content: "# Hi",
        name: "notes.md",
      }),
    ).not.toThrow();
  });

  it("rejects stdin/--content without a --name", () => {
    for (const src of [
      { stdin: true },
      { content: "# Hi" },
    ] as const) {
      try {
        validateFlags({ ...base, localPath: undefined, ...src });
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as AxiError).code).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("rejects --parent combined with --update", () => {
    try {
      validateFlags({ ...base, parent: "1AbC", update: "1XyZ" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("allows --convert combined with --update (target-type check happens at runtime)", () => {
    expect(() =>
      validateFlags({ ...base, convert: true, update: "1XyZ" }),
    ).not.toThrow();
  });
});
