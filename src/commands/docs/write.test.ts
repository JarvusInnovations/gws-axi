import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { parseWriteFlags } from "./write.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as AxiError).code;
  }
  return "none";
}

describe("docs write flag parsing", () => {
  it("parses a file source with a tab", () => {
    const f = parseWriteFlags(["1Doc", "./notes.md", "--tab", "t.0"], "write");
    expect(f).toMatchObject({
      documentId: "1Doc",
      localPath: "./notes.md",
      tab: "t.0",
      stdin: false,
    });
  });

  it("parses stdin and --content sources", () => {
    expect(parseWriteFlags(["1Doc", "-"], "write").stdin).toBe(true);
    expect(parseWriteFlags(["1Doc", "--content", "# Hi"], "append").content).toBe("# Hi");
  });

  it("requires exactly one source", () => {
    expect(code(() => parseWriteFlags(["1Doc"], "write"))).toBe("VALIDATION_ERROR");
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--content", "x"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("lets create omit the source but not the title", () => {
    expect(parseWriteFlags(["--title", "Notes"], "create").localPath).toBeUndefined();
    expect(code(() => parseWriteFlags(["./a.md"], "create"))).toBe("VALIDATION_ERROR");
    expect(
      parseWriteFlags(["--title", "Notes", "./a.md", "--parent", "1F"], "create"),
    ).toMatchObject({
      title: "Notes",
      localPath: "./a.md",
      parent: "1F",
    });
  });

  it("rejects --tab with --new-tab, and --new-tab on append", () => {
    expect(
      code(() => parseWriteFlags(["1Doc", "./a.md", "--tab", "t.0", "--new-tab", "X"], "write")),
    ).toBe("VALIDATION_ERROR");
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--new-tab", "X"], "append"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("rejects unknown flags and missing values", () => {
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--title", "x"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(code(() => parseWriteFlags(["1Doc", "./a.md", "--tab"], "write"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("requires the documentId outside create", () => {
    expect(code(() => parseWriteFlags(["--content", "x"], "append"))).toBe("VALIDATION_ERROR");
  });
});
